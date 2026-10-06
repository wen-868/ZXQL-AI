/**
 * B5 BillingService 单元测试
 *
 * 覆盖：额度判定（免费/月费/余额/禁用）、消耗扣减（免费次数优先→余额按量）。
 *
 * 阶段0 B-3 返工（2026-10-07）：扣减改为原子 UPDATE（GREATEST 钳制 + 行锁
 * 保证并发正确），断言从"save 的内存值"改为"UPDATE 语句的原子性与参数"；
 * 扣减失败计入 fail 指标（漏计费可观测）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-10-07 B-3 原子化
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { MetricsService } from '../common/metrics.service';
import { BillingService } from './billing.service';

function createService(existing?: Partial<TenantAiBillingEntity>): {
  service: BillingService;
  repo: jest.Mocked<Repository<TenantAiBillingEntity>>;
  metrics: { recordBillingConsume: jest.Mock };
} {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existing ?? null),
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    query: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as jest.Mocked<Repository<TenantAiBillingEntity>>;
  const metrics = { recordBillingConsume: jest.fn() };
  return {
    service: new BillingService(repo, metrics as unknown as MetricsService),
    repo,
    metrics,
  };
}

describe('B5 BillingService', () => {
  it('额度判定：免费次数充足时放行', async () => {
    const { service } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 50,
      balance: 0,
      planType: 'pay_as_you_go',
    });
    expect((await service.checkQuota('t_001')).allowed).toBe(true);
  });

  it('额度判定：预付费余额充足时放行', async () => {
    const { service } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 100,
      planType: 'prepaid',
    });
    expect((await service.checkQuota('t_001')).allowed).toBe(true);
  });

  it('额度判定：计费未启用时拒绝（AI_002）', async () => {
    const { service } = createService({
      tenantId: 't_001',
      enabled: 0,
    });
    const result = await service.checkQuota('t_001');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('AI_002');
  });

  it('额度判定：免费次数与余额均耗尽时拒绝', async () => {
    const { service } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 0,
      monthlyChatLimit: 100,
      planType: 'prepaid',
    });
    expect((await service.checkQuota('t_001')).allowed).toBe(false);
  });

  it('消耗：优先扣免费对话次数（原子 UPDATE，GREATEST 钳 0 + 租户条件）', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 5,
      balance: 100,
      overagePrice: 0.001,
      planType: 'pay_as_you_go',
    });
    await service.consume('t_001', 1000);

    // 反测信号：若回退为读-改-写 + save，这里不会有原子 UPDATE
    expect(repo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (repo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('SET free_chat_count = GREATEST(free_chat_count - ?');
    expect(sql).toContain('WHERE tenant_id = ?');
    expect(sql).not.toMatch(/balance\s*=/); // 不得同时动余额
    expect(params).toEqual([1, 't_001']);
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('消耗：免费次数用尽后按量扣预付费余额（原子 UPDATE，金额在 DB 侧结算）', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 10,
      overagePrice: 0.001,
      planType: 'prepaid',
    });
    await service.consume('t_001', 2000);

    const [sql, params] = (repo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(sql).toContain('SET balance = GREATEST(balance - ?');
    expect(sql).toContain('WHERE tenant_id = ?');
    // 2000 tokens × 0.001/千 = 0.002
    expect(params).toEqual([0.002, 't_001']);
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('消耗：月度套餐不逐次扣减（skipped）', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 0,
      planType: 'monthly',
    });
    await service.consume('t_001', 5000);
    expect(repo.query).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('skipped');
  });

  it('消耗：扣减失败 → fail 指标 + error 日志（漏计费可观测，不再静默吞）', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 10,
      overagePrice: 0.001,
      planType: 'prepaid',
    });
    repo.query = jest.fn().mockRejectedValue(new Error('DB down')) as never;

    await expect(service.consume('t_001', 1000)).resolves.toBeUndefined();
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('fail');
  });
});
