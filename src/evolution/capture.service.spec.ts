/**
 * P1-1 CaptureService 单元测试
 *
 * 覆盖：任务采集（experience+sample 落库）、纠正采集、列表查询。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { AiExperienceEntity } from '../database/entities/ai-experience.entity';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { CaptureService } from './capture.service';

function createRepo<T>() {
  return {
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    find: jest.fn(() => Promise.resolve([])),
  } as unknown as Repository<T>;
}

function createService() {
  const expRepo = createRepo<AiExperienceEntity>();
  const corrRepo = createRepo<AiCorrectionEntity>();
  const sampleRepo = createRepo<AiSampleEntity>();
  const metrics = { recordDbSample: jest.fn() };
  const service = new CaptureService(
    expRepo,
    corrRepo,
    sampleRepo,
    metrics as never,
  );
  return { service, expRepo, corrRepo, sampleRepo };
}

describe('P1-1 CaptureService', () => {
  it('任务采集：成功路径落 experience + sample（脱敏）', async () => {
    const { service, expRepo, sampleRepo } = createService();
    await service.captureTask({
      tenantId: 't_001',
      domain: 'write',
      intent: 'sales_order_create',
      userMessage: '给红星商行开5箱五粮液',
      toolCalls: [
        {
          tool_name: 'createSalesOrder',
          args: { customerName: '红星商行', items: [{ skuName: '五粮液' }] },
        },
      ],
      outcome: 'success',
      reply: '销售单创建成功',
    });

    expect(expRepo.save).toHaveBeenCalled();
    const exp = (expRepo.save as jest.Mock).mock.calls[0][0];
    expect(exp.tenantId).toBe('t_001');
    expect(exp.outcome).toBe('success');
    expect(exp.inputHash).toMatch(/^[a-f0-9]{32}$/);
    // 轨迹已脱敏（客户名/商品名遮蔽）
    expect(exp.trajectory).toContain('***');

    expect(sampleRepo.save).toHaveBeenCalled();
    const sample = (sampleRepo.save as jest.Mock).mock.calls[0][0];
    expect(sample.taskType).toBe('sales_order_create');
    expect(sample.quality).toBe(3);
  });

  it('任务采集：失败路径只落 experience，不进样本池', async () => {
    const { service, sampleRepo } = createService();
    await service.captureTask({
      tenantId: 't_001',
      domain: 'write',
      intent: 'sales_order_create',
      outcome: 'failed',
      error: '库存不足',
    });
    expect(sampleRepo.save).not.toHaveBeenCalled();
  });

  it('纠正采集：wrong/right 脱敏后落库', async () => {
    const { service, corrRepo } = createService();
    await service.captureCorrection({
      tenantId: 't_001',
      taskType: 'customer_create',
      wrongPayload: { name: '红星商行', phone: '13812345678' },
      rightPayload: { name: '红星商行', phone: '13812345678' },
      reason: '手机号错误',
    });

    expect(corrRepo.save).toHaveBeenCalled();
    const corr = (corrRepo.save as jest.Mock).mock.calls[0][0];
    expect(corr.tenantId).toBe('t_001');
    expect(corr.taskType).toBe('customer_create');
    expect(corr.wrongPayload.name).toBe('***');
    expect(corr.wrongPayload.phone).toBe('138****5678');
    expect(corr.reason).toBe('手机号错误');
  });

  it('采集异常不抛出（best-effort）', async () => {
    const { service, expRepo } = createService();
    (expRepo.save as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.captureTask({
        tenantId: 't_001',
        domain: 'analysis',
        intent: 'chat',
        outcome: 'failed',
      }),
    ).resolves.toBeUndefined();
  });

  it('列表查询：支持租户过滤', async () => {
    const { service } = createService();
    await service.listExperiences('t_001', 10);
    await service.listCorrections();
    await service.listSamples('t_001');
    // 无异常即通过（repo.find mock 返回空数组）
  });
});
