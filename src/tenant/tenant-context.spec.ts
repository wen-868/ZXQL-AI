/**
 * TenantContext 单元测试
 *
 * 验证 AsyncLocalStorage 的进入/获取/异步链路传递/require 等核心能力。
 */
import { TenantContext, TenantContextData } from './tenant-context';

describe('TenantContext', () => {
  let context: TenantContext;

  beforeEach(() => {
    context = new TenantContext();
  });

  const sampleData: TenantContextData = {
    tenantId: 'tenant-001',
    userId: 'user-123',
    role: 'STORE_MANAGER',
    authToken: 'jwt-token-abc',
  };

  describe('isActive', () => {
    it('未进入上下文时应返回 false', () => {
      expect(context.isActive()).toBe(false);
    });

    it('进入上下文后应返回 true', () => {
      context.run(sampleData, () => {
        expect(context.isActive()).toBe(true);
      });
    });

    it('退出上下文后应恢复 false', () => {
      context.run(sampleData, () => {
        // 在上下文内
      });
      // 退出后
      expect(context.isActive()).toBe(false);
    });
  });

  describe('getTenantId', () => {
    it('未进入上下文应返回 undefined', () => {
      expect(context.getTenantId()).toBeUndefined();
    });

    it('进入上下文应返回 tenantId', () => {
      context.run(sampleData, () => {
        expect(context.getTenantId()).toBe('tenant-001');
      });
    });
  });

  describe('异步链路传递', () => {
    it('Promise 链路中应能获取 tenantId', async () => {
      await context.run(sampleData, async () => {
        const result = await Promise.resolve().then(() => {
          return context.getTenantId();
        });
        expect(result).toBe('tenant-001');
      });
    });

    it('setTimeout 回调中应能获取 tenantId', (done) => {
      context.run(sampleData, () => {
        setTimeout(() => {
          expect(context.getTenantId()).toBe('tenant-001');
          done();
        }, 10);
      });
    });
  });

  describe('require', () => {
    it('未在上下文中应抛异常', () => {
      expect(() => context.require()).toThrow('当前不在租户上下文中');
    });

    it('在上下文中应返回数据', () => {
      context.run(sampleData, () => {
        expect(context.require()).toEqual(sampleData);
      });
    });
  });

  describe('getData', () => {
    it('应返回完整上下文数据', () => {
      context.run(sampleData, () => {
        const data = context.getData();
        expect(data).toBeDefined();
        expect(data?.tenantId).toBe('tenant-001');
        expect(data?.userId).toBe('user-123');
        expect(data?.role).toBe('STORE_MANAGER');
        expect(data?.authToken).toBe('jwt-token-abc');
      });
    });
  });

  describe('嵌套 run', () => {
    it('嵌套 run 应覆盖外层数据', () => {
      const outerData: TenantContextData = { tenantId: 'outer' };
      const innerData: TenantContextData = { tenantId: 'inner' };

      context.run(outerData, () => {
        expect(context.getTenantId()).toBe('outer');
        context.run(innerData, () => {
          expect(context.getTenantId()).toBe('inner');
        });
        expect(context.getTenantId()).toBe('outer');
      });
    });
  });

  describe('便捷方法', () => {
    it('getUserId 应返回 userId', () => {
      context.run(sampleData, () => {
        expect(context.getUserId()).toBe('user-123');
      });
    });

    it('getRole 应返回 role', () => {
      context.run(sampleData, () => {
        expect(context.getRole()).toBe('STORE_MANAGER');
      });
    });

    it('getAuthToken 应返回 authToken', () => {
      context.run(sampleData, () => {
        expect(context.getAuthToken()).toBe('jwt-token-abc');
      });
    });

    it('getCustomerId 应返回 customerId（运营客户端）', () => {
      context.run(
        { tenantId: 'tenant-001', role: 'customer', customerId: 'c-100' },
        () => {
          expect(context.getCustomerId()).toBe('c-100');
        },
      );
    });

    it('isCustomer：role=customer 为 true，否则 false', () => {
      context.run(
        { tenantId: 'tenant-001', role: 'customer', customerId: 'c-100' },
        () => {
          expect(context.isCustomer()).toBe(true);
        },
      );
      context.run({ tenantId: 'tenant-001', role: 'admin' }, () => {
        expect(context.isCustomer()).toBe(false);
      });
    });
  });
});
