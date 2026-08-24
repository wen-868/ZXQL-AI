/**
 * createPurchaseOrder 工具 — 创建采购单（写操作，含智能价格填充+预览机制）
 *
 * 用途：向指定供应商采购商品，支持单位换算（箱→瓶）和智能进价填充。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/purchase-orders
 * 后端路由：purchase.routes.ts（prefix: /api/admin/purchase-orders，createPurchaseOrder）
 * 后端服务：purchase-order.service.ts createPurchaseOrder（事务写入 t_purchase_order + t_purchase_order_item）
 *
 * 后端接收字段（以 purchase-admin.controller.ts createPurchaseOrderSchema 为准）：
 * - supplierId: number（必填，供应商ID）
 * - storeId: number（必填，入库门店ID）
 * - expectedDate?: string（可选，期望到货日期 YYYY-MM-DD）
 * - remark?: string（可选）
 * - items: [{ skuId, skuName, barcode?, boxQty, bottleQty, totalBottleQty, unitPrice, taxRate?, remark? }]（必填）
 * 返回：{ orderId, orderNo }，状态 DRAFT（草稿），后续由人工提交审核/入库
 *
 * 供应商获取方式（二选一，支持一种即可）：
 * 1. 直接提供 supplierId（推荐，从 searchSupplier 或供应商列表获取）
 * 2. 仅提供 supplierName → 本工具自动调用 GET /api/admin/suppliers?keyword= 搜索匹配的供应商
 *
 * 智能进价填充规则（写入操作规范第三章，与 createSalesOrder 同族）：
 * 1. 用户指定 unitPrice > productInfo.costPrice（系统默认进价）
 * 2. 单位换算：箱(boxQty) × boxRatio + 瓶(bottleQty) = totalBottleQty（单价始终是瓶单价）
 * 3. 价格安全校验：unitPrice 为 0 时阻止执行；低于系统进价不拦截（采购价低于系统价属正常议价，仅提示）
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/purchase-orders 创建采购单
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';
import { PriceEngineService, ProductPriceInfo } from '../price-engine.service';
import { UnitConverterService } from '../unit-converter.service';

/** 采购商品项输入 */
interface PurchaseItemInput {
  skuId: number;
  skuName?: string;
  /** 条码（可选，透传后端） */
  barcode?: string;
  /** 箱数（可选，与瓶数二选一或组合） */
  boxQty?: number;
  /** 瓶数（可选） */
  bottleQty?: number;
  /** 用户指定单价（可选，不传则用系统进价） */
  unitPrice?: number;
  /** 商品信息（由前置 searchProduct 工具提供，用于单位换算和默认进价） */
  productInfo?: PurchaseProductInfo;
}

/** 商品定价信息（来自 searchProduct 工具返回，R70-14 统一使用引擎类型） */
type PurchaseProductInfo = ProductPriceInfo;

/** 后端创建采购单返回 */
interface CreatePurchaseResult {
  orderId: number;
  orderNo: string;
  [key: string]: unknown;
}

/** 后端供应商列表项（用于按名称搜索供应商） */
interface SupplierListItem {
  id: number;
  name: string;
  shortName?: string | null;
  supplyType?: string | null;
  contactPerson?: string | null;
  contactMobile?: string | null;
}

/** 后端供应商分页结构（getPageList 返回 records 字段） */
interface SupplierPageResult {
  records: SupplierListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** 处理后的采购商品项 */
interface ProcessedPurchaseItem {
  skuId: number;
  skuName: string;
  barcode: string | null;
  boxQty: number;
  bottleQty: number;
  totalBottleQty: number;
  unitPrice: number;
  taxRate: number;
  subtotal: number;
  priceSource: string;
  warning?: string;
  blocked?: boolean;
  error?: string;
}

@Injectable()
export class CreatePurchaseOrderTool implements ITool {
  private readonly logger = new Logger(CreatePurchaseOrderTool.name);

