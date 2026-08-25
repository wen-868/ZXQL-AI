/**
 * CustomerScopeGuard — 运营客户端数据/写闸门边界（批次4，文档 10.1.8 / 13.3 / 25.4）
 *
 * 原则：role=customer 时「仅本人 customerScope」——可读仅限本人订单/物流/会员/适用价，
 * 可写仅限退换货申请/咨询单/收货确认/营销订阅（受控 WriteGuard，确认人=本人），
 * 其余任何工具（内部经营/成本/其他客户/资金/改价/建销售单）一律 AI_010 拒绝。
 *
 * 安全默认：允许名单制。运营工具集（P2-1，30 个）接入前，客户身份默认全拒，
 * 绝不因名单未配而放行内部工具。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */

/** 运营客户端可读工具白名单（仅本人 customerScope 数据；工具名对齐 P2-1 运营工具集） */
export const CUSTOMER_READ_ALLOW: string[] = [
  'api_query_my_orders', // 本人订单
  'api_query_my_order_detail', // 本人订单详情
  'api_query_my_deliveries', // 本人物流
  'api_query_my_membership', // 会员权益
  'api_query_my_prices', // 本人适用价
  'api_query_my_returns', // 本人退换货单
  'api_query_my_invoices', // 本人对账/账单
];

/** 运营客户端可写工具白名单（受控 WriteGuard，确认人=本人） */
export const CUSTOMER_WRITE_ALLOW: string[] = [
  'api_create_return_apply', // 退换货申请
  'api_create_consult', // 咨询单
  'api_confirm_receipt', // 收货确认
  'api_set_marketing_subscription', // 营销订阅/消息授权
];

/** 越权统一错误码（文档 11.5 AI_010） */
export const CUSTOMER_SCOPE_DENY_CODE = 'AI_010';

/** 检查输入（ToolContext 子集） */
export interface CustomerScopeCheckInput {
  role?: string;
  customerId?: string;
}

/** 检查结果 */
export interface CustomerScopeCheckResult {
  ok: boolean;
  /** 拒绝时携带错误码（AI_010） */
  code?: string;
  error?: string;
  suggestion?: string;
}

export class CustomerScopeGuard {
  /**
   * 检查某工具是否允许当前客户身份调用
   *
   * - 非 customer 角色：不拦截（管理端走原有 scope 逻辑）
   * - customer 角色：要求 customerId 完整，且工具在白名单（读/写分别校验）
   */
  static check(
    toolName: string,
    tool: { isWriteOperation?: boolean } | undefined,
    input: CustomerScopeCheckInput,
  ): CustomerScopeCheckResult {
    if (input.role !== 'customer') {
      return { ok: true };
    }
    if (!input.customerId) {
      return {
        ok: false,
        code: CUSTOMER_SCOPE_DENY_CODE,
        error: '运营客户端身份不完整：缺少 customerId，无法建立客户数据边界',
        suggestion: '请使用绑定的客户身份重新登录后重试',
      };
    }
    const allow =
      tool?.isWriteOperation === true
        ? CUSTOMER_WRITE_ALLOW
        : CUSTOMER_READ_ALLOW;
    if (allow.includes(toolName)) {
      return { ok: true };
    }
    return {
      ok: false,
      code: CUSTOMER_SCOPE_DENY_CODE,
      error: `AI_010 无权限执行此操作：运营客户端仅可访问本人数据与受控写操作，「${toolName}」不在客户授权范围`,
      suggestion: '该操作需在管理系统端由内部人员执行',
    };
  }
}
