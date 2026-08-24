/**
 * updateProductPrice 工具 — 修改商品价格（写操作，含预览机制）
 *
 * 用途：调整指定 SKU 的价格等级（零售价/批发价/门店价/进价/小程序价）。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：PUT /api/admin/products/:skuId/price
 * 后端路由：admin-product.routes.ts（prefix: /api/admin，updateProductPrice）
 * 后端服务：product.service.ts updateProductPrice（事务写入 t_product_price + t_product_price_log）
 *
 * 后端接收字段（以 admin-product.routes.ts 的 updateProductPrice controller 为准）：
 * body 为价格字段平铺对象，可含以下任一：
 * - costPrice?: number      进价（成本价）
 * - retailPrice?: number    零售价
 * - wholesalePrice?: number 批发价
 * - miniappPrice?: number   小程序价
 * - storePrice?: number     门店价
 * 返回：{ skuId, changes: [...] }（实际变更的价格项）
 *
 * 本工具将 LLM 友好的参数（priceType + newPrice）转换为后端 body 结构：
 *   { priceType: newPrice }（如 { wholesalePrice: 1000 }）
 *
 * 价格类型与后端字段映射：
 * - retailPrice → 零售价
 * - wholesalePrice → 批发价
 * - storePrice → 门店价
 * - costPrice → 进价（成本价）
 * - miniappPrice → 小程序价
 *
 * 校验规则：
 * - skuId 必须为正整数
 * - priceType 必须是合法价格类型
 * - newPrice 必须大于 0（不拦截，只校验合法性；后端支持置 null 清空，本工具不做清空操作）
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder/inventoryTransfer 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 PUT /api/admin/products/:skuId/price 更新价格
 *
 * 预览信息依赖前置 searchProduct 工具提供 productInfo（含 skuName/currentPrice）：
 * 若 LLM 未提供 productInfo，预览仍可生成（商品名显示 SKU-ID，原价未知）。
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

/** 合法价格类型（对齐后端 updateProductPrice 支持的价格字段） */
const PRICE_TYPES = [
  'retailPrice',
  'wholesalePrice',
  'storePrice',
  'costPrice',
  'miniappPrice',
] as const;

type PriceType = (typeof PRICE_TYPES)[number];

/** 价格类型中文标签 */
const PRICE_TYPE_LABELS: Record<PriceType, string> = {
  retailPrice: '零售价',
  wholesalePrice: '批发价',
  storePrice: '门店价',
  costPrice: '进价（成本价）',
  miniappPrice: '小程序价',
};

/** 商品信息（来自前置 searchProduct 工具返回，用于预览展示原价） */
interface ProductPriceInfo {
  skuName?: string;
  /** 当前价格（原价，用于预览对比和涨幅计算） */
  currentPrice?: number;
}

/** 后端更新价格返回 */
interface UpdatePriceResult {
  skuId: number;
  changes?: Array<{
    priceType?: string;
    oldValue?: number | null;
    newValue?: number | null;
  }>;
  [key: string]: unknown;
}

@Injectable()
export class UpdateProductPriceTool implements ITool {
  private readonly logger = new Logger(UpdateProductPriceTool.name);

