/**
 * searchProduct 工具 — 搜索商品
 *
 * 用途：按名称搜索商品，返回商品列表（含SKU、多级价格、库存）。
 * LLM 在创建销售单前用此工具查找商品 spuId/skuId 和价格信息。
 *
 * 对应后端 API：GET /api/admin/products?keyword=xxx&page=1&pageSize=20
 * 后端路由：admin-product.routes.ts（prefix: /api/admin）
 *
 * 返回的价格字段（来自 t_product_price 表）：
 * - retailPrice：零售价
 * - wholesalePrice：批发价
 * - storePrice：门店价
 * - costPrice：进价（用于价格安全校验）
 * - boxRatio：箱瓶比（1箱=N瓶）
 * - availableQty：可用库存
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
import { normalizeProductKeyword } from '../../nlp/nl-parser';

/** 后端返回的商品列表项 */
interface ProductListItem {
  id: number;
  spuCode: string;
  name: string;
  categoryId: number;
  categoryName: string;
  brandId: number;
  brandName: string;
  unit: string;
  specs: string;
  status: string;
  skus?: ProductSkuItem[];
  // 后端列表接口将首个 SKU 字段拍平到记录顶层（无嵌套 skus 数组时使用）
  skuId?: number;
  skuName?: string;
  barcode?: string;
  boxRatio?: number;
  baseUnit?: string;
  boxUnit?: string;
  retailPrice?: number;
  wholesalePrice?: number;
  storePrice?: number;
  costPrice?: number;
  availableQty?: number;
}

/** 后端返回的 SKU 信息 */
interface ProductSkuItem {
  id: number;
  skuCode: string;
  skuName: string;
  barcode: string;
  volume: number;
  packaging: string;
  baseUnit: string;
  boxUnit: string;
  boxRatio: number;
  costPrice: number;
  retailPrice: number;
  wholesalePrice: number;
  miniappPrice: number;
  storePrice: number;
  availableQty: number;
}

/** 后端返回的分页结构 */
interface PaginatedResult<T> {
  /** 后端真实字段（listProducts 返回 records） */
  records?: T[];
  /** 兼容旧形态 */
  list?: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class SearchProductTool implements ITool {
  private readonly logger = new Logger(SearchProductTool.name);

  readonly name = 'searchProduct';
  readonly description =
    '搜索商品（按名称模糊匹配）。' +
    '返回商品列表，包含商品ID(spuId)、名称、品牌、规格，以及每个SKU的价格信息（零售价/批发价/门店价/进价）和库存。' +
    '在创建销售单前，用此工具查找商品的 skuId 和价格。' +
    '示例：用户说"五粮液"→ 调用此工具 → 获取 skuId + boxRatio + 价格 → 传给 createSalesOrder。';
  readonly category = 'product' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（商品名称，模糊匹配）',
      },
      page: {
        type: 'number',
        description: '页码（默认1）',
      },
      pageSize: {
        type: 'number',
        description: '每页条数（默认20，最大50）',
      },
    },
    required: ['keyword'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const rawKeyword = args.keyword;
    if (typeof rawKeyword !== 'string' || rawKeyword.length === 0) {
      return {
        success: false,
        error: '参数 keyword 必须为非空字符串',
        suggestion: '请传入商品名称作为搜索关键词',
      };
    }
    // 精准度优化：剥离动作/数量/问句前缀，只保留商品名（如"给我来10箱五粮液"→"五粮液"）
    const keyword = normalizeProductKeyword(rawKeyword);
    if (!keyword) {
      return {
        success: false,
        error: `无法从「${rawKeyword}」识别商品名称`,
        suggestion: '请直接提供商品名称，如"五粮液"',
      };
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    try {
      const result = await this.serviceClient.get<
        PaginatedResult<ProductListItem>
      >(
        `${API_ENDPOINTS.PRODUCTS}?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`,
        context,
      );

      // R70-11 修复：后端 listProducts 返回 records 字段（非 list），双字段兼容，
      // 否则搜索永远返回空列表（与 searchCustomer 同源问题）
      const products = result?.records ?? result?.list ?? [];
      const total = result?.total ?? 0;

      if (products.length === 0) {
        return {
          success: true,
          data: {
            list: [],
            total,
            message: `未找到匹配"${keyword}"的商品`,
            suggestion: `未找到商品「${keyword}」。请询问用户是否创建该商品（创建需要确认至少一个价格：零售价或批发价）；用户确认并提供价格后调用 createProduct 自动创建。`,
          },
        };
      }

      // 精简返回，突出关键字段
      // 后端 listProducts 将首个 SKU 字段拍平到记录顶层（skuId/boxRatio/价格等），
      // 无嵌套 skus 时从拍平字段构造，确保 LLM 拿到 skuId 与价格（否则无法继续开单）
      const simplified = products.map((p) => {
        const nestedSkus = Array.isArray(p.skus) ? p.skus : [];
        const skus =
          nestedSkus.length > 0
            ? nestedSkus.map((s) => ({
                skuId: s.id,
                skuName: s.skuName,
                barcode: s.barcode,
                boxRatio: s.boxRatio,
                baseUnit: s.baseUnit,
                boxUnit: s.boxUnit,
                prices: {
                  retailPrice: s.retailPrice,
                  wholesalePrice: s.wholesalePrice,
                  storePrice: s.storePrice,
                  costPrice: s.costPrice,
                },
                availableQty: s.availableQty,
              }))
            : p.skuId !== undefined
              ? [
                  {
                    skuId: p.skuId,
                    skuName: p.skuName ?? p.name,
                    barcode: p.barcode,
                    boxRatio: p.boxRatio ?? 1,
                    baseUnit: p.baseUnit,
                    boxUnit: p.boxUnit,
                    prices: {
                      retailPrice: p.retailPrice,
                      wholesalePrice: p.wholesalePrice,
                      storePrice: p.storePrice,
                      costPrice: p.costPrice,
                    },
                    availableQty: p.availableQty,
                  },
                ]
              : [];
        return {
          spuId: p.id,
          name: p.name,
          brandName: p.brandName,
          specs: p.specs,
          unit: p.unit,
          categoryName: p.categoryName,
          skus,
        };
      });

      this.logger.debug(
        `搜索商品"${keyword}"：找到 ${result.total} 条，返回 ${simplified.length} 条`,
      );

      return {
        success: true,
        data: {
          list: simplified,
          total,
          page,
          pageSize,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`搜索商品失败：${errorMsg}`);
      return {
        success: false,
        error: `搜索商品失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }
}
