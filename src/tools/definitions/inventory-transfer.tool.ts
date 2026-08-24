/**
 * inventoryTransfer 工具 — 库存调拨（写操作，含预览机制）
 *
 * 用途：将商品从调出门店（仓库）调拨到调入门店（仓库），生成调拨单（草稿）。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/transfer-orders
 * 后端路由：transfer-order.routes.ts（V2 接口，prefix: /api/admin/transfer-orders）
 * 后端服务：transfer-order.service.ts createTransferOrder（事务写入 t_transfer_order + t_transfer_order_item）
 *
 * 后端接收字段（以 transfer-order-v2.controller.ts createTransferOrder 为准）：
 * - fromStoreId: number（必填，调出门店）
 * - fromStoreName: string（可选）
 * - toStoreId: number（必填，调入门店）
 * - toStoreName: string（可选）
 * - expectedDate: string（可选，期望到货日期）
 * - remark: string（可选）
 * - userName: string（可选，创建人姓名）
 * - items: [{ skuId, skuName, quantity, unitPrice }]（必填，商品明细）
 * 返回：{ id, transferNo }，状态 DRAFT（草稿），后续由人工提交审核/确认出库/确认入库
 *
 * 校验规则（与后端 service 一致）：
 * - fromStoreId 与 toStoreId 不能相同（后端抛 400 "调出门店和调入门店不能相同"）
 * - items 不能为空（后端抛 400 "调拨单明细不能为空"）
 *
 * 单价处理：
 * - 用户指定 unitPrice > 0 → 使用用户指定价
 * - 未指定但有 productInfo.costPrice > 0 → 使用成本价（调拨按成本计价）
 * - 都未提供 → 单价 0，预览中标注"未指定单价"警告（不阻止，调拨金额仅作参考）
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/transfer-orders 创建调拨单
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

/** 调拨商品项输入 */
interface TransferItemInput {
  skuId: number;
  skuName?: string;
  /** 调拨数量（件/瓶，由 LLM 根据上下文决定，后端不区分单位） */
  quantity: number;
  /** 用户指定单价（可选） */
  unitPrice?: number;
  /** 商品信息（可选，由前置 searchProduct 工具提供，用于自动取成本价） */
  productInfo?: TransferProductInfo;
}

/** 商品定价信息（来自 searchProduct 工具返回） */
interface TransferProductInfo {
  costPrice: number;
}

/** 后端创建调拨单返回 */
interface CreateTransferResult {
  id: number;
  transferNo: string;
  [key: string]: unknown;
}

/** 处理后的调拨商品项 */
interface ProcessedTransferItem {
  skuId: number;
  skuName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  priceSource: string;
  warning?: string;
}

@Injectable()
export class InventoryTransferTool implements ITool {
  private readonly logger = new Logger(InventoryTransferTool.name);

