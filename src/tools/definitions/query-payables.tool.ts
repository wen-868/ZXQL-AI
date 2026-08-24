/**
 * queryPayables 工具 — 查询应付账款（只读）
 *
 * 用途：查询供应商应付账款列表，支持按供应商、账期状态筛选。
 * 适合"我们欠供应商多少钱""有哪些待付款"等场景。
 *
 * 对应后端 API：GET /api/admin/receivables/payables?supplierId=&status=&page=&pageSize=
 * 后端路由：receivable.routes.ts（prefix: /api/admin/receivables，listPayables）
 * 后端服务：receivable.service.ts listPayables
 *
 * 返回结构（以 receivable.service.ts listPayables 为准，records 字段）：
 * { total, page, pageSize, records: [{ id, supplierId, supplierName, sourceType, sourceNo,
 *   payableAmount, paidAmount, balance, dueDate, status, createdAt }] }
 *
 * 应付状态（status）：
 * - PENDING：待付款
 * - PARTIAL：部分付款
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

/** 后端返回的应付列表项 */
interface PayableItem {
  id: number;
  supplierId: number;
  supplierName: string;
  sourceType: string | null;
  sourceNo: string | null;
  payableAmount: number;
  paidAmount: number;
  balance: number;
  dueDate: string | null;
  status: string;
  createdAt: string;
}

/** 后端返回的分页结构（records 字段） */
interface PayablePage {
  total: number;
  page: number;
  pageSize: number;
  records: PayableItem[];
}

/** 应付状态中文标签 */
const STATUS_LABELS: Record<string, string> = {
  PENDING: '待付款',
  PARTIAL: '部分付款',
  PAID: '已结清',
  OVERDUE: '逾期',
};

@Injectable()
export class QueryPayablesTool implements ITool {
  private readonly logger = new Logger(QueryPayablesTool.name);

  readonly name = 'queryPayables';
  readonly description =
    '查询应付账款：按供应商ID、账期状态筛选应付款项，返回每个供应商的' +
    '应付金额、已付金额、欠款余额、到期日、状态（PENDING=待付款/PARTIAL=部分付款/PAID=已结清/OVERDUE=逾期）。' +
    '适合"我们欠供应商多少钱""有哪些待付款"等场景。' +
    '示例参数：{"supplierId":3}、{"status":"PENDING"}';
  readonly category = 'finance' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: {
        type: 'number',
        description: '供应商ID（可选，按供应商筛选）',
      },
      status: {
        type: 'string',
        enum: ['PENDING', 'PARTIAL', 'PAID', 'OVERDUE'],
        description:
          '应付状态（可选）：PENDING=待付款、PARTIAL=部分付款、PAID=已结清、OVERDUE=逾期',
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

    const { supplierId, status, page, pageSize } = parsed.data;

    const queryParams: string[] = [];
    if (supplierId !== undefined) queryParams.push(`supplierId=${supplierId}`);
    if (status) queryParams.push(`status=${status}`);
    queryParams.push(`page=${page}`, `pageSize=${pageSize}`);
    const queryString = queryParams.join('&');

    try {
      const result = await this.serviceClient.get<PayablePage>(
        `${API_ENDPOINTS.RECEIVABLES}/payables?${queryString}`,
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
            message: '未找到符合条件的应付账款',
          },
        };
      }

      const simplified = records.map((r) => ({
        id: r.id,
        supplierId: r.supplierId,
        supplierName: r.supplierName,
        sourceType: r.sourceType,
        sourceNo: r.sourceNo,
        payableAmount: r.payableAmount,
        paidAmount: r.paidAmount,
        balance: r.balance,
        dueDate: r.dueDate,
        status: r.status,
        statusLabel: STATUS_LABELS[r.status] ?? r.status,
      }));

      this.logger.debug(
        `查询应付账款：找到 ${total} 条，返回 ${simplified.length} 条`,
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

      this.logger.warn(`查询应付账款失败：${errorMsg}`);
      return {
        success: false,
        error: `查询应付账款失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: QueryPayablesArgs }
    | { valid: false; error: string; suggestion?: string } {
    let supplierId: number | undefined;
    if (args.supplierId !== undefined) {
      if (typeof args.supplierId !== 'number' || args.supplierId <= 0) {
        return {
          valid: false,
          error: '参数 supplierId 必须为正整数',
          suggestion: '请确认供应商ID',
        };
      }
      supplierId = args.supplierId;
    }

    let status: string | undefined;
    if (args.status !== undefined) {
      if (typeof args.status !== 'string') {
        return {
          valid: false,
          error: '参数 status 必须为字符串',
          suggestion: '请输入应付状态（PENDING/PARTIAL/PAID/OVERDUE）',
        };
      }
      status = args.status;
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    return { valid: true, data: { supplierId, status, page, pageSize } };
  }
}

/** 查询应付参数（解析后） */
interface QueryPayablesArgs {
  supplierId?: number;
  status?: string;
  page: number;
  pageSize: number;
}
