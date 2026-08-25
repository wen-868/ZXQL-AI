/**
 * B5 BillingService 单元测试
 *
 * 覆盖：额度判定（免费/月费/余额/禁用）、消耗扣减（免费次数优先→余额按量）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { BillingService } from './billing.service';

function createService(existing?: Partial<TenantAiBillingEntity>) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existing ?? null),
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
  } as unknown as Repository<TenantAiBillingEntity>;
  return { service: new BillingService(repo), repo };
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

  it('消耗：优先扣免费对话次数', async () => {
    const { service, repo } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 5,
      balance: 100,
      overagePrice: 0.001,
      planType: 'pay_as_you_go',
    });
    await service.consume('t_001', 1000);
    const saved = (repo.save as jest.Mock).mock.calls[0][0];
    expect(saved.freeChatCount).toBe(4);
    expect(saved.balance).toBe(100);
  });

  it('消耗：免费次数用尽后按量扣预付费余额', async () => {
    const { service, repo } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 10,
      overagePrice: 0.001,
      planType: 'prepaid',
    });
    await service.consume('t_001', 2000);
    const saved = (repo.save as jest.Mock).mock.calls[0][0];
    expect(saved.balance).toBeCloseTo(9.998, 3);
  });

  it('消耗：月度套餐不逐次扣减', async () => {
    const { service, repo } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 0,
      planType: 'monthly',
    });
    await service.consume('t_001', 5000);
    expect(repo.save).not.toHaveBeenCalled();
  });
});
