/**
 * B5 BillingService 单元测试
 *
 * 覆盖：额度判定（免费/月费/余额/禁用）、消耗扣减（免费次数优先→余额按量）。
 *
 * 阶段0 B-3 返工（2026-10-07）：扣减改为原子 UPDATE（GREATEST 钳制 + 行锁
 * 保证并发正确），断言从"save 的内存值"改为"UPDATE 语句的原子性与参数"；
 * 扣减失败计入 fail 指标（漏计费可观测）。
 *
 * 阶段2 A3（2026-10-07）：判据下沉到 SQL——不再用内存快照提前分流，
 * 而是先扣免费次数、用 affectedRows 裁决是否落入余额分支。用例覆盖
 * 「UPDATE 未命中 ⇒ 不得记 ok」这一核心信号。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-10-07 B-3 原子化 / A3 判据下沉
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { MetricsService } from '../common/metrics.service';
import { BillingService } from './billing.service';

/** mysql2 OK 包形态：repo.query() 对 UPDATE 返回 raw，计数字段是 affectedRows */
function okPacket(affectedRows: number): unknown {
  return { affectedRows, insertId: 0, warningStatus: 0 };
}

function createService(existing?: Partial<TenantAiBillingEntity>): {
  service: BillingService;
  repo: jest.Mocked<Repository<TenantAiBillingEntity>>;
  metrics: { recordBillingConsume: jest.Mock };
} {
  const repo = {
    findOne: jest.fn().mockResolvedValue(existing ?? null),
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    query: jest.fn().mockResolvedValue(okPacket(1)),
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

  it('消耗：优先扣免费对话次数（原子 UPDATE，GREATEST 钳0 + 租户条件）', async () => {
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

  // ──────────────────────────────────────────────────────────
  // 阶段2 A3 核心信号：判据必须来自 affectedRows，而非内存快照
  // ──────────────────────────────────────────────────────────
  it('消耗：免费次数 UPDATE 未命中（affectedRows=0）⇒ 不得记 ok，须落入余额分支', async () => {
    // 快照 freeChatCount=5：旧实现会据此判定"走免费分支"并直接记 ok。
    // 但本次 UPDATE 实际影响 0 行（并发下免费次数已被别的请求扣完），
    // 此刻正确行为是：免费次数已耗尽 ⇒ 落入余额扣减，而非记 ok。
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 5,
      balance: 100,
      overagePrice: 0.001,
      planType: 'pay_as_you_go',
    });
    (repo.query as jest.Mock).mockResolvedValueOnce(okPacket(0));

    await service.consume('t_001', 1000);

    // 判据信号：未命中免费次数时，绝不能出现 'ok'
    expect(metrics.recordBillingConsume).not.toHaveBeenCalledWith('ok');
    // 而应落到余额分支（ok_balance 与 ok 可区分）
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok_balance');
    expect(metrics.recordBillingConsume).toHaveBeenCalledTimes(1);
    // 两次 UPDATE：先免费次数（未命中），再余额
    expect(repo.query).toHaveBeenCalledTimes(2);
    const balanceCall = (repo.query as jest.Mock).mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(balanceCall[0]).toContain('SET balance = GREATEST(balance - ?');
    expect(balanceCall[1]).toEqual([0.001, 't_001']);
  });

  it('消耗：免费次数已耗尽（快照与DB 一致为 0）⇒ 直接扣余额，不发多余的免费 UPDATE 副作用', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 10,
      overagePrice: 0.001,
      planType: 'prepaid',
    });
    // 免费 UPDATE 必然未命中
    (repo.query as jest.Mock).mockResolvedValueOnce(okPacket(0));

    await service.consume('t_001', 2000);

    // 先试免费次数（判据统一走 SQL，不因快照为 0 就跳过 —— 否则判据又回到快照）
    expect(repo.query).toHaveBeenCalledTimes(2);
    const freeCall = (repo.query as jest.Mock).mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(freeCall[0]).toContain('SET free_chat_count = GREATEST');
    const balanceCall = (repo.query as jest.Mock).mock.calls[1] as [
      string,
      unknown[],
    ];
    expect(balanceCall[0]).toContain('SET balance = GREATEST(balance - ?');
    expect(balanceCall[0]).toContain('WHERE tenant_id = ?');
    // 2000 tokens × 0.001/千 = 0.002
    expect(balanceCall[1]).toEqual([0.002, 't_001']);
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok_balance');
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('消耗：免费次数 UPDATE 未命中且为月费套餐 ⇒ skipped，仍不得记 ok', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 5,
      balance: 0,
      planType: 'monthly',
    });
    (repo.query as jest.Mock).mockResolvedValueOnce(okPacket(0));

    await service.consume('t_001', 5000);

    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('skipped');
    expect(metrics.recordBillingConsume).not.toHaveBeenCalledWith('ok');
    // 月费套餐不按量扣余额
    expect(repo.query).toHaveBeenCalledTimes(1);
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('消耗：读取 mysql2 OK 包的 affectedRows 字段（非 TypeORM UpdateResult.affected）', async () => {
    const { service, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 5,
      balance: 0,
      overagePrice: 0.001,
      planType: 'monthly',
    });
    // 只提供 affectedRows（真实形态）。若实现误读 .affected，
    // 则会得到 undefined ⇒ 误判为"未命中" ⇒ 落入余额分支 ⇒ 用例变红。
    await service.consume('t_001', 1000);
    expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok');
    expect(metrics.recordBillingConsume).toHaveBeenCalledTimes(1);
  });

  it('消耗：月度套餐不逐次扣减（skipped）', async () => {
    const { service, repo, metrics } = createService({
      tenantId: 't_001',
      enabled: 1,
      freeChatCount: 0,
      balance: 0,
      planType: 'monthly',
    });
    (repo.query as jest.Mock).mockResolvedValueOnce(okPacket(0));

    await service.consume('t_001', 5000);
    expect(repo.query).toHaveBeenCalledTimes(1); // 仅试探性免费 UPDATE，未命中
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
