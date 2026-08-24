/**
 * 配送异常追踪巡检单元测试
 *
 * 覆盖：取货超时/配送超时两种详情、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { DeliveryAnomalyService } from './delivery-anomaly.service';
import { ProactivePush } from './proactive.types';

describe('DeliveryAnomalyService', () => {
  let service: DeliveryAnomalyService;
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
    service = new DeliveryAnomalyService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在取货超时与配送超时记录时推送', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 1,
          orderId: 100,
          deliveryNo: 'DD001',
          deliveryType: '达达',
          riderName: '张师傅',
          riderPhone: '1381234',
          status: 'PENDING',
          waitMinutes: 25,
          deliverMinutes: null,
        },
        {
          id: 2,
          orderId: 101,
          deliveryNo: 'DD002',
          deliveryType: '美团',
          riderName: '李师傅',
          riderPhone: '1395678',
          status: 'PICKED_UP',
          waitMinutes: null,
          deliverMinutes: 50,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('取货超时，已等待 25 分钟');
      expect(content).toContain('配送超时 50 分钟');
      expect(content).toContain(
        '| DD001 | 达达 | 张师傅（1381234） | PENDING | 取货超时，已等待 25 分钟 |',
      );
    });

    it('无配送单号时兜底显示订单 ID', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          id: 3,
          orderId: 102,
          deliveryNo: null,
          deliveryType: '闪送',
          riderName: null,
          riderPhone: null,
          status: 'ASSIGNED',
          waitMinutes: 40,
          deliverMinutes: null,
        },
      ]);

      await service.execute('tenant-1');

      const content = lastPushContent;
      expect(content).toContain(
        '| 102 | 闪送 | -（-） | ASSIGNED | 取货超时，已等待 40 分钟 |',
      );
    });

    it('无异常配送记录时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'delivery_anomaly',
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
          id: 4,
          orderId: 103,
          deliveryNo: 'DD003',
          deliveryType: '达达',
          riderName: '王师傅',
          riderPhone: '1370000',
          status: 'PICKED_UP',
          waitMinutes: null,
          deliverMinutes: 60,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('配送表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('配送表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
