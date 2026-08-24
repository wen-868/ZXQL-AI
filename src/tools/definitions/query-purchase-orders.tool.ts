/**
 * queryPurchaseOrders 工具 — 查询采购单列表（只读）
 *
 * 用途：按供应商、状态、时间范围等条件查询采购单列表。
 *
 * 对应后端 API：GET /api/admin/purchase-orders?supplierId=&orderStatus=&dateStart=&dateEnd=&page=&pageSize=
 * 后端路由：purchase.routes.ts（prefix: /api/admin/purchase-orders，listPurchaseOrders）
 * 后端服务：purchase-order.service.ts listPurchaseOrders
 *
 * 返回结构（以 purchase-order.service.ts listPurchaseOrders 为准，records 字段）：
 * { total, page, pageSize, records: [{ orderNo, supplierId, supplierName, storeId, orderStatus,
 *   goodsAmount, taxAmount, payableAmount, paidAmount, unpaidAmount, expectedDate, actualDate,
 *   operatorId, auditorId, remark, createdAt }] }
 *
 * 采购单状态枚举（order_status）：
 * - DRAFT：草稿（已创建未提交）
 * - PENDING：待审核（已提交）
 * - APPROVED：已审核通过
 * - REJECTED：已驳回
 * - CANCELLED：已取消
 * - COMPLETED：已完成（已入库）
 *
 * 参数说明：
 * - supplierId：供应商ID（可选）
 * - orderStatus：采购单状态（可选，见枚举）
 * - dateStart/dateEnd：创建时间范围（可选，格式 YYYY-MM-DD）
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

/** 后端返回的采购单列表项 */
interface PurchaseOrderItem {
  id: number;
  orderNo: string;
  supplierId: number;
  supplierName: string;
  storeId: number;
  orderStatus: string;
  goodsAmount: number;
  taxAmount: number;
  payableAmount: number;
  paidAmount: number;
  unpaidAmount: number;
  expectedDate: string | null;
  actualDate: string | null;
  remark: string | null;
  createdAt: string;
}

/** 后端返回的分页结构（records 字段） */
interface PurchaseOrderPage {
  total: number;
  page: number;
  pageSize: number;
  records: PurchaseOrderItem[];
}

