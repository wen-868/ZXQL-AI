/**
 * 毛利异常检测巡检单元测试
 *
 * 覆盖：负毛利/低毛利两种展示、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { GrossMarginAnomalyService } from './gross-margin-anomaly.service';
import { ProactivePush } from './proactive.types';

describe('GrossMarginAnomalyService', () => {
  let service: GrossMarginAnomalyService;
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
    service = new GrossMarginAnomalyService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在低毛利与负毛利交易时推送', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          billNo: 'SB001',
          skuName: '五粮液52度',
          unitPrice: 850,
          costPrice: 830,
          marginRate: 2.4,
        },
        {
          billNo: 'SB002',
          skuName: '茅台',
          unitPrice: 100,
          costPrice: 120,
          marginRate: -20,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(2);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain(
        '| SB001 | 五粮液52度 | ¥850.00 | ¥830.00 | 2.4%（正常 25%） |',
      );
      expect(content).toContain(
        '| SB002 | 茅台 | ¥100.00 | ¥120.00 | -20.0%（负毛利） |',
      );
      expect(content).toContain('建议：确认是否价格录入错误');
    });

    it('无异常交易时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'gross_margin_anomaly',
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
          billNo: 'SB003',
          skuName: '商品Y',
          unitPrice: 50,
          costPrice: 48,
          marginRate: 4,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('销售明细表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('销售明细表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
