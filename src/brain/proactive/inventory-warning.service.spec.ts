/**
 * 库存预警巡检单元测试
 *
 * 覆盖：有/无低库存商品、预计售罄天数三种取值、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { InventoryWarningService } from './inventory-warning.service';
import { ProactivePush } from './proactive.types';

describe('InventoryWarningService', () => {
  let service: InventoryWarningService;
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
    service = new InventoryWarningService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在低库存商品时推送预警并返回 found/pushed', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 1,
          skuName: '五粮液52度',
          warningThreshold: 20,
          currentStock: 5,
          dailyAvg: 8,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'inventory_warning',
        tenantId: 'tenant-1',
        found: 1,
        pushed: 1,
      });
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM t_inventory_balance'),
        ['tenant-1', 'tenant-1'],
      );
      expect(pushService.push).toHaveBeenCalledWith(
        'tenant-1',
        'inventory_warning',
        expect.objectContaining({
          title: '⚠️ 库存预警',
          type: 'inventory',
          priority: 'urgent',
        }),
      );
      // 内容包含预计售罄天数（5/8 → 1 天）
      expect(lastPushContent).toContain('| 五粮液52度 | 5 | 20 | 8 | 1天 |');
    });

    it('库存为 0 时预计售罄显示"今天"', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 2,
          skuName: '红牛',
          warningThreshold: 15,
          currentStock: 0,
          dailyAvg: 5,
        },
      ]);

      await service.execute('tenant-1');

      expect(lastPushContent).toContain('今天 ⚠️');
    });

    it('日均销量为 0 时预计售罄显示"-"', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 3,
          skuName: '雪花啤酒',
          warningThreshold: 10,
          currentStock: 3,
          dailyAvg: 0,
        },
      ]);

      await service.execute('tenant-1');

      expect(lastPushContent).toContain('| 雪花啤酒 | 3 | 10 | 0 | - |');
    });

    it('查询返回空数组时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'inventory_warning',
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
          skuId: 1,
          skuName: '五粮液',
          warningThreshold: 20,
          currentStock: 5,
          dailyAvg: 8,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('DB 连接失败'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.pushed).toBe(0);
      expect(result.error).toContain('DB 连接失败');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
