/**
 * 客户流失预警巡检单元测试
 *
 * 覆盖：高风险/中风险/关注三级、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { CustomerChurnService } from './customer-churn.service';
import { ProactivePush } from './proactive.types';

describe('CustomerChurnService', () => {
  let service: CustomerChurnService;
  let dataSource: { query: jest.Mock };
  let pushService: { push: jest.Mock };
  /** 最近一次推送内容（由 push mock 捕获，类型安全） */
  let lastPushContent = '';

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    lastPushContent = '';
    pushService = {
      push: jest.fn(
        (_tenantId: string, _taskName: string, push: ProactivePush) => {
          lastPushContent = push.content;
          return true;
        },
      ),
    };
    service = new CustomerChurnService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在流失风险客户时推送（三种风险等级）', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 1,
          name: '兴旺超市',
          customerType: 'WHOLESALE',
          lastOrderAt: '2026-06-20',
          inactiveDays: 47,
        },
        {
          id: 2,
          name: '永辉便利店',
          customerType: 'RETAIL',
          lastOrderAt: '2026-06-28',
          inactiveDays: 32,
        },
        {
          id: 3,
          name: '天天超市',
          customerType: 'WHOLESALE',
          lastOrderAt: '2026-05-01',
          inactiveDays: 90,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(3);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('⚠️ 中');
      expect(content).toContain('📅 关注');
      expect(content).toContain('🔴 高');
      expect(content).toContain('| 兴旺超市 | 2026-06-20 | 47 天 | ⚠️ 中 |');
      expect(content).toContain('| 天天超市 | 2026-05-01 | 90 天 | 🔴 高 |');
    });

    it('客户名称为空时兜底显示"-"', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 4,
          name: null,
          customerType: 'RETAIL',
          lastOrderAt: '2026-07-01',
          inactiveDays: 30,
        },
      ]);

      await service.execute('tenant-1');

      const content = lastPushContent;
      expect(content).toContain('| - | 2026-07-01 | 30 天 | 📅 关注 |');
    });

    it('无流失风险客户时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'customer_churn',
        tenantId: 'tenant-1',
        found: 0,
        pushed: 0,
      });
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('查询返回 undefined 时不推送（!rows 分支）', async () => {
      dataSource.query.mockResolvedValueOnce(undefined);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('推送失败时 pushed=0', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 5,
          name: '客户X',
          customerType: 'RETAIL',
          lastOrderAt: '2026-06-01',
          inactiveDays: 60,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('客户表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('客户表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