  readonly name = 'createPurchaseOrder';
  readonly description =
    '创建采购单（写操作，需用户确认）：向指定供应商采购商品，支持单位换算（箱→瓶）和智能进价填充。' +
    '必须先调用 searchProduct 获取商品的 skuId 和进价信息；供应商可提供 supplierId（推荐），' +
    '或仅提供 supplierName（本工具会自动搜索匹配的供应商）。' +
    '首次调用 confirm=false 生成预览（含供应商、入库门店、商品明细、数量、单价、合计），' +
    '用户确认后 confirm=true 正式创建采购单（草稿状态，后续由人工提交审核和入库）。' +
    '示例参数：{"supplierName":"红星酒业","storeId":1,"items":[{"skuId":10,"skuName":"五粮液 500ml","boxQty":100,"unitPrice":850,"productInfo":{"boxRatio":6,"costPrice":830}}],"confirm":false}';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['searchProduct'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: {
        type: 'number',
        description:
          '供应商ID（可选，与 supplierName 二选一；推荐从供应商列表获取）',
      },
      supplierName: {
        type: 'string',
        description:
          '供应商名称（可选，与 supplierId 二选一；提供时自动搜索匹配）',
      },
      storeId: {
        type: 'number',
        description: '入库门店ID（必填，正整数）',
      },
      expectedDate: {
        type: 'string',
        description: '期望到货日期（可选，格式 YYYY-MM-DD）',
      },
      remark: {
        type: 'string',
        description: '备注（可选）',
      },
      items: {
        type: 'array',
        description: '采购商品明细列表（必填）',
        items: {
          type: 'object',
          properties: {
            skuId: {
              type: 'number',
              description: 'SKU ID（从 searchProduct 获取）',
            },
            skuName: { type: 'string', description: 'SKU名称（用于预览展示）' },
            boxQty: {
              type: 'number',
              description: '箱数（可选，与 bottleQty 组合使用）',
            },
            bottleQty: {
              type: 'number',
              description: '瓶数（可选，与 boxQty 组合使用）',
            },
            unitPrice: {
              type: 'number',
              description: '单价（可选，不传则用系统默认进价）',
            },
            productInfo: {
              type: 'object',
              description:
                '商品定价信息（从 searchProduct 获取，用于单位换算和默认进价）',
              properties: {
                boxRatio: { type: 'number', description: '箱瓶比（1箱=N瓶）' },
                costPrice: { type: 'number', description: '系统默认进价' },
              },
            },
          },
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['storeId', 'items'],
  };

  constructor(
    private readonly serviceClient: ServiceClient,
    private readonly priceEngine: PriceEngineService,
    private readonly unitConverter: UnitConverterService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }

    const purchaseArgs = parsed.data;
    const confirm = purchaseArgs.confirm === true;

    // ── 2. 解析供应商（supplierId 或 supplierName 搜索） ──
    let supplierId = purchaseArgs.supplierId;
    let supplierName = purchaseArgs.supplierName;

    if (supplierId === undefined && supplierName) {
      const resolved = await this.resolveSupplierByName(supplierName, context);
      if (!resolved.success) {
        return {
          success: false,
          error: resolved.error,
          suggestion: resolved.suggestion,
        };
      }
      supplierId = resolved.id;
      supplierName = resolved.name;
    }

    if (supplierId === undefined) {
      return {
        success: false,
        error: '参数 supplierId 或 supplierName 至少提供一个',
        suggestion: '请提供供应商ID（supplierId）或供应商名称（supplierName）',
      };
    }

    // ── 3. 处理商品明细（单位换算 + 智能进价填充 + 小计） ──
    const processedItems = purchaseArgs.items.map((item) =>
      this.processItem(item),
    );

    // 检查是否有阻止性错误（零价格）
    const blockingItem = processedItems.find((item) => item.blocked);
    if (blockingItem) {
      return {
        success: false,
        error: blockingItem.error,
        suggestion:
          '请通过 searchProduct 获取商品进价信息，或在 items 中指定 unitPrice',
      };
    }

    // 计算合计（含税）
    const goodsAmount = processedItems.reduce(
      (sum, item) => sum + item.subtotal,
      0,
    );
    const taxAmount = processedItems.reduce(
      (sum, item) => sum + item.subtotal * item.taxRate,
      0,
    );
    const payableAmount = goodsAmount + taxAmount;

    // 收集警告
    const warnings = processedItems
      .filter((item) => item.warning)
      .map((item) => item.warning) as string[];

    // ── 4. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        supplierId,
        supplierName: supplierName ?? '未知',
        storeId: purchaseArgs.storeId,
        expectedDate: purchaseArgs.expectedDate,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          totalBottleQty: item.totalBottleQty,
          unitPrice: item.unitPrice,
          priceSource: item.priceSource,
          subtotal: item.subtotal,
        })),
        goodsAmount,
        taxAmount,
        payableAmount,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      this.logger.log(
        `生成采购单预览：supplier=${supplierName ?? supplierId} ` +
          `${processedItems.length} 种商品 合计 ${payableAmount.toFixed(2)} 元`,
      );

