/**
 * 数字员工会话 ID 解析单测（记忆隔离的后端兜底）
 *
 * 锁死三条契约：
 * 1. 员工会话未指定 conversationId → 后端生成 `emp_{uid}`（不再依赖前端约定）
 * 2. 调用方已传 `emp_xxx` → **幂等**，不得套成 `emp_emp_xxx`（桌面端现状）
 * 3. 调用方显式传了非员工前缀的会话 ID → 尊重原值（避免历史会话断线），但标记告警
 *
 * 负责人: AI底座 | 创建日期: 2026-09-27
 */
import {
  EMPLOYEE_SESSION_PREFIX,
  resolveEmployeeConversationId,
} from './employee-conversation';

describe('数字员工会话 ID 解析', () => {
  const generate = () => 'sess_generated_001';

  it('非员工会话：未传 ID 时用生成器，且不标记隔离', () => {
    const res = resolveEmployeeConversationId({ generate });
    expect(res.conversationId).toBe('sess_generated_001');
    expect(res.scoped).toBe(false);
    expect(res.unscopedWarning).toBe(false);
  });

  it('非员工会话：保留调用方传入的 ID', () => {
    const res = resolveEmployeeConversationId({
      conversationId: 'abc-123',
      generate,
    });
    expect(res.conversationId).toBe('abc-123');
    expect(res.scoped).toBe(false);
  });

  it('员工会话未指定 ID：后端兜底生成 emp_ 前缀', () => {
    const res = resolveEmployeeConversationId({
      employeeUid: 'emp_a',
      generate,
    });
    expect(res.conversationId).toBe('emp_emp_a');
    expect(res.scoped).toBe(true);
    expect(res.unscopedWarning).toBe(false);
  });

  it('幂等：调用方已传 emp_ 前缀时不得重复套前缀', () => {
    const res = resolveEmployeeConversationId({
      conversationId: 'emp_emp_a',
      employeeUid: 'emp_a',
      generate,
    });
    // 关键断言：桌面端现状就是传 emp_xxx，套两层会直接切断既有会话
    expect(res.conversationId).toBe('emp_emp_a');
    expect(res.conversationId).not.toBe('emp_emp_emp_a');
    expect(res.scoped).toBe(true);
    expect(res.unscopedWarning).toBe(false);
  });

  it('幂等：不同员工的 emp_ 会话互不干扰', () => {
    const a = resolveEmployeeConversationId({
      conversationId: 'emp_emp_a',
      employeeUid: 'emp_a',
      generate,
    });
    const b = resolveEmployeeConversationId({
      conversationId: 'emp_emp_b',
      employeeUid: 'emp_b',
      generate,
    });
    expect(a.conversationId).not.toBe(b.conversationId);
  });

  it('显式传入非员工前缀 ID：保留原值并标记未按员工隔离', () => {
    const res = resolveEmployeeConversationId({
      conversationId: 'my-custom-session',
      employeeUid: 'emp_a',
      generate,
    });
    // 尊重调用方：强行改写会让既有历史会话断线
    expect(res.conversationId).toBe('my-custom-session');
    expect(res.scoped).toBe(false);
    expect(res.unscopedWarning).toBe(true);
  });

  it('前缀常量与桌面端约定一致', () => {
    expect(EMPLOYEE_SESSION_PREFIX).toBe('emp_');
  });
});
