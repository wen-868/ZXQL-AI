/**
 * 每日经营简报巡检单元测试
 *
 * 覆盖：待办组合、销售环比上升/下降、无待办、查询空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { DailyBriefingService } from './daily-briefing.service';
import { ProactivePush } from './proactive.types';

describe('DailyBriefingService', () => {
  let service: DailyBriefingService;
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
    service = new DailyBriefingService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  /** 组装 6 个子查询的 mock 返回值（按 Promise.all 调用顺序） */
  function mockQueries(options: {
    yesterday?: { salesAmount?: number; orderCount?: number };
    today?: { salesAmount?: number; orderCount?: number };
    pending?: number;
    warning?: number;
    overdue?: number;
    delivery?: number;
  }): void {
    dataSource.query
      .mockResolvedValueOnce([
        {
          salesAmount: options.yesterday?.salesAmount ?? 0,
          orderCount: options.yesterday?.orderCount ?? 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          salesAmount: options.today?.salesAmount ?? 0,
          orderCount: options.today?.orderCount ?? 0,
        },
      ])
      .mockResolvedValueOnce([{ cnt: options.pending ?? 0 }])
      .mockResolvedValueOnce([{ cnt: options.warning ?? 0 }])
      .mockResolvedValueOnce([{ cnt: options.overdue ?? 0 }])
      .mockResolvedValueOnce([{ cnt: options.delivery ?? 0 }]);
  }

  describe('execute', () => {
    it('存在待办事项时生成简报并推送', async () => {
      mockQueries({
        yesterday: { salesAmount: 23500, orderCount: 18 },
        today: { salesAmount: 0, orderCount: 0 },
        pending: 3,
        warning: 2,
        overdue: 1,
        delivery: 1,
      });

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(7);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('📈 昨日回顾');
      expect(content).toContain('| 昨日销售额 | ¥23,500 | -100% |');
      expect(content).toContain('1. ⚠️ 3 笔订单待处理');
      expect(content).toContain('2. ⚠️ 2 个商品库存不足需补货');
      expect(content).toContain('3. 💰 1 笔应收已逾期');
      expect(content).toContain('4. 🚚 1 单配送异常待处理');
      expect(content).toContain(
        '1. 有 2 个商品库存低于安全线，建议今日安排补货',
      );
    });

    it('销售环比下降时生成负偏差建议', async () => {
      mockQueries({
        yesterday: { salesAmount: 10000, orderCount: 10 },
        today: { salesAmount: 4000, orderCount: 5 },
        pending: 0,
        warning: 0,
        overdue: 0,
        delivery: 0,
      });

      await service.execute('tenant-1');

      const content = lastPushContent;
      // 环比 (4000-10000)/10000 = -60%
      expect(content).toContain('-60% |');
      expect(content).toContain('当前销售额低于昨日 60%');
    });

    it('销售环比上升时显示 + 号', async () => {
      mockQueries({
        yesterday: { salesAmount: 10000, orderCount: 10 },
        today: { salesAmount: 12000, orderCount: 12 },
        pending: 0,
        warning: 0,
        overdue: 0,
        delivery: 0,
      });

      await service.execute('tenant-1');

      const content = lastPushContent;
      expect(content).toContain('+20% |');
      expect(content).toContain('经营数据平稳，暂无特别建议');
    });

    it('昨日销售额为 0 时环比显示"-"', async () => {
      mockQueries({
        yesterday: { salesAmount: 0, orderCount: 0 },
        today: { salesAmount: 500, orderCount: 1 },
        pending: 0,
        warning: 0,
        overdue: 0,
        delivery: 0,
      });

      await service.execute('tenant-1');

      const content = lastPushContent;
      expect(content).toContain('| - |');
      expect(content).toContain('暂无待办事项，经营状态良好');
    });

    it('子查询返回空数组时兜底为 0（rows?.[0] 分支）', async () => {
      dataSource.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      const content = lastPushContent;
      expect(content).toContain('暂无待办事项');
    });

    it('推送失败时 pushed=0', async () => {
      mockQueries({
        yesterday: { salesAmount: 100, orderCount: 1 },
        today: { salesAmount: 100, orderCount: 1 },
        pending: 1,
        warning: 0,
        overdue: 0,
        delivery: 0,
      });
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('销售表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('销售表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