      return {
        success: true,
        preview: {
          operation: '创建采购单',
          summary:
            `向${supplierName ?? '供应商' + supplierId}采购 ` +
            `${processedItems.length} 种商品，合计 ${payableAmount.toFixed(2)} 元` +
            (warnings.length > 0 ? `（含 ${warnings.length} 条警告）` : ''),
          details: previewDetails,
        },
      };
    }

    // ── 5. 执行阶段：调用后端创建采购单 ──
    try {
      const requestBody = {
        supplierId,
        storeId: purchaseArgs.storeId,
        expectedDate: purchaseArgs.expectedDate,
        remark: purchaseArgs.remark,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          barcode: item.barcode ?? undefined,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          totalBottleQty: item.totalBottleQty,
          unitPrice: item.unitPrice,
          taxRate: item.taxRate,
        })),
      };

      const result = await this.serviceClient.post<CreatePurchaseResult>(
        API_ENDPOINTS.PURCHASE_ORDERS,
        requestBody,
        context,
      );

      this.logger.log(
        `采购单创建成功：orderNo=${result.orderNo} orderId=${result.orderId}`,
      );

      return {
        success: true,
        data: {
          orderId: result.orderId,
          orderNo: result.orderNo,
          supplierName: supplierName,
          itemCount: processedItems.length,
          goodsAmount,
          taxAmount,
          payableAmount,
          message: `采购单 ${result.orderNo} 创建成功（草稿状态），应付 ${payableAmount.toFixed(2)} 元`,
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建采购单失败：${errorMsg}`);
      return {
        success: false,
        error: `创建采购单失败：${errorMsg}`,
        suggestion:
          '请确认后端服务是否正常运行，检查供应商ID和入库门店ID是否正确',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreatePurchaseArgs }
    | { valid: false; error: string; suggestion?: string } {
    let supplierId: number | undefined;
    if (args.supplierId !== undefined) {
      if (typeof args.supplierId !== 'number' || args.supplierId <= 0) {
        return {
          valid: false,
          error: '参数 supplierId 必须为正整数',
          suggestion: '请确认供应商ID',
        };
      }
      supplierId = args.supplierId;
    }

    let supplierName: string | undefined;
    if (args.supplierName !== undefined) {
      if (
        typeof args.supplierName !== 'string' ||
        args.supplierName.trim().length === 0
      ) {
        return {
          valid: false,
          error: '参数 supplierName 必须为非空字符串',
          suggestion: '请提供供应商名称',
        };
      }
      supplierName = args.supplierName.trim();
    }

    if (supplierId === undefined && supplierName === undefined) {
      return {
        valid: false,
        error: '参数 supplierId 或 supplierName 至少提供一个',
        suggestion: '请提供供应商ID或供应商名称',
      };
    }

    const storeId = args.storeId;
    if (typeof storeId !== 'number' || storeId <= 0) {
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请确认入库门店ID',
      };
    }

    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) {
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请至少传入一个采购商品项',
      };
    }

    // 校验每个 item
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      if (typeof item.skuId !== 'number' || item.skuId <= 0) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 skuId 必须为正整数`,
          suggestion: '请先调用 searchProduct 获取商品的 skuId',
        };
      }
      if (
        (typeof item.boxQty !== 'number' || item.boxQty <= 0) &&
        (typeof item.bottleQty !== 'number' || item.bottleQty <= 0)
      ) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品必须指定 boxQty 或 bottleQty（至少一个大于0）`,
          suggestion: '请传入箱数(boxQty)或瓶数(bottleQty)',
        };
      }
    }

    return {
      valid: true,
      data: {
        supplierId,
        supplierName,
        storeId,
        expectedDate:
          typeof args.expectedDate === 'string' ? args.expectedDate : undefined,
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        items: items as PurchaseItemInput[],
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }

  /** 按供应商名称搜索供应商（调用 GET /api/admin/suppliers?keyword=） */
  private async resolveSupplierByName(
    name: string,
    context: ToolContext,
  ): Promise<
    | { success: true; id: number; name: string }
    | { success: false; error: string; suggestion: string }
  > {
    try {
      const result = await this.serviceClient.get<SupplierPageResult>(
        `${API_ENDPOINTS.SUPPLIERS}?keyword=${encodeURIComponent(name)}&page=1&pageSize=10`,
        context,
      );

      const suppliers = result?.records ?? [];
      if (suppliers.length === 0) {
        return {
          success: false,
          error: `未找到匹配"${name}"的供应商`,
          suggestion:
            '请提供正确的供应商名称，或直接传入供应商ID（supplierId）',
        };
      }

      // 取第一条最匹配的供应商
      const matched = suppliers[0];
      this.logger.debug(
        `按名称"${name}"解析供应商：id=${matched.id} name=${matched.name}`,
      );
      return { success: true, id: matched.id, name: matched.name };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        success: false,
        error: `搜索供应商失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或直接传入供应商ID',
      };
    }
  }

  /** 处理单个商品项：单位换算 + 智能进价填充 + 小计（R70-14 复用引擎） */
  private processItem(item: PurchaseItemInput): ProcessedPurchaseItem {
    const productInfo = item.productInfo;
    const boxRatio = productInfo?.boxRatio ?? 1;

    // ── 单位换算：箱+瓶 → 总瓶数（UnitConverterService） ──
    const boxQty = item.boxQty ?? 0;
    const bottleQty = item.bottleQty ?? 0;
    const conversion = this.unitConverter.toBottleQty({
      boxQty,
      bottleQty,
      boxRatio,
    });

    if (!conversion.valid) {
      return {
        skuId: item.skuId,
        skuName: item.skuName ?? `SKU-${item.skuId}`,
        barcode: null,
        boxQty,
        bottleQty,
        totalBottleQty: 0,
        unitPrice: 0,
        taxRate: 0,
        subtotal: 0,
        priceSource: '未知',
        blocked: true,
        error: `商品 ${item.skuName ?? item.skuId} ${conversion.error}`,
      };
    }

    const totalBottleQty = conversion.totalBottleQty;

    // ── 智能进价填充（PriceEngineService：用户指定价 > 系统默认进价） ──
    const resolution = this.priceEngine.resolvePurchasePrice({
      userUnitPrice: item.unitPrice,
      productInfo,
      skuName: item.skuName ?? `SKU-${item.skuId}`,
    });

    if (resolution.blocked) {
      return {
        skuId: item.skuId,
        skuName: item.skuName ?? `SKU-${item.skuId}`,
        barcode: null,
        boxQty,
        bottleQty,
        totalBottleQty,
        unitPrice: 0,
        taxRate: 0,
        subtotal: 0,
        priceSource: resolution.priceSource,
        blocked: true,
        error: resolution.error,
      };
    }

    const unitPrice = resolution.unitPrice;
    const subtotal = unitPrice * totalBottleQty;

    return {
      skuId: item.skuId,
      skuName: item.skuName ?? `SKU-${item.skuId}`,
      barcode: item.barcode ?? null,
      boxQty,
      bottleQty,
      totalBottleQty,
      unitPrice,
      taxRate: 0,
      subtotal,
      priceSource: resolution.priceSource,
      warning: resolution.warning,
      blocked: false,
    };
  }
}

/** 创建采购单参数（解析后） */
interface CreatePurchaseArgs {
  supplierId?: number;
  supplierName?: string;
  storeId: number;
  expectedDate?: string;
  remark?: string;
  items: PurchaseItemInput[];
  confirm: boolean;
}
