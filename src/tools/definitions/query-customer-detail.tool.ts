/**
 * queryCustomerDetail 工具 — 查询客户详情（精确查询，只读）
 *
 * 用途：按 customerId 精确查询单个客户的完整信息（基本信息 + 客户类型 + 结算方式 + 积分/等级 + 所属业务员 + 备注）。
 * 与 searchCustomer 的区别：
 * - searchCustomer：keyword 必填，模糊搜索客户列表（返回精简字段）
 * - queryCustomerDetail：customerId 必填，精确查询单个客户详情（返回完整字段）
 *
 * 对应后端 API：GET /api/admin/members/:id
 * 后端路由：admin-customer.routes.ts（prefix: /api/admin，getCustomerDetail）
 * 后端服务：customer.service.ts getCustomerDetail（返回 MemberDetailRow，不存在时抛 404）
 *
 * 返回字段（以 customer.service.ts getCustomerDetail 为准）：
 * memberId/name/mobile/customerType/address/settlementType/remark/
 * points/levelCode/status/staffId/staffName
 *
 * 注意：customerId 可从 searchCustomer 返回的 memberId 字段获取。
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

/** 后端返回的客户详情（customer.service.ts getCustomerDetail） */
interface CustomerDetail {
  memberId: number;
  name: string;
  mobile: string;
  customerType: string;
  address: string | null;
  settlementType: string | null;
  remark: string | null;
  points: number;
  levelCode: string;
  status: number | string;
  staffId: number | null;
  staffName: string | null;
}

@Injectable()
export class QueryCustomerDetailTool implements ITool {
  private readonly logger = new Logger(QueryCustomerDetailTool.name);

  readonly name = 'queryCustomerDetail';
  readonly description =
    '查询客户详情（精确查询）：按 customerId 查询单个客户的完整信息，' +
    '返回客户名称、手机号、客户类型（CASH=散客/WHOLESALE=批发/VIP=VIP客户）、' +
    '地址、结算方式（CASH/ACCOUNT）、积分、等级、状态、所属业务员、备注。' +
    '与 searchCustomer 的区别：searchCustomer 按关键词模糊搜索客户列表；' +
    '本工具按 customerId 精确查询单个客户详情。customerId 可从 searchCustomer 返回的 memberId 字段获取。' +
    '适合"红星商行的详细信息""这个客户的结算方式和信用情况"等场景。' +
    '示例参数：{"customerId":1}';
  readonly category = 'customer' as const;
  readonly isWriteOperation = false;
  readonly requiredTools = ['searchCustomer'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: {
        type: 'number',
        description:
          '客户ID（必填，正整数，从 searchCustomer 返回的 memberId 字段获取）',
      },
    },
    required: ['customerId'],
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

    const customerId = parsed.data.customerId;

    try {
      const detail = await this.serviceClient.get<CustomerDetail>(
        `${API_ENDPOINTS.CUSTOMERS}/${customerId}`,
        context,
      );

      if (!detail || typeof detail !== 'object') {
        return {
          success: false,
          error: `查询客户详情失败：后端返回空数据（customerId=${customerId}）`,
          suggestion: '请确认 customerId 是否正确',
        };
      }

      // 精简返回：客户详情完整字段
      const simplified = {
        customerId: detail.memberId,
        name: detail.name,
        mobile: detail.mobile,
        customerType: detail.customerType,
        customerTypeLabel: this.translateCustomerType(detail.customerType),
        address: detail.address,
        settlementType: detail.settlementType,
        settlementTypeLabel: this.translateSettlementType(
          detail.settlementType,
        ),
        points: detail.points,
        levelCode: detail.levelCode,
        status: detail.status,
        staffId: detail.staffId,
        staffName: detail.staffName,
        remark: detail.remark,
      };

      this.logger.debug(
        `查询客户详情：customerId=${customerId} name=${detail.name}`,
      );

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

      this.logger.warn(`查询客户详情失败：${errorMsg}`);
      return {
        success: false,
        error: `查询客户详情失败：${errorMsg}`,
        suggestion:
          '请确认 customerId 是否正确（customerId 可从 searchCustomer 返回的 memberId 获取），或后端服务是否正常运行',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: { customerId: number } }
    | { valid: false; error: string; suggestion?: string } {
    const customerId = args.customerId;
    if (typeof customerId !== 'number' || customerId <= 0) {
      return {
        valid: false,
        error: '参数 customerId 必须为正整数',
        suggestion:
          '请先调用 searchCustomer 搜索客户，从返回结果的 memberId 字段获取',
      };
    }

    return { valid: true, data: { customerId } };
  }

  /** 将客户类型代码转为中文标签（与 searchCustomer 一致） */
  private translateCustomerType(type: string): string {
    const map: Record<string, string> = {
      CASH: '散客（零售）',
      WHOLESALE: '批发客户',
      VIP: 'VIP客户',
    };
    return map[type] ?? type;
  }

  /** 将结算方式代码转为中文标签 */
  private translateSettlementType(type: string | null): string {
    const map: Record<string, string> = {
      CASH: '现金结算',
      ACCOUNT: '账期结算',
    };
    if (type === null || type === undefined) return '未知';
    return map[type] ?? type;
  }
}
