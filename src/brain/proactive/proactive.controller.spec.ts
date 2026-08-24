/**
 * ProactiveController 单元测试
 *
 * 覆盖：
 * - GET  /api/admin/proactive/jobs（listJobs：返回 total + jobs）
 * - POST /api/admin/proactive/jobs/:name/run（runJob：正常返回 job + results）
 * - runJob 任务不存在时，service 抛 NotFoundException，错误向上传播
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { NotFoundException } from '@nestjs/common';
import { ProactiveController } from './proactive.controller';
import { ProactiveService } from './proactive.service';
import { ProactiveJobInfo, ProactiveTaskResult } from './proactive.types';

describe('ProactiveController', () => {
  let controller: ProactiveController;
  let service: { listJobs: jest.Mock; runJob: jest.Mock };

  /** 构造任务状态样例 */
  function createJobInfo(name: string): ProactiveJobInfo {
    return {
      name,
      description: `${name} 描述`,
      scheduleType: 'cron',
      schedule: '*/30 * * * *',
      priority: 'important',
      pushType: 'system',
    };
  }

  beforeEach(() => {
    service = {
      listJobs: jest.fn(),
      runJob: jest.fn(),
    };
    controller = new ProactiveController(
      service as unknown as ProactiveService,
    );
  });

  describe('listJobs', () => {
    it('返回全部巡检任务及总数', () => {
      const jobs = [
        createJobInfo('inventory_warning'),
        createJobInfo('order_anomaly'),
      ];
      service.listJobs.mockReturnValue(jobs);

      const result = controller.listJobs();

      expect(service.listJobs).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ total: 2, jobs });
    });

    it('无任务时返回空数组与 total 0', () => {
      service.listJobs.mockReturnValue([]);

      const result = controller.listJobs();

      expect(result).toEqual({ total: 0, jobs: [] });
    });
  });

  describe('runJob', () => {
    it('任务存在时返回 job 与各租户执行结果', async () => {
      const job = createJobInfo('inventory_warning');
      const results: ProactiveTaskResult[] = [
        {
          taskName: 'inventory_warning',
          tenantId: 'tenant-1',
          found: 2,
          pushed: 2,
        },
      ];
      service.runJob.mockResolvedValue({ job, results });

      const result = await controller.runJob('inventory_warning');

      expect(service.runJob).toHaveBeenCalledWith('inventory_warning');
      expect(service.runJob).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ job, results });
    });

    it('任务不存在时 service 抛 NotFoundException，错误向上传播', async () => {
      service.runJob.mockRejectedValue(
        new NotFoundException('巡检任务 not_exist 不存在'),
      );

      await expect(controller.runJob('not_exist')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(controller.runJob('not_exist')).rejects.toThrow(
        '巡检任务 not_exist 不存在',
      );
      expect(service.runJob).toHaveBeenCalledWith('not_exist');
    });
  });
});
