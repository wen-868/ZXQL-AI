/**
 * 订单异常巡检单元测试
 *
 * 覆盖：待支付积压 / 发货超时单独与组合、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { OrderAnomalyService } from './order-anomaly.service';
import { ProactivePush } from './proactive.types';

describe('OrderAnomalyService', () => {
  let service: OrderAnomalyService;
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
    service = new OrderAnomalyService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('同时存在积压与发货超时订单时合并推送', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          {
            orderNo: 'ORD20260801001',
            orderStatus: 'PENDING_PAYMENT',
            waitMinutes: 45,
          },
        ])
        .mockResolvedValueOnce([
          {
            orderNo: 'ORD20260801002',
            deliveryStatus: 'WAITING',
            paidHours: 3,
          },
        ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('发货超时（已支付超 2 小时未发货）');
      expect(content).toContain('订单积压（待支付超 30 分钟）');
      expect(content).toContain('| ORD20260801002 | WAITING | 3 小时 |');
      expect(content).toContain(
        '| ORD20260801001 | PENDING_PAYMENT | 45 分钟 |',
      );
    });

    it('仅发货超时订单时只推送发货超时区块', async () => {
      dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([
        {
          orderNo: 'ORD20260801003',
          deliveryStatus: 'WAITING',
          paidHours: 2,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('发货超时');
      expect(content).not.toContain('订单积压');
    });

    it('仅待支付积压时只推送积压区块', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          {
            orderNo: 'ORD20260801004',
            orderStatus: 'PENDING_PAYMENT',
            waitMinutes: 31,
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('订单积压');
      expect(content).not.toContain('发货超时');
    });

    it('无异常订单时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'order_anomaly',
        tenantId: 'tenant-1',
        found: 0,
        pushed: 0,
      });
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('查询返回 undefined 时兼容（?length 兜底）', async () => {
      dataSource.query.mockResolvedValueOnce(undefined).mockResolvedValueOnce([
        {
          orderNo: 'ORD20260801005',
          deliveryStatus: 'WAITING',
          paidHours: 5,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(1);
      expect(pushService.push).toHaveBeenCalledTimes(1);
    });

    it('推送失败时 pushed=0', async () => {
      dataSource.query
        .mockResolvedValueOnce([
          {
            orderNo: 'ORD20260801006',
            orderStatus: 'PENDING_PAYMENT',
            waitMinutes: 60,
          },
        ])
        .mockResolvedValueOnce([]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('订单表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('订单表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