/** 采购单状态中文标签 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  DRAFT: '草稿',
  PENDING: '待审核',
  APPROVED: '已审核通过',
  REJECTED: '已驳回',
  CANCELLED: '已取消',
  COMPLETED: '已完成',
};

@Injectable()
export class QueryPurchaseOrdersTool implements ITool {
  private readonly logger = new Logger(QueryPurchaseOrdersTool.name);

  readonly name = 'queryPurchaseOrders';
  readonly description =
    '查询采购单列表：可按供应商ID、采购单状态、创建时间范围筛选，返回采购单的' +
    '单号、供应商、状态（DRAFT=草稿/PENDING=待审核/APPROVED=已通过/REJECTED=已驳回/CANCELLED=已取消/COMPLETED=已完成）、' +
    '含税金额、未付金额、期望到货日期、创建时间。' +
    '适合"最近有哪些采购单""查一下7月的采购单""红星酒业的采购单"等场景。' +
    '示例参数：{"orderStatus":"PENDING"}、{"supplierId":3}、{"dateStart":"2026-07-01","dateEnd":"2026-07-31"}';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: {
        type: 'number',
        description: '供应商ID（可选，按供应商筛选）',
      },
      orderStatus: {
        type: 'string',
        enum: [
          'DRAFT',
          'PENDING',
          'APPROVED',
          'REJECTED',
          'CANCELLED',
          'COMPLETED',
        ],
        description:
          '采购单状态（可选）：DRAFT=草稿、PENDING=待审核、APPROVED=已审核通过、REJECTED=已驳回、CANCELLED=已取消、COMPLETED=已完成',
      },
      dateStart: {
        type: 'string',
        description: '开始日期（可选，格式 YYYY-MM-DD，按创建时间筛选）',
      },
      dateEnd: {
        type: 'string',
        description: '结束日期（可选，格式 YYYY-MM-DD，按创建时间筛选）',
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

    const { supplierId, orderStatus, dateStart, dateEnd, page, pageSize } =
      parsed.data;

    // 组装查询参数
    const queryParams: string[] = [];
    if (supplierId !== undefined) {
      queryParams.push(`supplierId=${supplierId}`);
    }
    if (orderStatus) {
      queryParams.push(`orderStatus=${orderStatus}`);
    }
    if (dateStart) {
      queryParams.push(`dateStart=${dateStart}`);
    }
    if (dateEnd) {
      queryParams.push(`dateEnd=${dateEnd}`);
    }
    queryParams.push(`page=${page}`, `pageSize=${pageSize}`);

    const queryString = queryParams.join('&');

    try {
      const result = await this.serviceClient.get<PurchaseOrderPage>(
        `${API_ENDPOINTS.PURCHASE_ORDERS}?${queryString}`,
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
            message: `未找到${this.buildFilterDesc(parsed.data)}的采购单`,
          },
        };
      }

      // 精简返回
      const simplified = records.map((p) => ({
        orderNo: p.orderNo,
        supplierId: p.supplierId,
        supplierName: p.supplierName,
        storeId: p.storeId,
        orderStatus: p.orderStatus,
        orderStatusLabel: ORDER_STATUS_LABELS[p.orderStatus] ?? p.orderStatus,
        goodsAmount: p.goodsAmount,
        taxAmount: p.taxAmount,
        payableAmount: p.payableAmount,
        unpaidAmount: p.unpaidAmount,
        expectedDate: p.expectedDate,
        remark: p.remark,
        createdAt: p.createdAt,
      }));

      this.logger.debug(
        `查询采购单${this.buildFilterDesc(parsed.data)}：找到 ${total} 条，返回 ${simplified.length} 条`,
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

      this.logger.warn(`查询采购单失败：${errorMsg}`);
      return {
        success: false,
        error: `查询采购单失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: QueryPurchaseArgs }
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

    let orderStatus: string | undefined;
    if (args.orderStatus !== undefined) {
      if (typeof args.orderStatus !== 'string') {
        return {
          valid: false,
          error: '参数 orderStatus 必须为字符串',
          suggestion:
            '请输入采购单状态（DRAFT/PENDING/APPROVED/REJECTED/CANCELLED/COMPLETED）',
        };
      }
      orderStatus = args.orderStatus;
    }

    let dateStart: string | undefined;
    if (args.dateStart !== undefined) {
      if (
        typeof args.dateStart !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.dateStart)
      ) {
        return {
          valid: false,
          error: '参数 dateStart 格式必须为 YYYY-MM-DD',
          suggestion: '请按 YYYY-MM-DD 格式输入开始日期，如 2026-07-01',
        };
      }
      dateStart = args.dateStart;
    }

    let dateEnd: string | undefined;
    if (args.dateEnd !== undefined) {
      if (
        typeof args.dateEnd !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.dateEnd)
      ) {
        return {
          valid: false,
          error: '参数 dateEnd 格式必须为 YYYY-MM-DD',
          suggestion: '请按 YYYY-MM-DD 格式输入结束日期，如 2026-07-31',
        };
      }
      dateEnd = args.dateEnd;
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    return {
      valid: true,
      data: { supplierId, orderStatus, dateStart, dateEnd, page, pageSize },
    };
  }

  /** 生成筛选条件的中文描述（用于空结果提示） */
  private buildFilterDesc(args: QueryPurchaseArgs): string {
    const parts: string[] = [];
    if (args.supplierId !== undefined) parts.push(`供应商 ${args.supplierId}`);
    if (args.orderStatus) {
      parts.push(
        `状态${ORDER_STATUS_LABELS[args.orderStatus] ?? args.orderStatus}`,
      );
    }
    if (args.dateStart && args.dateEnd) {
      parts.push(`${args.dateStart} 至 ${args.dateEnd}`);
    } else if (args.dateStart) {
      parts.push(`${args.dateStart} 之后`);
    } else if (args.dateEnd) {
      parts.push(`${args.dateEnd} 之前`);
    }
    return parts.length > 0 ? parts.join('、') : '当前条件';
  }
}

/** 查询采购单参数（解析后） */
interface QueryPurchaseArgs {
  supplierId?: number;
  orderStatus?: string;
  dateStart?: string;
  dateEnd?: string;
  page: number;
  pageSize: number;
}
