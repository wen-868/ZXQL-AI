/**
 * createProduct 工具 — 创建商品（写操作，含预览机制）
 *
 * 用途：搜索商品未找到时，经用户确认后自动创建商品（SPU + SKU + 价格）。
 * 对应后端 API：POST /api/admin/products
 * 后端路由：admin-product.routes.ts（productController.createProduct）
 *
 * 设计（对齐 createCustomer 两阶段确认）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/products 创建商品
 *
 * 参数说明：
 * - name：商品名称（必填）
 * - categoryId：分类ID（可选；不传时按 categoryName 模糊匹配，仍找不到用第一个分类）
 * - categoryName：分类名称（可选，如"白酒"，用于自动匹配 categoryId）
 * - retailPrice / wholesalePrice：至少提供一个价格，否则无法创建可售商品（创建后销售单价格取用户指定或系统价）
 * - boxRatio：箱瓶比（默认 1）
 * - baseUnit / boxUnit：基础单位 / 包装单位（默认 瓶 / 箱）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-10
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 后端创建商品返回 */
interface CreateProductResult {
  id: number;
  spuId: number;
  skuId: number;
  spuCode: string;
}

/** 分类列表项（GET /api/admin/products/categories） */
interface CategoryItem {
  id: number;
  name: string;
}

/** 后端商品列表项（查重用，列表接口字段拍平到记录顶层） */
interface ProductListItem {
  id: number;
  name: string;
  skuId?: number;
  spuCode?: string;
}

@Injectable()
export class CreateProductTool implements ITool {
  private readonly logger = new Logger(CreateProductTool.name);

