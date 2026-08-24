/**
 * queryReceivables 工具 — 查询应收账款（只读）
 *
 * 用途：查询客户应收账款列表，支持按客户、账期状态筛选。
 * 适合"红星商行还欠多少""有哪些逾期账款"等场景。
 *
 * 对应后端 API：GET /api/admin/receivables?customerId=&status=&page=&pageSize=
 * 后端路由：receivable.routes.ts（prefix: /api/admin/receivables，listReceivables）
 * 后端服务：receivable.service.ts listReceivables
 *
 * 返回结构（以 receivable.service.ts listReceivables 为准，records 字段）：
 * { total, page, pageSize, records: [{ id, customerId, customerName, sourceType, sourceNo,
 *   receivableAmount, receivedAmount, balance, dueDate, status, createdAt }] }
 *
 * 应收状态（status）：
 * - PENDING：待收款
 * - PARTIAL：部分收款
 * - PAID：已结清
 * - OVERDUE：逾期
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

/** 后端返回的应收列表项 */
interface ReceivableItem {
  id: number;
  customerId: number;
  customerName: string;
  sourceType: string | null;
  sourceNo: string | null;
  receivableAmount: number;
  receivedAmount: number;
  balance: number;
  dueDate: string | null;
  status: string;
  createdAt: string;
}

/** 后端返回的分页结构（records 字段） */
interface ReceivablePage {
  total: number;
  page: number;
  pageSize: number;
  records: ReceivableItem[];
}

/** 应收状态中文标签 */
const STATUS_LABELS: Record<string, string> = {
  PENDING: '待收款',
  PARTIAL: '部分收款',
  PAID: '已结清',
  OVERDUE: '逾期',
};

@Injectable()
export class QueryReceivablesTool implements ITool {
  private readonly logger = new Logger(QueryReceivablesTool.name);

  readonly name = 'queryReceivables';
  readonly description =
    '查询应收账款：按客户ID、账期状态筛选应收款项，返回每个客户的' +
    '应收金额、已收金额、欠款余额、到期日、状态（PENDING=待收款/PARTIAL=部分收款/PAID=已结清/OVERDUE=逾期）。' +
    '适合"红星商行还欠多少""有哪些逾期账款"等场景。' +
    '示例参数：{"customerId":5}、{"status":"OVERDUE"}';
  readonly category = 'finance' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: {
        type: 'number',
        description: '客户ID（可选，按客户筛选）',
      },
      status: {
        type: 'string',
        enum: ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE'],
        description:
          '应收状态（可选）：PENDING=待收款、PARTIAL=部分收款、PAID=已结清、OVERDUE=逾期',
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
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }

    const { customerId, status, page, pageSize } = parsed.data;

    const queryParams: string[] = [];
    if (customerId !== undefined) queryParams.push(`customerId=${customerId}`);
    if (status) queryParams.push(`status=${status}`);
    queryParams.push(`page=${page}`, `pageSize=${pageSize}`);
    const queryString = queryParams.join('&');

    try {
      const result = await this.serviceClient.get<ReceivablePage>(
        `${API_ENDPOINTS.RECEIVABLES}?${queryString}`,
        context,
      );

      const records = result?.records ?? [];
      const total = result?.total ?? 0;

      if (records.length === 0) {
        return {
          success: true,
          data: {
            list: [],
            total: 0,
            message: '未找到符合条件的应收账款',
          },
        };
      }

      const simplified = records.map((r) => ({
        id: r.id,
        customerId: r.customerId,
        customerName: r.customerName,
        sourceType: r.sourceType,
        sourceNo: r.sourceNo,
        receivableAmount: r.receivableAmount,
        receivedAmount: r.receivedAmount,
        balance: r.balance,
        dueDate: r.dueDate,
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] ?? r.status,
      }));

      this.logger.debug(
        `查询应收账款：找到 ${total} 条，返回 ${simplified.length} 条`,
      );

      return {
        success: true,
        data: { list: simplified, total, page, pageSize },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询应收账款失败：${errorMsg}`);
      return {
        success: false,
        error: `查询应收账款失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: QueryReceivablesArgs }
    | { valid: false; error: string; suggestion?: string } {
    let customerId: number | undefined;
    if (args.customerId !== undefined) {
      if (typeof args.customerId !== 'number' || args.customerId <= 0) {
        return {
          valid: false,
          error: '参数 customerId 必须为正整数',
          suggestion: '请确认客户ID',
        };
      }
      customerId = args.customerId;
    }

    let status: string | undefined;
    if (args.status !== undefined) {
      if (typeof args.status !== 'string') {
        return {
          valid: false,
          error: '参数 status 必须为字符串',
          suggestion: '请输入应收状态（PENDING/PARTIAL/PAID/OVERDUE）',
        };
      }
      status = args.status;
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    return { valid: true, data: { customerId, status, page, pageSize } };
  }
}

/** 查询应收参数（解析后） */
interface QueryReceivablesArgs {
  customerId?: number;
  status?: string;
  page: number;
  pageSize: number;
}
