/**
 * 智能补货建议巡检单元测试
 *
 * 覆盖：需补货/无需补货、紧急度三级、箱瓶换算兜底、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { ReplenishmentAdviceService } from './replenishment-advice.service';
import { ProactivePush } from './proactive.types';

describe('ReplenishmentAdviceService', () => {
  let service: ReplenishmentAdviceService;
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
    service = new ReplenishmentAdviceService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在需补货商品时生成建议并推送（三种紧急度）', async () => {
      dataSource.query.mockResolvedValueOnce([
        // 售罄：紧急
        {
          skuId: 1,
          skuName: '五粮液52度',
          warningThreshold: 20,
          currentStock: 0,
          dailyAvg: 8,
          boxRatio: 6,
        },
        // 低于安全线：建议
        {
          skuId: 2,
          skuName: '雪花啤酒',
          warningThreshold: 30,
          currentStock: 12,
          dailyAvg: 10,
          boxRatio: 24,
        },
        // 充足：不进入 needs（库存充足且销量低）
        {
          skuId: 3,
          skuName: '农夫山泉',
          warningThreshold: 10,
          currentStock: 500,
          dailyAvg: 1,
          boxRatio: 24,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('🔴 紧急');
      expect(content).toContain('⚠️ 建议');
      expect(content).toContain('| 五粮液52度 | 0 | 8.0 | 10 箱 | 🔴 紧急 |');
      // 雪花：阈值*2=60-12=48 瓶，日均*7=70-12=58 瓶 → 取 58 瓶 → 58/24≈2.41 → 3 箱
      expect(content).toContain('| 雪花啤酒 | 12 | 10.0 | 3 箱 | ⚠️ 建议 |');
      expect(content).not.toContain('农夫山泉');
      // 建议量合计 56 + 58 = 114 瓶
      expect(content).toContain('约 114 瓶');
    });

    it('boxRatio 为 0 时兜底按 1 换算', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 4,
          skuName: '散装酒',
          warningThreshold: 5,
          currentStock: 2,
          dailyAvg: 2,
          boxRatio: 0,
        },
      ]);

      await service.execute('tenant-1');

      const content = lastPushContent;
      // 阈值*2=10-2=8，日均*7=14-2=12 → 12 瓶，boxRatio fallback 1 → 12 箱
      expect(content).toContain('| 散装酒 | 2 | 2.0 | 12 箱 |');
    });

    it('所有商品库存充足时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 5,
          skuName: '茅台',
          warningThreshold: 10,
          currentStock: 100,
          dailyAvg: 1,
          boxRatio: 6,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'replenishment_advice',
        tenantId: 'tenant-1',
        found: 0,
        pushed: 0,
      });
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('查询返回空数组时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(pushService.push).not.toHaveBeenCalled();
    });

    it('推送失败时 pushed=0', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          skuId: 6,
          skuName: '商品X',
          warningThreshold: 10,
          currentStock: 1,
          dailyAvg: 3,
          boxRatio: 6,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('库存表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('库存表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
