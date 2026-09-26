/**
 * 数字员工会话 ID 解析（记忆隔离的后端兜底）
 *
 * 背景（2026-09-27 核查发现）：设计文档 12.8.1 第 3 项声称"记忆前缀 emp_{uid}"已完成，
 * 但代码实现里 `emp_` 只出现在桌面端 `desktop/app/index.html`（`const cid='emp_'+employeeUid`）。
 * 后端 Orchestrator / MemoryManager **完全没有该前缀逻辑**，记忆 key 仍是
 * `(tenantId, [customerId,] sessionId)`——隔离靠的是**前端命名约定**，后端零强制。
 * 后果：任何非桌面端调用方（总台前端、API 直连）不遵循该约定时，不同数字员工会共用
 * 同一段会话记忆。
 *
 * 本模块把约定下沉到后端，并遵循两条约束：
 * 1. **幂等**：桌面端已经传 `emp_xxx`，后端不能再套一层前缀（否则变 `emp_emp_xxx`）；
 * 2. **不破坏显式传入的会话 ID**：调用方若明确传了自定义 conversationId，强行改写会让
 *    既有历史会话"断线"。这种情况只做标记（unscopedWarning）由调用方记录告警，不改数据。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-27
 */

/** 数字员工会话 ID 前缀（与桌面端约定一致） */
export const EMPLOYEE_SESSION_PREFIX = 'emp_';

/** 会话 ID 解析结果 */
export interface EmployeeConversationResult {
  /** 最终使用的会话 ID */
  conversationId: string;
  /** 是否处于员工维度隔离（以 emp_ 前缀存储） */
  scoped: boolean;
  /** 传入了员工身份，但会话 ID 未按员工隔离（调用方未遵循约定，需告警观测） */
  unscopedWarning: boolean;
}

/**
 * 解析数字员工维度的会话 ID
 *
 * @param input.conversationId 调用方传入的会话 ID（可空）
 * @param input.employeeUid    数字员工 UID（可空＝非员工会话）
 * @param input.generate       未传会话 ID 时的生成器（注入以便单测确定性）
 * @returns 解析结果
 */
export function resolveEmployeeConversationId(input: {
  conversationId?: string;
  employeeUid?: string;
  generate: () => string;
}): EmployeeConversationResult {
  const { conversationId, employeeUid, generate } = input;

  // 非员工会话：维持原行为
  if (!employeeUid) {
    return {
      conversationId: conversationId ?? generate(),
      scoped: false,
      unscopedWarning: false,
    };
  }

  // 员工会话且未指定会话 ID：后端兜底生成 emp_{uid}
  if (!conversationId) {
    return {
      conversationId: `${EMPLOYEE_SESSION_PREFIX}${employeeUid}`,
      scoped: true,
      unscopedWarning: false,
    };
  }

  // 幂等：调用方（如桌面端）已按约定加前缀，不重复套
  if (conversationId.startsWith(EMPLOYEE_SESSION_PREFIX)) {
    return { conversationId, scoped: true, unscopedWarning: false };
  }

  // 显式传入了非员工前缀的会话 ID：尊重调用方，但标记未按员工隔离
  return { conversationId, scoped: false, unscopedWarning: true };
}