  readonly name = 'createProduct';
  readonly description =
    '创建商品（写操作，需用户确认）：搜索商品未找到时，经用户确认后自动创建商品（含SKU与价格）。' +
    '需要商品名称和至少一个价格（零售价或批发价）；分类可选（不传时自动匹配分类）。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。' +
    '示例参数：{"name":"红星二锅头 56度 500ml","categoryName":"白酒","retailPrice":45,"wholesalePrice":38,"boxRatio":6,"confirm":false}';
  readonly category = 'product' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: '商品名称（必填，如"红星二锅头 56度 500ml"）',
      },
      categoryId: {
        type: 'number',
        description: '分类ID（可选；不传时按 categoryName 匹配或取默认分类）',
      },
      categoryName: {
        type: 'string',
        description:
          '分类名称（可选，如"白酒"/"啤酒"/"其他"，用于自动匹配分类ID）',
      },
      skuName: {
        type: 'string',
        description: 'SKU名称（可选，默认取商品名称）',
      },
      retailPrice: {
        type: 'number',
        description: '零售价（元/最小单位，与批发价至少提供一个）',
      },
      wholesalePrice: {
        type: 'number',
        description: '批发价（元/最小单位，可选）',
      },
      boxRatio: {
        type: 'number',
        description: '箱瓶比（1箱=N瓶，默认1）',
      },
      baseUnit: {
        type: 'string',
        description: '基础单位（默认"瓶"）',
      },
      boxUnit: {
        type: 'string',
        description: '包装单位（默认"箱"）',
      },
      remark: {
        type: 'string',
        description: '备注/描述（可选）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['name'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }

    const productArgs = parsed.data;
    const confirm = productArgs.confirm === true;

    // ── 分类解析（预览与执行阶段都需要 categoryId） ──
    let categoryId = productArgs.categoryId;
    let categoryName = productArgs.categoryName;
    if (categoryId === undefined) {
      try {
        const resolved = await this.resolveCategory(
          productArgs.categoryName,
          context,
        );
        categoryId = resolved.id;
        categoryName = resolved.name;
      } catch (err) {
        const errorMsg =
          err instanceof BridgeError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          success: false,
          error: `解析商品分类失败：${errorMsg}`,
          suggestion:
            '请传入 categoryId 或 categoryName，或确认后端分类接口正常',
        };
      }
    }

    const retailPrice = productArgs.retailPrice ?? 0;
    const wholesalePrice =
      productArgs.wholesalePrice ?? (retailPrice > 0 ? retailPrice : 0);
    const storePrice = wholesalePrice > 0 ? wholesalePrice : retailPrice;
    const baseUnit = productArgs.baseUnit;
    const boxUnit = productArgs.boxUnit;

    // ── 预览阶段 ──
    if (!confirm) {
      const details: Record<string, unknown> = {
        name: productArgs.name,
        categoryName: categoryName ?? categoryId,
        skuName: productArgs.skuName ?? productArgs.name,
        baseUnit,
        boxUnit,
        boxRatio: productArgs.boxRatio,
        retailPrice: retailPrice > 0 ? retailPrice : null,
        wholesalePrice: wholesalePrice > 0 ? wholesalePrice : null,
        remark: productArgs.remark ?? null,
      };

      this.logger.log(
        `生成创建商品预览：${productArgs.name}（分类=${categoryName ?? categoryId}）`,
      );

      return {
        success: true,
        preview: {
          operation: '创建商品',
          summary:
            `新建商品「${productArgs.name}」` +
            `（分类：${categoryName ?? categoryId}）` +
            (retailPrice > 0 ? `，零售价 ¥${retailPrice}` : '') +
            (wholesalePrice > 0 ? `，批发价 ¥${wholesalePrice}` : ''),
          details,
        },
      };
    }

    // ── 执行阶段：调用后端创建商品 ──
    try {
      // ── 查重：同租户已存在同名商品则不重复创建，直接复用 ──
      const existed = await this.findExistingProduct(productArgs.name, context);
      if (existed) {
        this.logger.log(
          `商品「${productArgs.name}」已存在（spuId=${existed.id}），跳过创建`,
        );
        return {
          success: true,
          data: {
            spuId: existed.id,
            skuId: existed.skuId ?? existed.id,
            spuCode: existed.spuCode,
            name: existed.name,
            duplicate: true,
            message: `商品「${existed.name}」已存在（spuId=${existed.id}），已直接复用，未重复创建`,
          },
        };
      }

      const requestBody = {
        name: productArgs.name,
        categoryId,
        unit: baseUnit,
        specs: productArgs.specs,
        description: productArgs.remark,
        saleChannels: ['STORE', 'MINIAPP'],
        skus: [
          {
            skuName: productArgs.skuName ?? productArgs.name,
            baseUnit,
            boxUnit,
            boxRatio: productArgs.boxRatio,
            costPrice: 0,
            retailPrice,
            wholesalePrice: wholesalePrice > 0 ? wholesalePrice : null,
            miniappPrice: storePrice > 0 ? storePrice : null,
            storePrice: storePrice > 0 ? storePrice : null,
          },
        ],
      };

      const result = await this.serviceClient.post<CreateProductResult>(
        API_ENDPOINTS.PRODUCTS,
        requestBody,
        context,
      );

      this.logger.log(
        `创建商品成功：spuId=${result.spuId} skuId=${result.skuId} name=${productArgs.name}`,
      );

      return {
        success: true,
        data: {
          spuId: result.spuId,
          skuId: result.skuId,
          spuCode: result.spuCode,
          name: productArgs.name,
          categoryId,
          message: `商品「${productArgs.name}」创建成功，spuId=${result.spuId} skuId=${result.skuId}`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建商品失败：${errorMsg}`);
      return {
        success: false,
        error: `创建商品失败：${errorMsg}`,
        suggestion: '请确认后端服务正常、商品名称非空、且至少提供一个价格',
      };
    }
  }

  /** 按名称查重（精确匹配，防止重复创建商品） */
  private async findExistingProduct(
    name: string,
    context: ToolContext,
  ): Promise<ProductListItem | undefined> {
    const result = await this.serviceClient.get<{
      records?: ProductListItem[];
      list?: ProductListItem[];
    }>(
      `${API_ENDPOINTS.PRODUCTS}?keyword=${encodeURIComponent(name)}&page=1&pageSize=10`,
      context,
    );
    const products = result?.records ?? result?.list ?? [];
    return products.find((p) => p.name === name);
  }

  /** 解析分类：按名称模糊匹配，找不到时取第一个分类 */
  private async resolveCategory(
    categoryName: string | undefined,
    context: ToolContext,
  ): Promise<CategoryItem> {
    const categories = await this.serviceClient.get<CategoryItem[]>(
      `${API_ENDPOINTS.CATEGORIES}`,
      context,
    );
    const list = Array.isArray(categories) ? categories : [];
    if (list.length === 0) {
      throw new BridgeError('系统中暂无商品分类', 404, 'NO_CATEGORY');
    }
    if (categoryName) {
      const matched = list.find((c) => c.name.includes(categoryName));
      if (matched) return matched;
    }
    return list[0];
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateProductArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 name 必须为非空字符串',
        suggestion: '请输入商品名称',
      };
    }

    const retailPrice =
      typeof args.retailPrice === 'number' && args.retailPrice > 0
        ? args.retailPrice
        : undefined;
    const wholesalePrice =
      typeof args.wholesalePrice === 'number' && args.wholesalePrice > 0
        ? args.wholesalePrice
        : undefined;

    if (retailPrice === undefined && wholesalePrice === undefined) {
      return {
        valid: false,
        error: '创建商品需要至少提供一个价格（retailPrice 或 wholesalePrice）',
        suggestion: '请向用户确认商品价格后再创建',
      };
    }

    let categoryId: number | undefined;
    if (args.categoryId !== undefined) {
      if (typeof args.categoryId !== 'number' || args.categoryId <= 0) {
        return {
          valid: false,
          error: '参数 categoryId 必须为正整数',
          suggestion: '请传入合法的分类ID',
        };
      }
      categoryId = args.categoryId;
    }

    let boxRatio = 1;
    if (args.boxRatio !== undefined) {
      if (typeof args.boxRatio !== 'number' || args.boxRatio <= 0) {
        return {
          valid: false,
          error: '参数 boxRatio 必须为正数',
          suggestion: '请传入合法的箱瓶比',
        };
      }
      boxRatio = args.boxRatio;
    }

    return {
      valid: true,
      data: {
        name: name.trim(),
        categoryId,
        categoryName:
          typeof args.categoryName === 'string' && args.categoryName.trim()
            ? args.categoryName.trim()
            : undefined,
        skuName:
          typeof args.skuName === 'string' && args.skuName.trim()
            ? args.skuName.trim()
            : undefined,
        retailPrice,
        wholesalePrice,
        boxRatio,
        baseUnit:
          typeof args.baseUnit === 'string' && args.baseUnit.trim()
            ? args.baseUnit.trim()
            : '瓶',
        boxUnit:
          typeof args.boxUnit === 'string' && args.boxUnit.trim()
            ? args.boxUnit.trim()
            : '箱',
        specs:
          typeof args.specs === 'string' && args.specs.trim()
            ? args.specs.trim()
            : undefined,
        remark:
          typeof args.remark === 'string' && args.remark.trim()
            ? args.remark.trim()
            : undefined,
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }
}

/** 创建商品参数（解析后） */
interface CreateProductArgs {
  name: string;
  categoryId?: number;
  categoryName?: string;
  skuName?: string;
  retailPrice?: number;
  wholesalePrice?: number;
  boxRatio: number;
  baseUnit: string;
  boxUnit: string;
  specs?: string;
  remark?: string;
  confirm: boolean;
}
