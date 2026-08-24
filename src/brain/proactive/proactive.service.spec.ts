/**
 * ProactiveService 调度器单元测试
 *
 * 覆盖：9 个任务注册、listJobs、runJob（存在/不存在）、runForAllTenants
 * （正常/无租户/租户列表异常/单租户异常/防重入）、9 个 @Cron 方法
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import type { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { ProactiveService } from './proactive.service';
import { IProactiveTask, ProactiveTaskResult, Row } from './proactive.types';
import { InventoryWarningService } from './inventory-warning.service';
import { OrderAnomalyService } from './order-anomaly.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { DailyBriefingService } from './daily-briefing.service';
import { BusinessAnomalyService } from './business-anomaly.service';
import { ReplenishmentAdviceService } from './replenishment-advice.service';
import { DeliveryAnomalyService } from './delivery-anomaly.service';
import { CustomerChurnService } from './customer-churn.service';
import { GrossMarginAnomalyService } from './gross-margin-anomaly.service';

describe('ProactiveService', () => {
  let service: ProactiveService;
  let dataSource: { query: jest.Mock };
  let tasks: IProactiveTask[];

  /** 构造 9 个 fake 巡检任务（execute 为 jest mock） */
  function createFakeTask(name: string): IProactiveTask {
    return {
      name,
      description: `${name} 描述`,
      scheduleType: 'cron' as const,
      schedule: '*/30 * * * *',
      priority: 'important' as const,
      pushType: 'system' as const,
      execute: jest.fn().mockResolvedValue({
        taskName: name,
        tenantId: 'tenant-1',
        found: 0,
        pushed: 0,
      } satisfies ProactiveTaskResult),
    };
  }

  beforeEach(() => {
    dataSource = { query: jest.fn() };
    tasks = [
      'inventory_warning',
      'order_anomaly',
      'receivable_reminder',
      'daily_briefing',
      'business_anomaly',
      'replenishment_advice',
      'delivery_anomaly',
      'customer_churn',
      'gross_margin_anomaly',
    ].map(createFakeTask);

    service = new ProactiveService(
      dataSource as unknown as DataSource,
      tasks[0] as unknown as InventoryWarningService,
      tasks[1] as unknown as OrderAnomalyService,
      tasks[2] as unknown as ReceivableReminderService,
      tasks[3] as unknown as DailyBriefingService,
      tasks[4] as unknown as BusinessAnomalyService,
      tasks[5] as unknown as ReplenishmentAdviceService,
      tasks[6] as unknown as DeliveryAnomalyService,
      tasks[7] as unknown as CustomerChurnService,
      tasks[8] as unknown as GrossMarginAnomalyService,
    );
  });

  describe('tasks', () => {
    it('注册 9 个巡检任务且顺序正确', () => {
      expect(service.tasks).toHaveLength(9);
      expect(service.tasks.map((t) => t.name)).toEqual([
        'inventory_warning',
        'order_anomaly',
        'receivable_reminder',
        'daily_briefing',
        'business_anomaly',
        'replenishment_advice',
        'delivery_anomaly',
        'customer_churn',
        'gross_margin_anomaly',
      ]);
    });
  });

  describe('listJobs', () => {
    it('返回全部任务的调度信息', () => {
      const jobs = service.listJobs();
      expect(jobs).toHaveLength(9);
      expect(jobs[0]).toEqual(
        expect.objectContaining({
          name: 'inventory_warning',
          scheduleType: 'cron',
          priority: 'important',
        }),
      );
      expect(jobs[0].lastRunAt).toBeUndefined();
    });

    it('运行后记录 lastRunAt 与 lastResult', async () => {
      dataSource.query.mockResolvedValueOnce([
        { tenantId: 'tenant-1' },
      ] as Row[]);
      await service.runForAllTenants(tasks[0]);

      const job = service.listJobs()[0];
      expect(job.lastRunAt).toBeDefined();
      expect(job.lastResult).toContain('巡检 1 个租户');
    });
  });

  describe('runJob', () => {
    it('任务存在时执行并返回 job + results', async () => {
      dataSource.query.mockResolvedValueOnce([
        { tenantId: 't1' },
        { tenantId: 't2' },
      ] as Row[]);
      (tasks[0].execute as jest.Mock).mockResolvedValue({
        taskName: 'inventory_warning',
        tenantId: 't1',
        found: 3,
        pushed: 1,
      });

      const result = await service.runJob('inventory_warning');

      expect(result.job.name).toBe('inventory_warning');
      expect(result.results).toHaveLength(2);
      expect(tasks[0].execute).toHaveBeenCalledWith('t1');
      expect(tasks[0].execute).toHaveBeenCalledWith('t2');
    });

    it('任务不存在时抛出 NotFoundException', async () => {
      await expect(service.runJob('not_exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('runForAllTenants', () => {
    it('对所有启用租户逐一执行', async () => {
      dataSource.query.mockResolvedValueOnce([
        { tenantId: 't1' },
        { tenantId: 't2' },
        { tenantId: 't3' },
      ] as Row[]);

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toHaveLength(3);
      expect(tasks[0].execute).toHaveBeenCalledTimes(3);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM t_tenant'),
      );
    });

    it('无启用租户时跳过并返回空数组', async () => {
      dataSource.query.mockResolvedValueOnce([]);

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toEqual([]);
      expect(tasks[0].execute).not.toHaveBeenCalled();
    });

    it('租户列表查询异常时返回空数组', async () => {
      dataSource.query.mockRejectedValueOnce(new Error('租户表不可用'));

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toEqual([]);
      expect(tasks[0].execute).not.toHaveBeenCalled();
    });

    it('单个租户执行异常不中断其他租户', async () => {
      dataSource.query.mockResolvedValueOnce([
        { tenantId: 't1' },
        { tenantId: 't2' },
      ] as Row[]);
      (tasks[0].execute as jest.Mock)
        .mockRejectedValueOnce(new Error('租户 t1 查询失败'))
        .mockResolvedValueOnce({
          taskName: 'inventory_warning',
          tenantId: 't2',
          found: 1,
          pushed: 1,
        });

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toHaveLength(2);
      expect(results[0].error).toContain('租户 t1 查询失败');
      expect(results[0].found).toBe(0);
      expect(results[1].found).toBe(1);
      expect(tasks[0].execute).toHaveBeenCalledTimes(2);
    });

    it('任务正在运行时跳过（防重入）', async () => {
      const internal = service as unknown as { running: Set<string> };
      internal.running.add('inventory_warning');

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toEqual([]);
      expect(tasks[0].execute).not.toHaveBeenCalled();
    });

    it('执行完成后释放 running 标记（可再次执行）', async () => {
      dataSource.query.mockResolvedValue([{ tenantId: 't1' }] as Row[]);

      await service.runForAllTenants(tasks[0]);
      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toHaveLength(1);
      expect(tasks[0].execute).toHaveBeenCalledTimes(2);
    });

    it('租户列表查询抛非 Error 异常时返回空数组', async () => {
      dataSource.query.mockRejectedValueOnce('租户表不可用');

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toEqual([]);
      expect(tasks[0].execute).not.toHaveBeenCalled();
    });

    it('单个租户执行抛非 Error 异常时记录 error（String 兜底）', async () => {
      dataSource.query.mockResolvedValueOnce([{ tenantId: 't1' }] as Row[]);
      (tasks[0].execute as jest.Mock).mockRejectedValueOnce('执行失败');

      const results = await service.runForAllTenants(tasks[0]);

      expect(results).toHaveLength(1);
      expect(results[0].error).toContain('执行失败');
      expect(results[0].found).toBe(0);
    });
  });

  describe('@Cron 定时方法', () => {
    it('cronInventoryWarning 调用库存预警任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronInventoryWarning();
      expect(spy).toHaveBeenCalledWith(tasks[0]);
    });

    it('cronOrderAnomaly 调用订单异常任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronOrderAnomaly();
      expect(spy).toHaveBeenCalledWith(tasks[1]);
    });

    it('cronReceivableReminder 调用应收催收任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronReceivableReminder();
      expect(spy).toHaveBeenCalledWith(tasks[2]);
    });

    it('cronDailyBriefing 调用每日简报任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronDailyBriefing();
      expect(spy).toHaveBeenCalledWith(tasks[3]);
    });

    it('cronBusinessAnomaly 调用经营异常任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronBusinessAnomaly();
      expect(spy).toHaveBeenCalledWith(tasks[4]);
    });

    it('cronReplenishmentAdvice 调用补货建议任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronReplenishmentAdvice();
      expect(spy).toHaveBeenCalledWith(tasks[5]);
    });

    it('cronDeliveryAnomaly 调用配送异常任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronDeliveryAnomaly();
      expect(spy).toHaveBeenCalledWith(tasks[6]);
    });

    it('cronCustomerChurn 调用客户流失任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronCustomerChurn();
      expect(spy).toHaveBeenCalledWith(tasks[7]);
    });

    it('cronGrossMarginAnomaly 调用毛利异常任务', async () => {
      const spy = jest.spyOn(service, 'runForAllTenants').mockResolvedValue([]);
      await service.cronGrossMarginAnomaly();
      expect(spy).toHaveBeenCalledWith(tasks[8]);
    });
  });
});
