/**
 * createSalesOrder 工具 — 创建销售单（写操作，含智能价格填充+预览机制）
 *
 * 用途：为指定客户创建销售单，支持智能价格填充和单位换算。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/store/sale-bills
 * 后端路由：store-sale-bill.routes.ts（prefix: /api/store）
 *
 * 智能价格填充规则（写入操作规范第三章）：
 * 1. 客户类型 → 价格等级匹配：
 *    - WHOLESALE（批发客户）→ wholesalePrice（批发价）
 *    - CASH（散客/零售）→ retailPrice（零售价）
 *    - VIP（VIP客户）→ retailPrice * 0.9（VIP折扣，暂用零售价标记，后续可扩展）
 * 2. 用户指定价 > 客户类型对应价（优先级）
 * 3. 单位换算：用户说"箱"→ 按 boxRatio 换算为瓶，单价始终是瓶单价
 * 4. 价格安全校验：低于进价时生成警告（不拦截），零价格阻止执行
 *
 * 确认机制（R70-15 完整实现，当前简化版）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/store/sale-bills 创建销售单
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
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
import { toPositiveInt } from '../../nlp/param-coercer';

/** 创建销售单的参数 */
interface CreateSalesOrderArgs {
  /** 客户ID（可选；不传时按 customerName 自动查找，找不到自动创建） */
  customerId?: number;
  customerName?: string;
  customerType?: string;
  items: OrderItemInput[];
  saleType?: 'CASH' | 'CREDIT';
  remark?: string;
  confirm?: boolean;
}

/** 客户解析结果 */
interface ResolvedCustomer {
  customerId: number;
  customerName: string;
  customerType: string;
  /** 本次是否自动创建了客户 */
  created: boolean;
}

/** 后端客户列表项（searchCustomer 同源） */
interface CustomerListItem {
  memberId: number;
  name: string;
  customerType: string;
}

/** 订单商品项输入 */
interface OrderItemInput {
  skuId: number;
  skuName?: string;
  /** 箱数（可选，与瓶数二选一或组合） */
  boxQty?: number;
  /** 瓶数（可选） */
  bottleQty?: number;
  /** 用户指定的单价（可选，不传则自动匹配） */
  unitPrice?: number;
  /** 商品信息（由前置 searchProduct 工具提供） */
  productInfo?: ProductInfoForPricing;
}

/** 商品定价信息（来自 searchProduct 工具返回，R70-14 统一使用引擎类型） */
type ProductInfoForPricing = ProductPriceInfo;

/** 后端创建销售单返回 */
interface CreateSaleBillResult {
  billNo: string;
  totalAmount: number;
  [key: string]: unknown;
}

@Injectable()
export class CreateSalesOrderTool implements ITool {
  private readonly logger = new Logger(CreateSalesOrderTool.name);

