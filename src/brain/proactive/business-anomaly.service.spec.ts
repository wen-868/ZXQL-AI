/**
 * 经营异常检测巡检单元测试
 *
 * 覆盖：销售额偏低/偏高、订单量偏低、均值为 0 跳过、无异常、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { BusinessAnomalyService } from './business-anomaly.service';
import { NoticeService } from './notice.service';
import { ProactivePush } from './proactive.types';

/** 供 S4 反测：捕获 record() 入参 */
type RecordedNotice = Parameters<NoticeService['record']>[0];

describe('BusinessAnomalyService', () => {
  let service: BusinessAnomalyService;
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
    service = new BusinessAnomalyService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  /** mock 两个子查询：昨日汇总 + 近 30 天日均 */
  function mockQueries(
    yesterday: { salesAmount: number; orderCount: number },
    avg: { salesAmount: number; orderCount: number },
  ): void {
    dataSource.query
      .mockResolvedValueOnce([
        {
          salesAmount: yesterday.salesAmount,
          orderCount: yesterday.orderCount,
        },
      ])
      .mockResolvedValueOnce([
        { salesAmount: avg.salesAmount, orderCount: avg.orderCount },
      ]);
  }

  describe('execute', () => {
    it('销售额低于均值 50% 时触发异常', async () => {
      mockQueries(
        { salesAmount: 8500, orderCount: 5 },
        { salesAmount: 660000, orderCount: 540 },
      );

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('销售额异常偏低');
      expect(content).toContain('| 销售额 | ¥8,500 | ¥22,000 | -61% 🔴 |');
      expect(content).toContain('| 订单数 | 5 笔 | 18.0 笔 | -72% 🔴 |');
    });

    it('销售额高于均值 200% 时触发偏高异常', async () => {
      mockQueries(
        { salesAmount: 50000, orderCount: 20 },
        { salesAmount: 660000, orderCount: 540 },
      );

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('销售额异常偏高');
      expect(content).toContain('+127% 🔴');
    });

    it('销售额均值/订单均值为 0 时跳过对应判断（无异常）', async () => {
      mockQueries(
        { salesAmount: 1000, orderCount: 2 },
        { salesAmount: 0, orderCount: 0 },
      );

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'business_anomaly',
        tenantId: 'tenant-1',
        found: 0,
        pushed: 0,
      });
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('推送失败时 pushed=0', async () => {
      mockQueries(
        { salesAmount: 1000, orderCount: 2 },
        { salesAmount: 300000, orderCount: 600 },
      );
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(2);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('报表表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('报表表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });

  // ── R101-AI-43 S4：巡检"先落站内通知，再推送" ──
  describe('S4 站内通知（先落通知再推送）', () => {
    function makeService(recordImpl?: (n: RecordedNotice) => Promise<unknown>) {
      const recorded: RecordedNotice[] = [];
      const notice = {
        record: jest.fn((n: RecordedNotice) => {
          recorded.push(n);
          return recordImpl
            ? recordImpl(n)
            : Promise.resolve({ inserted: true });
        }),
      };
      const svc = new BusinessAnomalyService(
        dataSource as unknown as DataSource,
        pushService as unknown as ProactivePushService,
        notice as unknown as NoticeService,
      );
      return { svc, notice, recorded };
    }

    it('⑧ 触发异常时先落站内通知（receiver=tenant 令牌 / source=biz / dedupeKey 按日桶）', async () => {
      mockQueries(
        { salesAmount: 8500, orderCount: 5 },
        { salesAmount: 660000, orderCount: 540 },
      );
      const { svc, notice, recorded } = makeService();

      const result = await svc.execute('tenant-1');

      expect(notice.record).toHaveBeenCalledTimes(1);
      const n = recorded[0];
      expect(n.receiver).toBe('tenant:tenant-1');
      expect(n.source).toBe('biz');
      expect(n.title).toContain('经营异常');
      expect(n.refId).toBeNull();
      expect(n.dedupeKey).toBe(
        `business:tenant-1:${new Date().toISOString().slice(0, 10)}`,
      );
      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
    });

    it('⑨ 通知落库失败不得把巡检误报成失败（主次不倒置）', async () => {
      mockQueries(
        { salesAmount: 8500, orderCount: 5 },
        { salesAmount: 660000, orderCount: 540 },
      );
      const { svc, notice } = makeService(() =>
        Promise.reject(new Error('通知表不可用')),
      );

      const result = await svc.execute('tenant-1');

      expect(notice.record).toHaveBeenCalledTimes(1);
      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      expect(result.error).toBeUndefined();
      expect(pushService.push).toHaveBeenCalledTimes(1);
    });

    it('⑩ 未注入 NoticeService（@Optional）时巡检照常', async () => {
      mockQueries(
        { salesAmount: 8500, orderCount: 5 },
        { salesAmount: 660000, orderCount: 540 },
      );

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
    });
  });
});