  readonly name = 'updateProductPrice';
  readonly description =
    '修改商品价格（写操作，需用户确认）：调整指定 SKU 的某一价格等级（零售价/批发价/门店价/进价/小程序价）。' +
    '必须先调用 searchProduct 获取商品的 skuId 和当前价格，priceType 指定价格类型，newPrice 指定新价格。' +
    '首次调用 confirm=false 生成预览（含商品名、原价、新价、涨幅、变更说明），' +
    '用户确认后 confirm=true 正式执行修改。' +
    '注意：修改价格后，所有该价格等级对应的客户销售单将按新价格计算。' +
    '示例参数：{"skuId":101,"priceType":"wholesalePrice","newPrice":1000,"productInfo":{"skuName":"五粮液 500ml","currentPrice":980},"confirm":false}';
  readonly category = 'product' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['searchProduct'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      skuId: {
        type: 'number',
        description: 'SKU ID（必填，从 searchProduct 获取）',
      },
      priceType: {
        type: 'string',
        enum: [...PRICE_TYPES],
        description:
          '价格类型（必填）：retailPrice=零售价、wholesalePrice=批发价、storePrice=门店价、costPrice=进价、miniappPrice=小程序价',
      },
      newPrice: {
        type: 'number',
        description: '新价格（必填，必须大于 0）',
      },
      productInfo: {
        type: 'object',
        description:
          '商品信息（可选，从 searchProduct 获取，用于预览展示商品名和原价）',
        properties: {
          skuName: { type: 'string', description: '商品名称（SKU名称）' },
          currentPrice: {
            type: 'number',
            description: '当前价格（原价，用于预览对比和涨幅计算）',
          },
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式修改。默认false）',
      },
    },
    required: ['skuId', 'priceType', 'newPrice'],
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

    const { skuId, priceType, newPrice, productInfo } = parsed.data;
    const confirm = parsed.data.confirm === true;
    const priceLabel = PRICE_TYPE_LABELS[priceType];

    // ── 2. 计算涨幅（有原价时） ──
    let changePercent: number | undefined;
    if (
      productInfo &&
      typeof productInfo.currentPrice === 'number' &&
      productInfo.currentPrice > 0
    ) {
      changePercent =
        Math.round(
          ((newPrice - productInfo.currentPrice) / productInfo.currentPrice) *
            10000,
        ) / 100;
    }

    const skuName = productInfo?.skuName ?? `SKU-${skuId}`;

    // ── 3. 预览阶段 ──
    if (!confirm) {
      const details: Record<string, unknown> = {
        skuId,
        skuName,
        priceType,
        priceTypeLabel: priceLabel,
        oldPrice: productInfo?.currentPrice ?? null,
        newPrice,
        changePercent: changePercent ?? null,
        changeDirection:
          changePercent === undefined
            ? null
            : changePercent > 0
              ? '上调'
              : changePercent < 0
                ? '下调'
                : '不变',
      };

      const summaryParts = [
        `${skuName}（SKU ${skuId}）`,
        `${priceLabel}：${this.formatPrice(productInfo?.currentPrice)} → ${this.formatPrice(newPrice)}`,
      ];
      if (changePercent !== undefined) {
        summaryParts.push(`${changePercent >= 0 ? '+' : ''}${changePercent}%`);
      }

      this.logger.log(`生成价格修改预览：${summaryParts.join('，')}`);

      return {
        success: true,
        preview: {
          operation: '修改商品价格',
          summary: summaryParts.join('，'),
          details,
        },
      };
    }

    // ── 4. 执行阶段：调用后端更新价格 ──
    try {
      // 将 LLM 友好参数转换为后端 body 结构（价格字段平铺）
      const requestBody = { [priceType]: newPrice };

      const result = await this.serviceClient.put<UpdatePriceResult>(
        `${API_ENDPOINTS.PRODUCTS}/${skuId}/price`,
        requestBody,
        context,
      );

      this.logger.log(
        `价格修改成功：SKU ${skuId} ${priceLabel} 调整为 ${newPrice}`,
      );

      return {
        success: true,
        data: {
          skuId,
          skuName,
          priceType,
          priceTypeLabel: priceLabel,
          oldPrice: productInfo?.currentPrice ?? null,
          newPrice,
          changePercent: changePercent ?? null,
          result,
          message: `已将${skuName}的${priceLabel}调整为 ${this.formatPrice(newPrice)}`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`修改价格失败：${errorMsg}`);
      return {
        success: false,
        error: `修改价格失败：${errorMsg}`,
        suggestion:
          '请确认后端服务是否正常运行，检查 skuId 是否正确，新价格必须大于 0',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: UpdatePriceArgs }
    | { valid: false; error: string; suggestion?: string } {
    const skuId = args.skuId;
    if (typeof skuId !== 'number' || skuId <= 0) {
      return {
        valid: false,
        error: '参数 skuId 必须为正整数',
        suggestion: '请先调用 searchProduct 获取商品的 skuId',
      };
    }

    const priceType = args.priceType;
    if (
      typeof priceType !== 'string' ||
      !(PRICE_TYPES as readonly string[]).includes(priceType)
    ) {
      return {
        valid: false,
        error: `参数 priceType 必须是 ${PRICE_TYPES.join(' / ')} 之一`,
        suggestion:
          '请确认要修改的价格类型（零售价/批发价/门店价/进价/小程序价）',
      };
    }

    const newPrice = args.newPrice;
    if (typeof newPrice !== 'number' || newPrice <= 0) {
      return {
        valid: false,
        error: '参数 newPrice 必须为大于 0 的数字',
        suggestion: '请输入合法的新价格（必须大于 0）',
      };
    }

    let productInfo: ProductPriceInfo | undefined;
    if (args.productInfo !== undefined && args.productInfo !== null) {
      if (typeof args.productInfo !== 'object') {
        return {
          valid: false,
          error: '参数 productInfo 必须为对象',
          suggestion:
            '请传入 searchProduct 返回的商品信息（skuName/currentPrice）',
        };
      }
      const raw = args.productInfo as Record<string, unknown>;
      const parsedInfo: ProductPriceInfo = {};
      if (typeof raw.skuName === 'string') parsedInfo.skuName = raw.skuName;
      if (typeof raw.currentPrice === 'number') {
        parsedInfo.currentPrice = raw.currentPrice;
      }
      productInfo = parsedInfo;
    }

    return {
      valid: true,
      data: {
        skuId,
        priceType: priceType as PriceType,
        newPrice,
        productInfo,
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }

  /** 格式化价格（保留两位小数） */
  private formatPrice(price: number | undefined | null): string {
    if (price === undefined || price === null) return '未知';
    return `¥${price.toFixed(2)}`;
  }
}

/** 修改价格参数（解析后） */
interface UpdatePriceArgs {
  skuId: number;
  priceType: PriceType;
  newPrice: number;
  productInfo?: ProductPriceInfo;
  confirm: boolean;
}
