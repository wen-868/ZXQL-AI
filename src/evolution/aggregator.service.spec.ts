/**
 * P1-1 AggregatorService 单元测试
 *
 * 覆盖：跨租户聚合（结果分布/去重/纠正原因模式）、批量聚合、无数据返回 null。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Repository } from 'typeorm';
import { AiExperienceEntity } from '../database/entities/ai-experience.entity';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { AggregatorService } from './aggregator.service';

function createService(
  experiences: Partial<AiExperienceEntity>[],
  corrections: Partial<AiCorrectionEntity>[],
) {
  const expRepo = {
    find: jest.fn().mockResolvedValue(experiences),
  } as unknown as Repository<AiExperienceEntity>;
  const corrRepo = {
    find: jest.fn().mockResolvedValue(corrections),
  } as unknown as Repository<AiCorrectionEntity>;
  return {
    service: new AggregatorService(expRepo, corrRepo),
    expRepo,
    corrRepo,
  };
}

describe('P1-1 AggregatorService', () => {
  it('聚合：按任务类型统计结果分布与纠正原因（跨租户）', async () => {
    const { service } = createService(
      [
        {
          tenantId: 't_001',
          intent: 'sales_order',
          outcome: 'success',
          inputHash: 'a1',
        },
        {
          tenantId: 't_001',
          intent: 'sales_order',
          outcome: 'success',
          inputHash: 'a1',
        },
        {
          tenantId: 't_002',
          intent: 'sales_order',
          outcome: 'failed',
          inputHash: 'b1',
        },
      ],
      [
        {
          tenantId: 't_001',
          taskType: 'sales_order',
          reason: '商品数量格式错误',
        },
        {
          tenantId: 't_002',
          taskType: 'sales_order',
          reason: '商品数量格式错误',
        },
      ],
    );

    const pattern = await service.aggregateByTaskType('sales_order');

    expect(pattern).not.toBeNull();
    expect(pattern!.tenantCount).toBe(2);
    // 同 input_hash 去重
    expect(pattern!.outcomeDistribution.success).toBe(1);
    expect(pattern!.outcomeDistribution.failed).toBe(1);
    // 原因模式跨租户合并
    expect(pattern!.reasonPatterns[0]).toEqual({
      reason: '商品数量格式错误',
      count: 2,
    });
  });

  it('聚合：无数据返回 null', async () => {
    const { service } = createService([], []);
    expect(await service.aggregateByTaskType('customer_create')).toBeNull();
  });

  it('聚合：纠正原因超长截断（去标识）', async () => {
    const { service } = createService(
      [],
      [
        {
          tenantId: 't_001',
          taskType: 'x',
          reason: '红星商行的手机号填写错误且没有正确格式',
        },
      ],
    );
    const pattern = await service.aggregateByTaskType('x');
    expect(pattern!.reasonPatterns[0].reason.length).toBeLessThanOrEqual(25);
  });

  it('批量聚合：从样本收集任务类型并逐个聚合', async () => {
    const { service } = createService(
      [{ tenantId: 't_001', intent: 'sales_order', outcome: 'success' }],
      [{ tenantId: 't_001', taskType: 'customer_create', reason: 'r' }],
    );
    const spy = jest
      .spyOn(service, 'aggregateByTaskType')
      .mockImplementation((taskType) => ({
        taskType,
        total: 1,
        tenantCount: 1,
        outcomeDistribution: {},
        reasonPatterns: [],
      }));

    const patterns = await service.aggregateAll();
    expect(patterns.length).toBe(2);
    expect(spy).toHaveBeenCalledWith('sales_order', 100);
    expect(spy).toHaveBeenCalledWith('customer_create', 100);
  });
});
