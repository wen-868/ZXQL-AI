/**
 * searchCustomer 工具 — 搜索客户
 *
 * 用途：按名称或手机号搜索客户，返回客户列表（含类型、信用额度、欠款）。
 * LLM 在创建销售单前用此工具查找客户 ID。
 *
 * 对应后端 API：GET /api/admin/members?keyword=xxx&page=1&pageSize=20
 * 后端路由：admin-customer.routes.ts（prefix: /api/admin）
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

/** 后端返回的客户列表项 */
interface CustomerListItem {
  memberId: number;
  name: string;
  mobile: string;
  customerType: string;
  address: string | null;
  settlementType: string | null;
  remark: string | null;
  points: number;
  levelCode: string | null;
  status: string;
  staffId: number | null;
  staffName: string | null;
  totalSpent: number;
  arrears: number;
}

/** 后端返回的分页结构（listMembers 返回 records 字段，list 为兼容旧形态） */
interface PaginatedResult<T> {
  list?: T[];
  records?: T[];
  total: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class SearchCustomerTool implements ITool {
  private readonly logger = new Logger(SearchCustomerTool.name);

  readonly name = 'searchCustomer';
  readonly description =
    '搜索客户（按名称或手机号模糊匹配）。' +
    '返回客户列表，包含客户ID、名称、手机号、客户类型（CASH=散客/WHOLESALE=批发/VIP=VIP客户）、累计消费、欠款金额。' +
    '在创建销售单前，用此工具查找客户的 memberId。' +
    '示例：用户说"红星商行"→ 调用此工具 → 获取 memberId → 传给 createSalesOrder。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: {
        type: 'string',
        description: '搜索关键词（客户名称或手机号，模糊匹配）',
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
        suggestion: '请传入客户名称或手机号作为搜索关键词',
      };
    }

    const page = typeof args.page === 'number' ? args.page : 1;
    const pageSize =
      typeof args.pageSize === 'number' ? Math.min(args.pageSize, 50) : 20;

    try {
      const result = await this.serviceClient.get<
        PaginatedResult<CustomerListItem>
      >(
        `${API_ENDPOINTS.CUSTOMERS}?keyword=${encodeURIComponent(keyword)}&page=${page}&pageSize=${pageSize}`,
        context,
      );

      // R70-11 修复：真实后端 listMembers 返回 records 字段（非 list），双字段兼容
      const customers = result?.records ?? result?.list ?? [];
      const total = result?.total ?? 0;

      if (customers.length === 0) {
        return {
          success: true,
          data: {
            list: [],
            total: 0,
            message: `未找到匹配"${keyword}"的客户`,
            suggestion: `未找到客户「${keyword}」。若当前是创建销售单的流程，直接调用 createSalesOrder 并传入 customerName="${keyword}"，工具会自动创建客户；无需单独调用 createCustomer。`,
          },
        };
      }

      // 精简返回字段，避免 LLM 上下文过长
      const simplified = customers.map((c) => ({
        memberId: c.memberId,
        name: c.name,
        mobile: c.mobile,
        customerType: c.customerType,
        customerTypeLabel: this.translateCustomerType(c.customerType),
        arrears: c.arrears,
        totalSpent: c.totalSpent,
        status: c.status,
      }));

      this.logger.debug(
        `搜索客户"${keyword}"：找到 ${total} 条，返回 ${simplified.length} 条`,
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

      this.logger.warn(`搜索客户失败：${errorMsg}`);
      return {
        success: false,
        error: `搜索客户失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 将客户类型代码转为中文标签 */
  private translateCustomerType(type: string): string {
    const map: Record<string, string> = {
      CASH: '散客（零售）',
      WHOLESALE: '批发客户',
      VIP: 'VIP客户',
    };
    return map[type] ?? type;
  }
}
