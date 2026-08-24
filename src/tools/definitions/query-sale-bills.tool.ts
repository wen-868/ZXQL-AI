/**
 * querySaleBills 工具 — 查询销售单列表
 *
 * 用途：按关键词/状态/日期查询销售单列表。
 * LLM 在用户询问"今天的单子"、"红星商行的单"等时调用。
 *
 * 对应后端 API：GET /api/admin/sale-bills?keyword=xxx&status=xxx&dateStart=xxx&dateEnd=xxx
 * 后端路由：admin-order.routes.ts（prefix: /api/admin）
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

/** 后端返回的分页结构 */
interface PaginatedResult<T> {
  list: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 后端返回的销售单列表项 */
interface SaleBillListItem {
  billNo: string;
  customerName: string;
  customerMobile?: string;
  totalAmount: number;
  receivedAmount: number;
  unreceivedAmount: number;
  businessStatus: string;
  saleType: string;
  createdAt: string;
  [key: string]: unknown;
}

@Injectable()
export class QuerySaleBillsTool implements ITool {
  private readonly logger = new Logger(QuerySaleBillsTool.name);

  readonly name = 'querySaleBills';
  readonly description =
    '查询销售单列表（按关键词/状态/日期筛选）。' +
    '返回销售单列表，包含单号、客户名称、总金额、已收金额、未收金额、业务状态、创建时间。' +
    '可按单号或客户名称搜索，按状态（PENDING/CONFIRMED/DELIVERED/COMPLETED/VOIDED）筛选，按日期范围筛选。' +
    '示例：用户说"今天的单子"→ 调用此工具 → 传 dateStart=今天日期。';
  readonly category = 'order' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（单号或客户名称，模糊匹配，可选）',
      },
      status: {
        type: 'string',
        description:
          '业务状态筛选（PENDING=待处理/CONFIRMED=已确认/DELIVERED=已配送/COMPLETED=已完成/VOIDED=已作废，可选）',
      },
      dateStart: {
        type: 'string',
        description: '开始日期（YYYY-MM-DD格式，可选）',
      },
      dateEnd: {
        type: 'string',
        description: '结束日期（YYYY-MM-DD格式，可选）',
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
    const keyword = typeof args.keyword === 'string' ? args.keyword : '';
    const status = typeof args.status === 'string' ? args.status : '';
    const dateStart = typeof args.dateStart === 'string' ? args.dateStart : '';
    const dateEnd = typeof args.dateEnd === 'string' ? args.dateEnd : '';
    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    try {
      const params = new URLSearchParams();
      if (keyword) params.set('keyword', keyword);
      if (status) params.set('status', status);
      if (dateStart) params.set('dateStart', dateStart);
      if (dateEnd) params.set('dateEnd', dateEnd);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));

      const result = await this.serviceClient.get<
        PaginatedResult<SaleBillListItem>
      >(`${API_ENDPOINTS.SALE_BILLS}?${params.toString()}`, context);

      if (!result || !result.list || result.list.length === 0) {
        return {
          success: true,
          data: { list: [], total: 0, message: '未找到符合条件的销售单' },
        };
      }

      // 精简返回
      const simplified = result.list.map((bill) => ({
        billNo: bill.billNo,
        customerName: bill.customerName,
        totalAmount: bill.totalAmount,
        receivedAmount: bill.receivedAmount,
        unreceivedAmount: bill.unreceivedAmount,
        businessStatus: bill.businessStatus,
        businessStatusLabel: this.translateStatus(bill.businessStatus),
        saleType: bill.saleType,
        createdAt: bill.createdAt,
      }));

      this.logger.debug(
        `查询销售单：找到 ${result.total} 条，返回 ${simplified.length} 条`,
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

      this.logger.warn(`查询销售单失败：${errorMsg}`);
      return {
        success: false,
        error: `查询销售单失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 将业务状态代码转为中文标签 */
  private translateStatus(status: string): string {
    const map: Record<string, string> = {
      PENDING: '待处理',
      CONFIRMED: '已确认',
      DELIVERED: '已配送',
      COMPLETED: '已完成',
      VOIDED: '已作废',
      DRAFT: '草稿',
    };
    return map[status] ?? status;
  }
}
