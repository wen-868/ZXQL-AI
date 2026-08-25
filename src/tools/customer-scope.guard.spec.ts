/**
 * CustomerScopeGuard 单元测试（批次4，文档 10.1.8/13.3/25.4）
 *
 * 覆盖：非客户放行、客户缺 customerId 拒绝、读/写白名单放行、
 * 内部读/资金写越权 AI_010 拒绝（允许名单制，安全默认全拒）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import {
  CustomerScopeGuard,
  CUSTOMER_SCOPE_DENY_CODE,
} from './customer-scope.guard';

describe('CustomerScopeGuard', () => {
  it('非 customer 角色不拦截', () => {
    expect(
      CustomerScopeGuard.check(
        'queryInventory',
        { isWriteOperation: false },
        {
          role: 'admin',
        },
      ).ok,
    ).toBe(true);
  });

  it('customer 角色缺 customerId → AI_010 拒绝', () => {
    const result = CustomerScopeGuard.check(
      'api_query_my_orders',
      { isWriteOperation: false },
      { role: 'customer' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CUSTOMER_SCOPE_DENY_CODE);
  });

  it('客户读白名单（本人订单）放行', () => {
    const result = CustomerScopeGuard.check(
      'api_query_my_orders',
      { isWriteOperation: false },
      { role: 'customer', customerId: 'c1' },
    );
    expect(result.ok).toBe(true);
  });

  it('客户写白名单（退换货申请）放行', () => {
    const result = CustomerScopeGuard.check(
      'api_create_return_apply',
      { isWriteOperation: true },
      { role: 'customer', customerId: 'c1' },
    );
    expect(result.ok).toBe(true);
  });

  it('客户读内部库存工具 → AI_010 拒绝', () => {
    const result = CustomerScopeGuard.check(
      'queryInventory',
      { isWriteOperation: false },
      { role: 'customer', customerId: 'c1' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CUSTOMER_SCOPE_DENY_CODE);
    expect(result.error).toContain('AI_010');
  });

  it('客户调用资金/内部写工具（建销售单）→ AI_010 拒绝', () => {
    const result = CustomerScopeGuard.check(
      'createSalesOrder',
      { isWriteOperation: true },
      { role: 'customer', customerId: 'c1' },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(CUSTOMER_SCOPE_DENY_CODE);
    expect(result.suggestion).toContain('管理系统端');
  });

  it('未注册工具按非写处理：客户调用 → 拒绝（不在读白名单）', () => {
    const result = CustomerScopeGuard.check('some_unknown_tool', undefined, {
      role: 'customer',
      customerId: 'c1',
    });
    expect(result.ok).toBe(false);
  });
});
