/**
 * R101-AI-17 反测：撤销窗口清理**真实被调度**（P1-3）
 *
 * 缺陷：`executedMap` 只增不减；`cleanupExpired()` 全仓零生产调用方，
 * 原注释"由定时任务清理"是虚假保证（22 个 @Cron 无一调用它）。
 *
 * 修复：`cleanupExpired()` 挂 `@Cron(EVERY_5_MINUTES, { name })`。
 *
 * 反测方向：临时注释掉该方法的 `@Cron` 装饰器 ⇒ ScheduleModule 不再注册
 * `confirmation-cleanup-expired` 任务 ⇒ 本文件「任务已注册」断言变红。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-10
 */
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { ConfirmationService, REVOKE_TTL_MS } from './confirmation.service';

/** 与实现中的任务名保持一致（改名会同时让本断言与生产调度口径失配） */
const JOB_NAME = 'confirmation-cleanup-expired';

describe('R101-AI-17 撤销窗口清理调度', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let service: ConfirmationService;
  let registry: SchedulerRegistry;

  async function buildModule(): Promise<{
    service: ConfirmationService;
    registry: SchedulerRegistry;
    close: () => Promise<void>;
  }> {
    const mod = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [ConfirmationService],
    }).compile();
    await mod.init();
    return {
      service: mod.get(ConfirmationService),
      registry: mod.get(SchedulerRegistry),
      close: () => mod.close(),
    };
  }

  beforeEach(async () => {
    moduleRef = await buildModule();
    service = moduleRef.service;
    registry = moduleRef.registry;
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('@Cron 注册了命名清理任务（去掉装饰器即无此任务）', () => {
    const job = registry.getCronJob(JOB_NAME);
    expect(job).toBeDefined();
    // 每 5 分钟（与 ops/health-monitor 同粒度）；@nestjs/schedule 归一为 6 段式
    expect(String(job.cronTime.source)).toContain('*/5 * * * *');
  });

  it('调度触发时确实执行清理（不是"注册了但没人调"）', async () => {
    // 先登记一条已执行操作（走真实 registerExecuted，开启 3 分钟撤销窗口）
    const operation = service.registerExecuted({
      tenantId: 't1',
      toolName: 'createSalesOrder',
      args: {},
      operationLabel: '创建销售单',
    });
    expect(service.getExecuted(operation.operationId)).not.toBeNull();

    // 让窗口过期（只影响后续 Date.now 读取）
    const realNow = Date.now();
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(realNow + REVOKE_TTL_MS + 1);
    try {
      // 由注册在 ScheduleRegistry 里的任务触发（若 @Cron 被去掉，这里根本取不到任务）
      const job = registry.getCronJob(JOB_NAME);
      await job.fireOnTick();
    } finally {
      nowSpy.mockRestore();
    }

    // 过期条目已被调度链路清理 ⇒ 证明 cleanupExpired 真的被调度执行
    expect(service.getExecuted(operation.operationId)).toBeNull();
  });

  it('撤销窗口语义未变：窗口内记录可撤销，窗口到期后被清理', () => {
    // 语义护栏：TTL 常量未被本次改动触碰
    expect(REVOKE_TTL_MS).toBe(3 * 60 * 1000);

    // 注册一条已执行操作（开启窗口）
    const operation = service.registerExecuted({
      tenantId: 't1',
      toolName: 'createSalesOrder',
      args: {},
      operationLabel: '创建销售单',
    });
    expect(service.getExecuted(operation.operationId)).not.toBeNull();

    // 未到期 ⇒ 清理不动它（窗口语义不变）
    expect(service.cleanupExpired()).toBe(0);
    expect(service.getExecuted(operation.operationId)).not.toBeNull();

    // 到期后 ⇒ 清理（真实回收，内存有界）
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + REVOKE_TTL_MS + 1);
    expect(service.cleanupExpired()).toBeGreaterThanOrEqual(1);
    expect(service.getExecuted(operation.operationId)).toBeNull();
    jest.restoreAllMocks();
  });
});
