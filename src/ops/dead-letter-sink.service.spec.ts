/**
 * DeadLetterSinkService 单元测试（R101-AI-22 死信 sink 生产注册）
 *
 * 覆盖交付物 2/3/4 与反测 3 条：
 * - 反测 ①：注册后触发 bestEffort 失败 ⇒ 死信**真的落库**（行数 +1，字段逐列对齐）
 * - 反测 ②：去掉注册点 ⇒ 落库断言变红（本文件用「未注册对照组」+ 后续 mutation 反测共同证明）
 * - 反测 ③：sink 自身写失败 ⇒ 不抛、不刷屏（首条 + 限流 warn）、有计数
 * - 关键难点实测：**MySQL 不可用/挂死**时 sink 降级为日志+指标（超时放弃、不重试、不阻塞）
 * - 验收 4：`error-semantics.ts:228`「无死信接收方」日志在生产路径（注册后）不再出现
 * - 验收 5：不破坏 AI-21 fail-open（`idem.claim` 死信可落库，主流程不受影响）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AiDeadLetterEntity } from '../database/entities/ai-dead-letter.entity';
import { DeadLetterReplayService } from './dead-letter-replay.service';
import * as errorSemantics from '../common/error-semantics';
import {
  bestEffort,
  errorSemanticsCount,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
} from '../common/error-semantics';
import {
  DEAD_LETTER_CLEANUP_JOB_NAME,
  DEAD_LETTER_RETENTION_DAYS,
  DEAD_LETTER_WRITE_TIMEOUT_MS,
  DeadLetterSinkService,
} from './dead-letter-sink.service';

/** 内存仓储替身：可注入写失败 / 永不 settle（模拟 MySQL 挂死） */
class FakeDeadLetterRepo {
  rows: Array<Partial<AiDeadLetterEntity>> = [];
  insertError: Error | null = null;
  hangForever = false;

  insert = jest.fn((entity: Partial<AiDeadLetterEntity>) => {
    if (this.hangForever) {
      // 永不 settle：模拟 MySQL 无响应（连接建立后挂住）
      return new Promise<never>(() => undefined);
    }
    if (this.insertError) {
      return Promise.reject(this.insertError);
    }
    this.rows.push(entity);
    return Promise.resolve({ identifiers: [{ id: String(this.rows.length) }] });
  });
}

interface Harness {
  service: DeadLetterSinkService;
  repo: FakeDeadLetterRepo;
  dataSourceQuery: jest.Mock;
  /** R101-AI-23：故障缓冲（落库失败时入队）桩 */
  enqueue: jest.Mock;
}

function createHarness(env: Record<string, string> = {}): Harness {
  const repo = new FakeDeadLetterRepo();
  const dataSourceQuery = jest.fn(() => Promise.resolve({ affectedRows: 0 }));
  const configService = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;
  const enqueue = jest.fn(() => Promise.resolve(true));
  const service = new DeadLetterSinkService(
    configService,
    repo as unknown as Repository<AiDeadLetterEntity>,
    { query: dataSourceQuery } as unknown as DataSource,
    { enqueue } as never,
  );
  return { service, repo, dataSourceQuery, enqueue };
}

