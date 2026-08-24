/**
 * 应收催收巡检单元测试
 *
 * 覆盖：逾期/即将到期/临近到期三种状态、空结果、查询异常、推送失败全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { ProactivePush } from './proactive.types';

describe('ReceivableReminderService', () => {
  let service: ReceivableReminderService;
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
    service = new ReceivableReminderService(
      dataSource as unknown as DataSource,
      pushService as unknown as ProactivePushService,
    );
  });

  describe('execute', () => {
    it('存在逾期/即将到期/临近到期账款时推送', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          billNo: 'SB001',
          customerName: '顺达批发',
          receivableAmount: 18500,
          unreceivedAmount: 18500,
          dueDate: '2026-07-15',
          remindStatus: 'OVERDUE',
          overdueDays: 15,
        },
        {
          billNo: 'SB002',
          customerName: '兴旺超市',
          receivableAmount: 8200,
          unreceivedAmount: 8200,
          dueDate: '2026-08-04',
          remindStatus: 'DUE_SOON',
          overdueDays: 2,
        },
        {
          billNo: 'SB003',
          customerName: '永辉便利店',
          receivableAmount: 3500,
          unreceivedAmount: 3500,
          dueDate: '2026-08-08',
          remindStatus: 'UPCOMING',
          overdueDays: 6,
        },
      ]);

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(3);
      expect(result.pushed).toBe(1);
      const content = lastPushContent;
      expect(content).toContain('🔴 已逾期 逾期 15 天');
      expect(content).toContain('⚠️ 即将到期 2 天后到期');
      expect(content).toContain('📅 临近到期 6 天后到期');
      // 合计待收 30200 / 逾期 18500（千分位）
      expect(content).toContain('合计待收：¥30,200 | 逾期：¥18,500');
    });

    it('remindStatus 未知时兜底显示原始状态', async () => {
      dataSource.query.mockResolvedValueOnce([
        {
          billNo: 'SB004',
          customerName: '客户A',
          unreceivedAmount: 100,
          dueDate: '2026-08-09',
          remindStatus: 'UNKNOWN',
          overdueDays: 7,
        },
      ]);

      await service.execute('tenant-1');

      const content = lastPushContent;
      expect(content).toContain('UNKNOWN 7 天后到期');
    });

    it('无待催账款时不推送', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const result = await service.execute('tenant-1');

      expect(result).toEqual({
        taskName: 'receivable_reminder',
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
          billNo: 'SB005',
          customerName: '客户B',
          unreceivedAmount: 200,
          dueDate: '2026-07-01',
          remindStatus: 'OVERDUE',
          overdueDays: 30,
        },
      ]);
      pushService.push.mockResolvedValueOnce(false);

      const result = await service.execute('tenant-1');

      expect(result.pushed).toBe(0);
      expect(result.found).toBe(1);
    });

    it('查询异常时返回 error 且不推送', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('应收表不可用'));

      const result = await service.execute('tenant-1');

      expect(result.found).toBe(0);
      expect(result.error).toContain('应收表不可用');
      expect(pushService.push).not.toHaveBeenCalled();
    });
  });
});