  readonly name = 'createSalesOrder';
  readonly description =
    '创建销售单（写操作，需用户确认）。' +
    '支持智能价格填充：根据客户类型自动匹配价格（批发客户→批发价，散客→零售价），' +
    '支持单位换算（箱→瓶，按boxRatio换算）。' +
    '推荐直接传入 customerName（客户名称）即可：工具会自动查找客户，客户不存在时自动创建（预览中会提示）。' +
    '也可先调用 searchProduct 获取 skuId 和价格信息。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。' +
    '示例参数：{"customerName":"红星商行","items":[{"skuId":10,"boxQty":5,"productInfo":{"boxRatio":6,"retailPrice":1200,"wholesalePrice":980,"storePrice":1100,"costPrice":850}}],"confirm":false}';
  readonly category = 'order' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = [
    'searchCustomer',
    'searchProduct',
    'checkInventory',
  ];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: {
        type: 'number',
        description: '客户ID（可选；不传时按 customerName 自动查找/创建）',
      },
      customerName: {
        type: 'string',
        description:
          '客户名称（推荐传入；客户不存在时工具将自动创建，并在预览中提示）',
      },
      customerType: {
        type: 'string',
        enum: ['CASH', 'WHOLESALE', 'VIP'],
        description:
          '客户类型（从 searchCustomer 获取：CASH=散客/WHOLESALE=批发/VIP=VIP客户）',
      },
      items: {
        type: 'array',
        description: '商品明细列表',
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
              description: '用户指定单价（可选，不传则自动匹配）',
            },
            productInfo: {
              type: 'object',
              description:
                '商品定价信息（从 searchProduct 获取，用于自动匹配价格）',
              properties: {
                boxRatio: { type: 'number', description: '箱瓶比（1箱=N瓶）' },
                retailPrice: { type: 'number', description: '零售价' },
                wholesalePrice: { type: 'number', description: '批发价' },
                storePrice: { type: 'number', description: '门店价' },
                costPrice: { type: 'number', description: '进价' },
              },
            },
          },
        },
      },
      saleType: {
        type: 'string',
        enum: ['CASH', 'CREDIT'],
        description: '销售类型（CASH=现结/CREDIT=赊销，默认CASH）',
      },
      remark: {
        type: 'string',
        description: '备注（可选）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['items'],
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

    const orderArgs = parsed.data;
    const confirm = orderArgs.confirm === true;

    // ── 2. 客户解析（按 customerName 查找；找不到时预览阶段仅提示，执行阶段自动创建） ──
    let resolved: ResolvedCustomer | undefined;
    try {
      resolved = await this.resolveCustomer(orderArgs, context, confirm);
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        success: false,
        error: `解析客户失败：${errorMsg}`,
        suggestion: '请确认客户名称是否正确，或直接传入 customerId',
      };
    }

    const effectiveType =
      resolved?.customerType ?? orderArgs.customerType ?? 'CASH';

    // ── 2. 商品价格兜底解析 + 智能价格填充 + 单位换算 ──
    // LLM 可能未传 productInfo（导致箱瓶比/价格缺失），按 skuId 回查后端权威价格，
    // 保证箱→瓶换算和自动匹配价格不依赖 LLM 传参。
    await this.resolveMissingProductInfo(orderArgs.items, context);

    const processedItems = orderArgs.items.map((item) =>
      this.processItem(item, effectiveType),
    );

    // 检查是否有阻止性错误（零价格）
    const blockingItem = processedItems.find((item) => item.blocked);
    if (blockingItem) {
      return {
        success: false,
        error: blockingItem.error,
        suggestion:
          '请通过 searchProduct 获取商品价格信息，或在 items 中指定 unitPrice',
      };
    }

    // 计算合计
    const totalAmount = processedItems.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );

    // 收集警告
    const warnings = processedItems
      .filter((item) => item.warning)
      .map((item) => item.warning) as string[];

    // ── 3. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        customerId: resolved?.customerId ?? null,
        customerName:
          resolved?.customerName ?? orderArgs.customerName ?? '未知',
        customerType: effectiveType,
        willCreateCustomer:
          resolved && resolved.customerId === 0 ? true : undefined,
        saleType: orderArgs.saleType ?? 'CASH',
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          totalBottleQty: item.totalBottleQty,
          unitPrice: item.unitPrice,
          priceSource: item.priceSource,
          totalPrice: item.totalPrice,
        })),
        totalAmount,
        warnings: warnings.length > 0 ? warnings : undefined,
      };

      this.logger.log(
        `生成销售单预览：customer=${orderArgs.customerName ?? orderArgs.customerId} ` +
          `${processedItems.length} 种商品 合计 ${totalAmount} 元`,
      );

      return {
        success: true,
        preview: {
          operation: '创建销售单',
          summary:
            `${resolved?.customerName ?? orderArgs.customerName ?? '客户'} ` +
            `${processedItems.length} 种商品，合计 ${totalAmount.toFixed(2)} 元` +
            (resolved && resolved.customerId === 0
              ? `（将自动创建客户「${orderArgs.customerName}」）`
              : '') +
            (warnings.length > 0 ? `（含 ${warnings.length} 条警告）` : ''),
          details: previewDetails,
        },
      };
    }

    // ── 4. 执行阶段：调用后端创建销售单 ──
    try {
      const requestBody = {
        customerId: resolved!.customerId,
        customerName: resolved!.customerName,
        saleType: orderArgs.saleType ?? 'CASH',
        remark: orderArgs.remark,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          totalBottleQty: item.totalBottleQty,
          unitPrice: item.unitPrice,
          priceType: this.mapPriceType(effectiveType),
        })),
      };

      const result = await this.serviceClient.post<CreateSaleBillResult>(
        API_ENDPOINTS.STORE_SALE_BILLS,
        requestBody,
        context,
      );

      this.logger.log(
        `销售单创建成功：billNo=${result.billNo} totalAmount=${result.totalAmount ?? totalAmount}`,
      );

      return {
        success: true,
        data: {
          billNo: result.billNo,
          totalAmount: result.totalAmount ?? totalAmount,
          customerId: resolved!.customerId,
          customerName: resolved!.customerName,
          createdCustomer: resolved!.created,
          itemCount: processedItems.length,
          items: processedItems.map((item) => ({
            skuName: item.skuName,
            boxQty: item.boxQty,
            bottleQty: item.bottleQty,
            unitPrice: item.unitPrice,
            totalPrice: item.totalPrice,
          })),
          message: `销售单 ${result.billNo} 创建成功，合计 ${(result.totalAmount ?? totalAmount).toFixed(2)} 元`,
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

      this.logger.error(`创建销售单失败：${errorMsg}`);
      return {
        success: false,
        error: `创建销售单失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，检查客户ID和SKU ID是否正确',
      };
    }
  }

  // ── 私有方法 ──

  /**
   * 为缺失 productInfo 的商品项回查后端商品列表，按 skuId 匹配权威价格与箱瓶比。
   * 后端列表接口将首个 SKU 字段拍平到记录顶层（skuId/boxRatio/价格等）。
   */
  private async resolveMissingProductInfo(
    items: OrderItemInput[],
    context: ToolContext,
  ): Promise<void> {
    const missing = items.filter((item) => !item.productInfo);
    if (missing.length === 0) return;

    const result = await this.serviceClient.get<{
      records?: Array<Record<string, unknown>>;
      list?: Array<Record<string, unknown>>;
    }>(`${API_ENDPOINTS.PRODUCTS}?page=1&pageSize=200`, context);
    const records = result?.records ?? result?.list ?? [];

    const bySkuId = new Map<number, ProductPriceInfo>();
    for (const r of records) {
      const skuId = Number(r.skuId);
      if (Number.isFinite(skuId) && skuId > 0) {
        bySkuId.set(skuId, {
          boxRatio: Number(r.boxRatio) || 1,
          retailPrice: Number(r.retailPrice),
          wholesalePrice: Number(r.wholesalePrice),
          storePrice: Number(r.storePrice),
          costPrice: Number(r.costPrice),
        });
      }
    }

    for (const item of missing) {
      const info = bySkuId.get(item.skuId);
      if (info) {
        item.productInfo = info;
      }
    }
  }

  /**
   * 解析客户：customerId 优先；否则按 customerName 搜索；
   * 未找到时执行阶段自动创建（预览阶段仅标记 willCreate）。
   */
  private async resolveCustomer(
    args: CreateSalesOrderArgs,
    context: ToolContext,
    isExecute: boolean,
  ): Promise<ResolvedCustomer | undefined> {
    if (args.customerId !== undefined) {
      return {
        customerId: args.customerId,
        customerName: args.customerName ?? `客户${args.customerId}`,
        customerType: args.customerType ?? 'CASH',
        created: false,
      };
    }

    const name = args.customerName?.trim();
    if (!name) {
      return undefined;
    }

    // 1. 搜索已有客户
    const result = await this.serviceClient.get<{
      records?: CustomerListItem[];
      list?: CustomerListItem[];
    }>(
      `${API_ENDPOINTS.CUSTOMERS}?keyword=${encodeURIComponent(name)}&page=1&pageSize=10`,
      context,
    );
    const customers = result?.records ?? result?.list ?? [];
    const exact = customers.find((c) => c.name === name);
    const fuzzy = exact ?? customers.find((c) => c.name.includes(name));
    if (fuzzy) {
      return {
        customerId: fuzzy.memberId,
        customerName: fuzzy.name,
        customerType: this.mapBackendCustomerType(fuzzy.customerType),
        created: false,
      };
    }

    // 2. 未找到：执行阶段自动创建（预览阶段返回 willCreate 标记）
    if (!isExecute) {
      return {
        customerId: 0,
        customerName: name,
        customerType: this.inferCustomerType(name),
        created: false,
      };
    }

    const inferredType = this.inferCustomerType(name);
    const created = await this.serviceClient.post<{ memberId: number }>(
      API_ENDPOINTS.CUSTOMERS,
      {
        name,
        mobile: `139${String(Math.floor(10000000 + Math.random() * 89999999))}`,
        customerType: inferredType,
        settlementType: inferredType === 'WHOLESALE' ? 'ACCOUNT' : 'CASH',
      },
      context,
    );

    this.logger.log(
      `客户不存在，已自动创建：memberId=${created.memberId} name=${name}`,
    );

    return {
      customerId: created.memberId,
      customerName: name,
      customerType: inferredType,
      created: true,
    };
  }

  /** 后端客户类型（RETAIL/WHOLESALE）→ 价格引擎类型（CASH/WHOLESALE/VIP） */
  private mapBackendCustomerType(type: string): string {
    switch (type) {
      case 'WHOLESALE':
        return 'WHOLESALE';
      case 'VIP':
        return 'VIP';
      case 'RETAIL':
      default:
        return 'CASH';
    }
  }

  /** 按名称推断客户类型：含批发/商行/贸易/经销/商贸 → WHOLESALE，否则 CASH */
  private inferCustomerType(name: string): string {
    return /批发|商行|贸易|经销|商贸/.test(name) ? 'WHOLESALE' : 'CASH';
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateSalesOrderArgs }
    | { valid: false; error: string; suggestion?: string } {
    const customerId =
      typeof args.customerId === 'number' && args.customerId > 0
        ? args.customerId
        : undefined;
    const customerName =
      typeof args.customerName === 'string' && args.customerName.trim()
        ? args.customerName.trim()
        : undefined;

    if (customerId === undefined && !customerName) {
      return {
        valid: false,
        error: '必须提供 customerId 或 customerName（推荐 customerName）',
        suggestion: '请传入客户名称，工具会自动查找或创建客户',
      };
    }

    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) {
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请至少传入一个商品项',
      };
    }

    // 校验每个 item
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      // 宽松解析：LLM 可能传字符串数字，自纠错后校验
      const skuId = toPositiveInt(item.skuId);
      if (skuId === undefined) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 skuId 必须为正整数`,
          suggestion: '请先调用 searchProduct 获取商品的 skuId',
        };
      }
      item.skuId = skuId;
      const boxQty = toPositiveInt(item.boxQty);
      const bottleQty = toPositiveInt(item.bottleQty);
      if (boxQty === undefined && bottleQty === undefined) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品必须指定 boxQty 或 bottleQty（至少一个大于0）`,
          suggestion: '请传入箱数(boxQty)或瓶数(bottleQty)',
        };
      }
      if (boxQty !== undefined) item.boxQty = boxQty;
      if (bottleQty !== undefined) item.bottleQty = bottleQty;
    }

    return {
      valid: true,
      data: {
        customerId,
        customerName,
        customerType:
          typeof args.customerType === 'string' ? args.customerType : undefined,
        items: items as OrderItemInput[],
        saleType: args.saleType === 'CREDIT' ? 'CREDIT' : 'CASH',
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }

  /**
   * 处理单个商品项：智能价格填充 + 单位换算（R70-14 复用 PriceEngineService + UnitConverterService）
   */
  private processItem(
    item: OrderItemInput,
    customerType: string,
  ): ProcessedItem {
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
        boxQty,
        bottleQty,
        totalBottleQty: 0,
        unitPrice: 0,
        totalPrice: 0,
        priceSource: '未知',
        blocked: true,
        error: `商品 ${item.skuName ?? item.skuId} ${conversion.error}`,
      };
    }

    const totalBottleQty = conversion.totalBottleQty;

    // ── 智能价格填充（PriceEngineService：用户指定价 > 合同价 > 客户类型对应价） ──
    const resolution = this.priceEngine.resolveSalesPrice({
      userUnitPrice: item.unitPrice,
      customerType,
      productInfo,
      skuName: item.skuName ?? `SKU-${item.skuId}`,
      totalQty: totalBottleQty,
    });

    if (resolution.blocked) {
      return {
        skuId: item.skuId,
        skuName: item.skuName ?? `SKU-${item.skuId}`,
        boxQty,
        bottleQty,
        totalBottleQty,
        unitPrice: 0,
        totalPrice: 0,
        priceSource: resolution.priceSource,
        blocked: true,
        error: resolution.error,
      };
    }

    const unitPrice = resolution.unitPrice;
    const totalPrice = unitPrice * totalBottleQty;

    return {
      skuId: item.skuId,
      skuName: item.skuName ?? `SKU-${item.skuId}`,
      boxQty,
      bottleQty,
      totalBottleQty,
      unitPrice,
      totalPrice,
      priceSource: resolution.priceSource,
      warning: resolution.warning,
      blocked: false,
    };
  }

  /** 将客户类型映射为后端的 priceType 枚举 */
  private mapPriceType(customerType: string): 'RETAIL' | 'WHOLESALE' | 'STORE' {
    switch (customerType) {
      case 'WHOLESALE':
        return 'WHOLESALE';
      case 'VIP':
        return 'RETAIL'; // VIP 用零售价折扣，priceType 标记为 RETAIL
      case 'CASH':
      default:
        return 'RETAIL';
    }
  }
}

/** 处理后的商品项 */
interface ProcessedItem {
  skuId: number;
  skuName: string;
  boxQty: number;
  bottleQty: number;
  totalBottleQty: number;
  unitPrice: number;
  totalPrice: number;
  priceSource: string;
  warning?: string;
  blocked: boolean;
  error?: string;
}
