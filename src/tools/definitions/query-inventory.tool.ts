/**
 * queryInventory 工具 — 查询库存汇总（按仓库/商品维度）
 *
 * 用途：按门店（仓库）、商品分类、关键词等维度查询库存余额，返回库存量+库存状态。
 * 与 checkInventory 的区别：
 * - checkInventory：keyword 必填，按商品名称/条码模糊查询单个/少量商品库存（下单前核验）
 * - queryInventory：keyword 可选，支持按 storeId（仓库）、category（分类）维度汇总查询，
 *   用户说"1号仓还有哪些库存""白酒类目库存多少"等场景使用本工具
 *
 * 对应后端 API：GET /api/admin/inventory-balance?keyword=&storeId=&category=&page=&pageSize=
 * 后端路由：admin-inventory.routes.ts（prefix: /api/admin，listInventoryBalance）
 * 后端服务：report.service.ts listInventoryBalance（支持 keyword/storeId/category 过滤）
 *
 * 返回结构（以 report.service.ts listInventoryBalance 为准，records 字段）：
 * { total, page, pageSize, records: [{ storeId, storeName, skuId, skuName, barcode,
 *   stockType, physicalQty, availableQty, lockedQty }] }
 *
 * 库存状态标签：无库存（<=0）/ 库存不足（<10）/ 库存偏低（<50）/ 库存充足
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

/** 后端返回的库存余额项（report.service.ts listInventoryBalance） */
interface InventoryBalanceItem {
  storeId: number;
  storeName: string | null;
  skuId: number;
  skuName: string;
  barcode: string;
  stockType: string;
  physicalQty: number;
  availableQty: number;
  lockedQty: number;
  /** 组合单位换算信息（boxRatio=每箱数量，boxUnit=箱单位，baseUnit=基础单位） */
  boxRatio?: number | null;
  boxUnit?: string | null;
  baseUnit?: string | null;
}

/** 后端返回的分页结构（records 字段，与后端对齐） */
interface InventoryBalancePage {
  total: number;
  page: number;
  pageSize: number;
  records: InventoryBalanceItem[];
}

@Injectable()
export class QueryInventoryTool implements ITool {
  private readonly logger = new Logger(QueryInventoryTool.name);

  readonly name = 'queryInventory';
  readonly description =
    '查询库存汇总（按仓库/商品维度）：可按门店ID、商品分类、关键词筛选库存余额，返回库存量+库存状态。' +
    '与 checkInventory 的区别：本工具 keyword 可选，支持按仓库（storeId）、分类（category）维度汇总查询，' +
    '适合"1号仓还有哪些库存""白酒类库存多少"等场景；查单个商品库存用 checkInventory。' +
    '返回包含门店名称、SKU名称、物理库存/可用库存/锁定库存、库存状态标签。' +
    '示例参数：{"storeId":1}、{"category":2}、{"keyword":"五粮液"}';
  readonly category = 'inventory' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（可选，商品名称、SKU编码或条码，模糊匹配）',
      },
      storeId: {
        type: 'number',
        description: '门店ID（可选，按仓库维度筛选库存）',
      },
      category: {
        type: 'number',
        description: '商品分类ID（可选，按分类维度筛选库存）',
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
    required: [],
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

    const { keyword, storeId, category, page, pageSize } = parsed.data;

    // 组装查询参数
    const queryParams: string[] = [];
    if (keyword) {
      queryParams.push(`keyword=${encodeURIComponent(keyword)}`);
    }
    if (storeId !== undefined) {
      queryParams.push(`storeId=${storeId}`);
    }
    if (category !== undefined) {
      queryParams.push(`category=${category}`);
    }
    queryParams.push(`page=${page}`, `pageSize=${pageSize}`);

    const queryString = queryParams.join('&');

    try {
      const result = await this.serviceClient.get<InventoryBalancePage>(
        `${API_ENDPOINTS.INVENTORY}?${queryString}`,
        context,
      );

      // 兼容后端 records 字段（report.service.ts 返回 records）
      const records = result?.records ?? [];
      const total = result?.total ?? 0;

      if (records.length === 0) {
        return {
          success: true,
          data: {
            list: [],
            total: 0,
            storeId,
            category,
            keyword,
            message: `未找到${this.buildFilterDesc(parsed.data)}的库存记录`,
          },
        };
      }

      // 精简返回
      const simplified = records.map((item) => ({
        storeId: item.storeId,
        storeName: item.storeName,
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: item.barcode,
        physicalQty: item.physicalQty,
        availableQty: item.availableQty,
        lockedQty: item.lockedQty,
        boxRatio: item.boxRatio ?? null,
        boxUnit: item.boxUnit ?? null,
        baseUnit: item.baseUnit ?? null,
        stockStatus: this.getStockStatus(item.availableQty),
      }));

      // 汇总统计
      const totalAvailable = simplified.reduce(
        (sum, item) => sum + item.availableQty,
        0,
      );
      const totalPhysical = simplified.reduce(
        (sum, item) => sum + item.physicalQty,
        0,
      );

      this.logger.debug(
        `查询库存汇总${this.buildFilterDesc(parsed.data)}：找到 ${total} 条，` +
          `返回 ${simplified.length} 条，可用库存合计 ${totalAvailable}`,
      );

      return {
        success: true,
        data: {
          list: simplified,
          total,
          page,
          pageSize,
          summary: {
            totalAvailable,
            totalPhysical,
            storeCount: new Set(simplified.map((item) => item.storeId)).size,
          },
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询库存汇总失败：${errorMsg}`);
      return {
        success: false,
        error: `查询库存汇总失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: QueryInventoryArgs }
    | { valid: false; error: string; suggestion?: string } {
    const keyword =
      typeof args.keyword === 'string' && args.keyword.length > 0
        ? args.keyword
        : undefined;

    let storeId: number | undefined;
    if (args.storeId !== undefined) {
      if (typeof args.storeId !== 'number' || args.storeId <= 0) {
        return {
          valid: false,
          error: '参数 storeId 必须为正整数',
          suggestion: '请确认门店ID',
        };
      }
      storeId = args.storeId;
    }

    let category: number | undefined;
    if (args.category !== undefined) {
      if (typeof args.category !== 'number' || args.category <= 0) {
        return {
          valid: false,
          error: '参数 category 必须为正整数',
          suggestion: '请确认商品分类ID',
        };
      }
      category = args.category;
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    return {
      valid: true,
      data: { keyword, storeId, category, page, pageSize },
    };
  }

  /** 根据可用库存量返回库存状态标签（与 checkInventory 一致） */
  private getStockStatus(availableQty: number): string {
    if (availableQty <= 0) return '无库存';
    if (availableQty < 10) return '库存不足';
    if (availableQty < 50) return '库存偏低';
    return '库存充足';
  }

  /** 生成筛选条件的中文描述（用于空结果提示） */
  private buildFilterDesc(args: QueryInventoryArgs): string {
    const parts: string[] = [];
    if (args.keyword) parts.push(`关键词"${args.keyword}"`);
    if (args.storeId !== undefined) parts.push(`门店 ${args.storeId}`);
    if (args.category !== undefined) parts.push(`分类 ${args.category}`);
    return parts.length > 0 ? parts.join('、') : '当前条件';
  }
}

/** 查询库存汇总参数（解析后） */
interface QueryInventoryArgs {
  keyword?: string;
  storeId?: number;
  category?: number;
  page: number;
  pageSize: number;
}
