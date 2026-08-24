/**
 * queryProductDetail 工具 — 查询商品详情（精确查询，只读）
 *
 * 用途：按 spuId 精确查询单个商品的完整信息（SPU 基础信息 + 全部 SKU 的多级价格/库存/条码）。
 * 与 searchProduct 的区别：
 * - searchProduct：keyword 必填，模糊搜索商品列表（返回精简字段）
 * - queryProductDetail：spuId 必填，精确查询单个商品详情（返回完整字段）
 *
 * 对应后端 API：GET /api/admin/products/:spuId（:spuId 只匹配数字）
 * 后端路由：admin-product.routes.ts（prefix: /api/admin，getProductDetail）
 * 后端服务：product.service.ts getProductDetail（返回 { ...spu, skus }）
 *
 * 返回字段（以 product.service.ts getProductDetail 为准）：
 * - spu：id/spuCode/name/categoryName/brandName/unit/specs/alcoholContent/origin/mainImage/status 等
 * - skus：skuId/skuCode/skuName/barcode/volume/packaging/baseUnit/boxUnit/boxRatio/temperature/
 *   traceEnabled/warningThreshold/costPrice/retailPrice/wholesalePrice/miniappPrice/storePrice/availableQty
 *
 * 注意：spuId 可从 searchProduct 返回的 spuId 字段获取；本工具不支持按 skuId 查询
 * （后端详情端点只接收 spuId），如需按 SKU 定位商品请先调用 searchProduct。
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

/** 后端返回的 SKU 信息 */
interface ProductDetailSku {
  id: number;
  skuCode: string;
  skuName: string;
  barcode: string | null;
  volume: string | null;
  packaging: string | null;
  baseUnit: string | null;
  boxUnit: string | null;
  boxRatio: number | null;
  temperature: string;
  warningThreshold: number | null;
  costPrice: number | null;
  retailPrice: number | null;
  wholesalePrice: number | null;
  miniappPrice: number | null;
  storePrice: number | null;
  availableQty: number | null;
}

/** 后端商品详情返回 */
interface ProductDetailResult {
  spuCode?: string;
  name?: string;
  skus?: ProductDetailSku[];
  [key: string]: unknown;
}

@Injectable()
export class QueryProductDetailTool implements ITool {
  private readonly logger = new Logger(QueryProductDetailTool.name);

  readonly name = 'queryProductDetail';
  readonly description =
    '查询商品详情（精确查询）：按 spuId 查询单个商品的完整信息，返回 SPU 基础信息 + 全部 SKU 的' +
    '多级价格（零售价/批发价/门店价/进价）、库存、条码、箱瓶比等。' +
    '与 searchProduct 的区别：searchProduct 按关键词模糊搜索商品列表；本工具按 spuId 精确查询单个商品详情。' +
    'spuId 可从 searchProduct 返回的 spuId 字段获取。' +
    '适合"五粮液商品详情""这个商品都有哪些规格和价格"等场景。' +
    '示例参数：{"spuId":1}';
  readonly category = 'product' as const;
  readonly isWriteOperation = false;
  readonly requiredTools = ['searchProduct'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      spuId: {
        type: 'number',
        description:
          '商品 SPU ID（必填，正整数，从 searchProduct 返回的 spuId 字段获取）',
      },
    },
    required: ['spuId'],
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

    const spuId = parsed.data.spuId;

    try {
      const result = await this.serviceClient.get<ProductDetailResult>(
        `${API_ENDPOINTS.PRODUCTS}/${spuId}`,
        context,
      );

      if (!result || typeof result !== 'object') {
        return {
          success: false,
          error: `查询商品详情失败：后端返回空数据（spuId=${spuId}）`,
          suggestion: '请确认 spuId 是否正确',
        };
      }

      const skus = result.skus ?? [];

      // 精简返回：SPU 基础信息 + SKU 多级价格/库存
      const simplified = {
        spuId,
        spuCode: result.spuCode ?? null,
        name: result.name ?? `SPU-${spuId}`,
        categoryName:
          typeof result.categoryName === 'string' ? result.categoryName : null,
        brandName:
          typeof result.brandName === 'string' ? result.brandName : null,
        unit: typeof result.unit === 'string' ? result.unit : null,
        specs: typeof result.specs === 'string' ? result.specs : null,
        status: typeof result.status === 'string' ? result.status : null,
        saleChannels:
          typeof result.saleChannels === 'string' ? result.saleChannels : null,
        skus: skus.map((s) => ({
          skuId: s.id,
          skuCode: s.skuCode,
          skuName: s.skuName,
          barcode: s.barcode,
          volume: s.volume,
          packaging: s.packaging,
          baseUnit: s.baseUnit,
          boxUnit: s.boxUnit,
          boxRatio: s.boxRatio,
          temperature: s.temperature,
          prices: {
            retailPrice: s.retailPrice,
            wholesalePrice: s.wholesalePrice,
            storePrice: s.storePrice,
            costPrice: s.costPrice,
          },
          availableQty: s.availableQty,
          warningThreshold: s.warningThreshold,
        })),
      };

      this.logger.debug(`查询商品详情：spuId=${spuId}，${skus.length} 个 SKU`);

      return {
        success: true,
        data: simplified,
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询商品详情失败：${errorMsg}`);
      return {
        success: false,
        error: `查询商品详情失败：${errorMsg}`,
        suggestion:
          '请确认 spuId 是否正确（spuId 可从 searchProduct 返回结果获取），或后端服务是否正常运行',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: { spuId: number } }
    | { valid: false; error: string; suggestion?: string } {
    const spuId = args.spuId;
    if (typeof spuId !== 'number' || spuId <= 0) {
      return {
        valid: false,
        error: '参数 spuId 必须为正整数',
        suggestion:
          '请先调用 searchProduct 搜索商品，从返回结果的 spuId 字段获取',
      };
    }

    return { valid: true, data: { spuId } };
  }
}
