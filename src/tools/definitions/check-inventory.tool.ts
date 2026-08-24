/**
 * checkInventory 工具 — 查询库存
 *
 * 用途：按商品名称/条码查询库存余额，返回可用库存量。
 * LLM 在创建销售单前用此工具验证库存是否充足。
 *
 * 对应后端 API：GET /api/admin/inventory-balance?keyword=xxx&page=1&pageSize=20
 * 后端路由：admin-inventory.routes.ts（prefix: /api/admin）
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

/** 后端返回的库存余额项 */
interface InventoryBalanceItem {
  skuId: number;
  skuCode: string;
  skuName: string;
  barcode: string;
  availableQty: number;
  lockedQty: number;
  totalQty: number;
  storeName: string | null;
  /** 组合单位换算信息（boxRatio=每箱数量，boxUnit=箱单位，baseUnit=基础单位） */
  boxRatio?: number | null;
  boxUnit?: string | null;
  baseUnit?: string | null;
}

/**
 * 后端返回的分页结构
 *
 * 注意：report.service.ts listInventoryBalance 实际返回 records 字段，
 * 兼容 list 字段（部分测试 mock 用 list），取记录时 records 优先、list 兜底。
 */
interface PaginatedResult<T> {
  records?: T[];
  list?: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class CheckInventoryTool implements ITool {
  private readonly logger = new Logger(CheckInventoryTool.name);

  readonly name = 'checkInventory';
  readonly description =
    '查询商品库存（按商品名称、SKU编码或条码模糊匹配）。' +
    '返回库存列表，包含SKU ID、商品名称、可用库存量、锁定库存量、总库存量。' +
    '在创建销售单前，用此工具验证库存是否充足，避免超卖。' +
    '示例：用户说"五粮液还有多少库存"→ 调用此工具 → 返回可用库存量。';
  readonly category = 'inventory' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（商品名称、SKU编码或条码，模糊匹配）',
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
    const keyword = args.keyword;
    if (typeof keyword !== 'string' || keyword.length === 0) {
      return {
        success: false,
        error: '参数 keyword 必须为非空字符串',
        suggestion: '请传入商品名称、SKU编码或条码作为搜索关键词',
      };
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    try {
      const result = await this.serviceClient.get<
        PaginatedResult<InventoryBalanceItem>
      >(
        `${API_ENDPOINTS.INVENTORY}?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`,
        context,
      );

      // 取记录：records（后端真实字段）优先，list 兜底
      const records = result?.records ?? result?.list ?? [];

      if (records.length === 0) {
        return {
          success: true,
          data: {
            list: [],
            total: 0,
            message: `未找到匹配"${keyword}"的库存记录`,
          },
        };
      }

      // 精简返回
      const simplified = records.map((item) => ({
        skuId: item.skuId,
        skuName: item.skuName,
        barcode: item.barcode,
        availableQty: item.availableQty,
        lockedQty: item.lockedQty,
        totalQty: item.totalQty,
        storeName: item.storeName,
        boxRatio: item.boxRatio ?? null,
        boxUnit: item.boxUnit ?? null,
        baseUnit: item.baseUnit ?? null,
        stockStatus: this.getStockStatus(item.availableQty),
      }));

      this.logger.debug(
        `查询库存"${keyword}"：找到 ${result.total} 条，返回 ${simplified.length} 条`,
      );

      return {
        success: true,
        data: {
          list: simplified,
          total: result.total,
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

      this.logger.warn(`查询库存失败：${errorMsg}`);
      return {
        success: false,
        error: `查询库存失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 根据可用库存量返回库存状态标签 */
  private getStockStatus(availableQty: number): string {
    if (availableQty <= 0) return '无库存';
    if (availableQty < 10) return '库存不足';
    if (availableQty < 50) return '库存偏低';
    return '库存充足';
  }
}