describe('DeadLetterSinkService（死信 sink 生产注册）', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorSemanticsMetrics();
    setDefaultDeadLetterSink(null);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    // 先还原 spy（含 setDefaultDeadLetterSink 的抛错 mock，否则它会污染后续用例的清理调用），
    // 再清全局 sink
    jest.restoreAllMocks();
    setDefaultDeadLetterSink(null);
  });

  /** 注册后的服务（onModuleInit 即生产注册点） */
  function registered(env: Record<string, string> = {}): Harness {
    const h = createHarness(env);
    h.service.onModuleInit();
    return h;
  }

  describe('反测 ①：注册后 bestEffort 失败真的落库', () => {
    it('行数 +1，且字段与 DeadLetterRecord 逐列对齐', async () => {
      const h = registered();

      await bestEffort(() => Promise.reject(new Error('ai_db down')), {
        op: 'audit.upsertDailyUsage',
        tenantId: 't1',
        detail: 'statDate=2026-10-12',
      });

      expect(
        errorSemanticsCount('best_effort', 'audit.upsertDailyUsage', 'fail'),
      ).toBe(1);
      expect(h.repo.rows).toHaveLength(1);
      const row = h.repo.rows[0];
      expect(row.op).toBe('audit.upsertDailyUsage');
      expect(row.tenantId).toBe('t1');
      expect(row.detail).toBe('statDate=2026-10-12');
      expect(row.error).toBe('ai_db down');
      expect(row.level).toBe('best_effort');
      expect(row.at).toBeInstanceOf(Date);
      expect(row.stack).toContain('ai_db down');
      expect(h.service.getStats()).toEqual({
        persisted: 1,
        failed: 0,
        consecutiveFailures: 0,
        lastErrorAt: null,
      });
    });

    it('sink 直调：`at`（ISO8601）毫秒级精确保存', async () => {
      const h = registered();
      await h.service.sink({
        op: 'ops.test',
        error: 'boom',
        level: 'best_effort',
        at: '2026-10-12T10:00:00.123Z',
      });

      const row = h.repo.rows[0];
      expect((row.at as Date).toISOString()).toBe('2026-10-12T10:00:00.123Z');
      expect(row.tenantId).toBeNull();
      expect(row.detail).toBeNull();
      expect(row.stack).toBeNull();
    });

    it('验收 4：注册后生产路径不再出现「无死信接收方」降级日志', async () => {
      const h = registered();
      await bestEffort(() => Promise.reject(new Error('x')), { op: 'ops.a' });

      expect(h.repo.rows).toHaveLength(1);
      const noSinkLogs = errorSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('无死信接收方'),
      );
      expect(noSinkLogs).toHaveLength(0);
    });

    it('验收 5：AI-21 幂等闸门 fail-open 的死信（op=idem.claim）可落库', async () => {
      const h = registered();
      await bestEffort(
        () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:3306')),
        { op: 'idem.claim', tenantId: 't1', detail: 'tool=createSalesOrder' },
      );

      expect(h.repo.rows).toHaveLength(1);
      expect(h.repo.rows[0].op).toBe('idem.claim');
      expect(h.repo.rows[0].error).toContain('ECONNREFUSED');
    });
  });

  describe('反测 ②：未注册 ⇒ 不落库（对照组，证明注册点承重）', () => {
    it('未注册时 bestEffort 失败只落日志：0 行 + 出现「无死信接收方」', async () => {
      const h = createHarness(); // 不调用 onModuleInit
      expect(h.service.isRegistered()).toBe(false);

      await bestEffort(() => Promise.reject(new Error('x')), { op: 'ops.b' });

      expect(h.repo.rows).toHaveLength(0);
      const noSinkLogs = errorSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('无死信接收方'),
      );
      expect(noSinkLogs).toHaveLength(1);

      // 同一服务注册后，同样的失败即落库 ⇒ 注册点是承重环节
      h.service.onModuleInit();
      await bestEffort(() => Promise.reject(new Error('x')), { op: 'ops.b' });
      expect(h.repo.rows).toHaveLength(1);
    });
  });

  describe('反测 ③：sink 自身写失败 ⇒ 不抛、不刷屏、有计数', () => {
    it('写失败 5 次：不抛、failed=5、warn 仅首条（限流），且无 bestEffort 二次报错', async () => {
      const h = registered();
      h.repo.insertError = new Error('insert ECONNREFUSED');

      for (let i = 0; i < 5; i++) {
        await expect(
          bestEffort(() => Promise.reject(new Error('op fail')), {
            op: `ops.fail.${i}`,
          }),
        ).resolves.toBeUndefined();
      }

      expect(h.repo.rows).toHaveLength(0);
      expect(h.service.getStats().failed).toBe(5);
      expect(h.service.getStats().consecutiveFailures).toBe(5);
      expect(h.service.getStats().lastErrorAt).not.toBeNull();
      // 限流：首条 warn 一次，其余静默（绝不刷屏）
      const deadLetterWarns = warnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('死信落库失败'),
      );
      expect(deadLetterWarns).toHaveLength(1);
      // sink 不抛 ⇒ error-semantics 的「死信写入失败」二次日志不出现（无递归刷屏）
      const sinkFailLogs = errorSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('死信写入失败'),
      );
      expect(sinkFailLogs).toHaveLength(0);
    });
  });

  describe('关键难点：MySQL 不可用/挂死 ⇒ 降级为日志+指标（不重试、不阻塞）', () => {
    it('写库挂死不返回 ⇒ 超时后计数失败并返回，主流程不被拖住', async () => {
      const h = registered({ DEAD_LETTER_WRITE_TIMEOUT_MS: '50' });
      h.repo.hangForever = true;

      const startedAt = Date.now();
      await bestEffort(() => Promise.reject(new Error('mysql down')), {
        op: 'idem.claim',
      });
      const elapsed = Date.now() - startedAt;

      expect(h.service.getStats().failed).toBe(1);
      expect(h.service.getStats().persisted).toBe(0);
      // 上限等待生效：不无限挂住（留 50ms 调度余量）
      expect(elapsed).toBeLessThan(DEAD_LETTER_WRITE_TIMEOUT_MS + 200);
      expect(h.repo.insert).toHaveBeenCalledTimes(1); // 不重试
      const warns = warnSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('死信落库超时'),
      );
      expect(warns).toHaveLength(1);
    });
  });

  describe('生产注册点', () => {
    it('onModuleInit 注册全局 sink 并打日志', () => {
      const h = createHarness();
      h.service.onModuleInit();

      expect(h.service.isRegistered()).toBe(true);
      const logs = warnSpy.mock.calls.length + errorSpy.mock.calls.length;
      expect(logs).toBe(0); // 注册正常路径不告警
    });

    it('注册失败不阻断启动（捕获 + error 日志）', () => {
      const h = createHarness();
      jest
        .spyOn(errorSemantics, 'setDefaultDeadLetterSink')
        .mockImplementation(() => {
          throw new Error('registry exploded');
        });

      expect(() => h.service.onModuleInit()).not.toThrow();
      expect(h.service.isRegistered()).toBe(false);
      const errs = errorSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('死信接收方注册失败'),
      );
      expect(errs).toHaveLength(1);
    });
  });

  describe('清理（复用 R101-AI-17 的 @Cron 模式）', () => {
    it('cleanupExpired：30 天前分批 DELETE（5000 → 100 → 停）', async () => {
      const h = registered();
      h.dataSourceQuery
        .mockResolvedValueOnce({ affectedRows: 5000 })
        .mockResolvedValueOnce({ affectedRows: 100 });

      const res = await h.service.cleanupExpired();

      expect(res.deleted).toBe(5100);
      expect(h.dataSourceQuery).toHaveBeenCalledTimes(2);
      const [sql, params] = h.dataSourceQuery.mock.calls[0] as [
        string,
        [Date, number],
      ];
      expect(sql).toContain('DELETE FROM t_ai_dead_letter');
      expect(sql).toContain('LIMIT ?');
      expect(params[1]).toBe(5000);
      const expectedCutoff =
        Date.now() - DEAD_LETTER_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs(params[0].getTime() - expectedCutoff)).toBeLessThan(
        60_000,
      );
    });

    it('@Cron 注册了命名清理任务（去掉装饰器即无此任务）', async () => {
      const mod = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          DeadLetterSinkService,
          {
            provide: getRepositoryToken(AiDeadLetterEntity),
            useValue: new FakeDeadLetterRepo(),
          },
          { provide: DataSource, useValue: { query: jest.fn() } },
          { provide: ConfigService, useValue: { get: () => undefined } },
          {
            // R101-AI-23：故障缓冲桩（本用例只验证 @Cron 注册）
            provide: DeadLetterReplayService,
            useValue: { enqueue: jest.fn(() => Promise.resolve(true)) },
          },
        ],
      }).compile();
      await mod.init();

      const registry = mod.get(SchedulerRegistry);
      const job = registry.getCronJob(DEAD_LETTER_CLEANUP_JOB_NAME);
      expect(job).toBeDefined();
      expect(String(job.cronTime.source)).toContain('0 3 * * *');
      // 模块初始化即完成注册（生产注册点）
      expect(mod.get(DeadLetterSinkService).isRegistered()).toBe(true);
      await mod.close();
    });

    it('清理失败不阻断调度（记 error 后返回 0）', async () => {
      const h = registered();
      h.dataSourceQuery.mockRejectedValueOnce(new Error('table locked'));

      await expect(h.service.cleanupExpired()).resolves.toEqual({ deleted: 0 });
      const errs = errorSpy.mock.calls.filter((call: unknown[]) =>
        String(call[0]).includes('死信表清理失败'),
      );
      expect(errs).toHaveLength(1);
    });
  });
});