  readonly name = 'inventoryTransfer';
  readonly description =
    '库存调拨（写操作，需用户确认）：将商品从调出门店调拨到调入门店，生成调拨单。' +
    '必须先调用 searchProduct 获取商品的 skuId，调拨数量由用户指定。' +
    '首次调用 confirm=false 生成预览（含调出/调入仓库、商品明细、数量、单价、合计），' +
    '用户确认后 confirm=true 正式创建调拨单（草稿状态，后续由人工审核和出入库）。' +
    '示例参数：{"fromStoreId":1,"fromStoreName":"1号仓","toStoreId":2,"toStoreName":"2号仓",' +
    '"items":[{"skuId":101,"skuName":"五粮液 500ml","quantity":50,"unitPrice":850}],"confirm":false}';
  readonly category = 'inventory' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['searchProduct'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      fromStoreId: {
        type: 'number',
        description: '调出门店ID（必填）',
      },
      fromStoreName: {
        type: 'string',
        description: '调出门店名称（可选，用于预览展示）',
      },
      toStoreId: {
        type: 'number',
        description: '调入门店ID（必填，不能与调出门店相同）',
      },
      toStoreName: {
        type: 'string',
        description: '调入门店名称（可选，用于预览展示）',
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
        description: '调拨商品明细列表（必填）',
        items: {
          type: 'object',
          properties: {
            skuId: {
              type: 'number',
              description: 'SKU ID（从 searchProduct 获取）',
            },
            skuName: { type: 'string', description: 'SKU名称（用于预览展示）' },
            quantity: { type: 'number', description: '调拨数量（必须大于0）' },
            unitPrice: {
              type: 'number',
              description: '单价（可选，不传则用成本价或0，用于计算调拨金额）',
            },
            productInfo: {
              type: 'object',
              description:
                '商品定价信息（从 searchProduct 获取，用于自动取成本价）',
              properties: {
                costPrice: { type: 'number', description: '成本价/进价' },
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
    required: ['fromStoreId', 'toStoreId', 'items'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

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

    const transferArgs = parsed.data;
    const confirm = transferArgs.confirm === true;

    // ── 2. 处理商品明细（单价填充 + 小计计算） ──
    const processedItems = transferArgs.items.map((item) =>
      this.processItem(item),
    );

    // 计算合计
    const totalAmount = processedItems.reduce(
      (sum, item) => sum + item.subtotal,
      0,
    );

    // 收集警告
    const warnings = processedItems
      .filter((item) => item.warning)
      .map((item) => item.warning) as string[];

    // ── 3. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        fromStoreId: transferArgs.fromStoreId,
        fromStoreName: transferArgs.fromStoreName ?? '未知',
        toStoreId: transferArgs.toStoreId,
        toStoreName: transferArgs.toStoreName ?? '未知',
        expectedDate: transferArgs.expectedDate,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          priceSource: item.priceSource,
          subtotal: item.subtotal,
        })),
        totalItems: processedItems.reduce(
          (sum, item) => sum + item.quantity,
          0,
        ),
        totalAmount,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      this.logger.log(
        `生成调拨单预览：${transferArgs.fromStoreName ?? transferArgs.fromStoreId}` +
          ` → ${transferArgs.toStoreName ?? transferArgs.toStoreId} ` +
          `${processedItems.length} 种商品 合计 ${totalAmount} 元`,
      );

      return {
        success: true,
        preview: {
          operation: '库存调拨',
          summary:
            `从${transferArgs.fromStoreName ?? '门店' + transferArgs.fromStoreId}调拨` +
            `${processedItems.length} 种商品到${transferArgs.toStoreName ?? '门店' + transferArgs.toStoreId}，` +
            `共 ${totalAmount.toFixed(2)} 元` +
            (warnings.length > 0 ? `（含 ${warnings.length} 条警告）` : ''),
          details: previewDetails,
        },
      };
    }

    // ── 4. 执行阶段：调用后端创建调拨单 ──
    try {
      const requestBody = {
        fromStoreId: transferArgs.fromStoreId,
        fromStoreName: transferArgs.fromStoreName,
        toStoreId: transferArgs.toStoreId,
        toStoreName: transferArgs.toStoreName,
        expectedDate: transferArgs.expectedDate,
        remark: transferArgs.remark,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      };

      const result = await this.serviceClient.post<CreateTransferResult>(
        API_ENDPOINTS.TRANSFER_ORDERS,
        requestBody,
        context,
      );

      this.logger.log(
        `调拨单创建成功：transferNo=${result.transferNo} id=${result.id}`,
      );

      return {
        success: true,
        data: {
          id: result.id,
          transferNo: result.transferNo,
          fromStoreName: transferArgs.fromStoreName,
          toStoreName: transferArgs.toStoreName,
          itemCount: processedItems.length,
          totalQuantity: processedItems.reduce(
            (sum, item) => sum + item.quantity,
            0,
          ),
          totalAmount,
          status: 'DRAFT',
          message: `调拨单 ${result.transferNo} 创建成功（草稿状态，需人工提交审核后完成调拨），共 ${processedItems.length} 种商品`,
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

      this.logger.error(`创建调拨单失败：${errorMsg}`);
      return {
        success: false,
        error: `创建调拨单失败：${errorMsg}`,
        suggestion:
          '请确认后端服务是否正常运行，检查门店ID和SKU ID是否正确，调出门店与调入门店不能相同',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: TransferArgs }
    | { valid: false; error: string; suggestion?: string } {
    const fromStoreId = args.fromStoreId;
    if (typeof fromStoreId !== 'number' || fromStoreId <= 0) {
      return {
        valid: false,
        error: '参数 fromStoreId 必须为正整数',
        suggestion: '请确认调出门店的ID',
      };
    }

    const toStoreId = args.toStoreId;
    if (typeof toStoreId !== 'number' || toStoreId <= 0) {
      return {
        valid: false,
        error: '参数 toStoreId 必须为正整数',
        suggestion: '请确认调入门店的ID',
      };
    }

    if (fromStoreId === toStoreId) {
      return {
        valid: false,
        error: '调出门店和调入门店不能相同',
        suggestion: '请检查 fromStoreId 和 toStoreId 是否为两个不同的门店',
      };
    }

    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) {
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请至少传入一个要调拨的商品项',
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
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 quantity 必须大于0`,
          suggestion: '请指定要调拨的数量（必须大于0）',
        };
      }
    }

    return {
      valid: true,
      data: {
        fromStoreId,
        fromStoreName:
          typeof args.fromStoreName === 'string'
            ? args.fromStoreName
            : undefined,
        toStoreId,
        toStoreName:
          typeof args.toStoreName === 'string' ? args.toStoreName : undefined,
        expectedDate:
          typeof args.expectedDate === 'string' ? args.expectedDate : undefined,
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        items: items as TransferItemInput[],
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }

  /**
   * 处理单个调拨商品项：单价填充 + 小计计算
   *
   * 单价优先级：用户指定价 > 成本价 > 0（标注警告）
   */
  private processItem(item: TransferItemInput): ProcessedTransferItem {
    const skuName = item.skuName ?? `SKU-${item.skuId}`;

    let unitPrice: number;
    let priceSource: string;
    let warning: string | undefined;

    if (typeof item.unitPrice === 'number' && item.unitPrice > 0) {
      unitPrice = item.unitPrice;
      priceSource = '用户指定价';
    } else if (
      item.productInfo &&
      typeof item.productInfo.costPrice === 'number' &&
      item.productInfo.costPrice > 0
    ) {
      unitPrice = item.productInfo.costPrice;
      priceSource = '已自动应用成本价';
    } else {
      unitPrice = 0;
      priceSource = '未指定单价';
      warning = `警告：商品 ${skuName} 未指定单价，调拨金额按 0 计算（仅作参考，不影响库存调拨）`;
    }

    const subtotal = Math.round(unitPrice * item.quantity * 100) / 100;

    return {
      skuId: item.skuId,
      skuName,
      quantity: item.quantity,
      unitPrice,
      subtotal,
      priceSource,
      warning,
    };
  }
}

/** 调拨参数（解析后） */
interface TransferArgs {
  fromStoreId: number;
  fromStoreName?: string;
  toStoreId: number;
  toStoreName?: string;
  expectedDate?: string;
  remark?: string;
  items: TransferItemInput[];
  confirm: boolean;
}
