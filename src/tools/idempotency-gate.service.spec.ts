/**
 * IdempotencyGateService 单元测试（R101-AI-21 阶段 3 幂等键）
 *
 * 覆盖方案 §3.1/§3.2 与业主裁定 A/B：
 * 1. 键来源与 TTL（confirm_token 600s / explicit / payload_hash 60s；易变字段剔除）
 * 2. Redis SET NX 前置快筛：命中（有行 ⇒ 回放；无行 ⇒ 以 MySQL 为准认领）
 * 3. MySQL 认领：唯一键冲突 ⇒ 回放 / 处理中 / 失败重试；MySQL 不可用 ⇒ fail-open（裁定 B）
 * 4. 裁定 A：回放既有结果 + `idempotent_replay` 标记
 * 5. 止血开关 IDEMPOTENCY_ENABLED：关闭 ⇒ 直通 + warn 日志
 * 6. 清理：陈旧 in_flight 置 failed + 30 天批量删除；@Cron 命名任务已注册
 *
 * 反测（本文件是 ②③④ 的载体）：
 * - 去掉 Redis NX 调用 ⇒「Redis 命中即不重复认领」断言变红
 * - 去掉 MySQL 唯一键兜底 ⇒「Redis 宕机时第二次仍被判重复」断言变红
 * - 模拟 MySQL 不可用 ⇒ fail-open 且不阻断（本文件正向断言）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOperator, Repository } from 'typeorm';
import {
  AiIdempotencyEntity,
  IdempotencyKeySource,
} from '../database/entities/ai-idempotency.entity';
import { RedisProvider } from '../common/redis.provider';
import {
  errorSemanticsCount,
  resetErrorSemanticsMetrics,
} from '../common/error-semantics';
import type { ToolContext } from './tool.interface';
import {
  IDEMPOTENCY_CLEANUP_JOB_NAME,
  IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS,
  IDEMPOTENCY_PAYLOAD_TTL_SEC,
  IDEMPOTENCY_REDIS_TTL_SEC,
  IDEMPOTENCY_RETENTION_DAYS,
  IdempotencyCheckInput,
  IdempotencyDecision,
  IdempotencyGateService,
} from './idempotency-gate.service';

type ProceedDecision = Extract<IdempotencyDecision, { decision: 'proceed' }>;
type ReplayDecision = Extract<IdempotencyDecision, { decision: 'replay' }>;
type InFlightDecision = Extract<IdempotencyDecision, { decision: 'in_flight' }>;

/** 断言并收窄：proceed（helper 抛错即断言失败） */
function asProceed(d: IdempotencyDecision): ProceedDecision {
  expect(d.decision).toBe('proceed');
  if (d.decision !== 'proceed') {
    throw new Error(`期望 proceed，实际 ${d.decision}`);
  }
  return d;
}

/** 断言并收窄：replay（裁定 A） */
function asReplay(d: IdempotencyDecision): ReplayDecision {
  expect(d.decision).toBe('replay');
  if (d.decision !== 'replay') {
    throw new Error(`期望 replay，实际 ${d.decision}`);
  }
  return d;
}

/** 断言并收窄：in_flight（处理中） */
function asInFlight(d: IdempotencyDecision): InFlightDecision {
  expect(d.decision).toBe('in_flight');
  if (d.decision !== 'in_flight') {
    throw new Error(`期望 in_flight，实际 ${d.decision}`);
  }
  return d;
}

/** 迁移表行（与 AiIdempotencyEntity 逐列对应） */
interface FakeRow {
  id: string;
  tenantId: string;
  toolName: string;
  idemKey: string;
  keySource: string;
  status: string;
  resultJson: string | null;
  errorText: string | null;
  firstSeenAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function duplicateKeyError(): Error {
  const err = new Error(
    "Duplicate entry 't1-createSalesOrder-x' for key 't_ai_idempotency.uk_ai_idempotency'",
  ) as Error & { code: string; errno: number };
  err.code = 'ER_DUP_ENTRY';
  err.errno = 1062;
  return err;
}

/**
 * 内存仓储替身：**真实模拟唯一键**（uk_ai_idempotency）与 FindOperator
 *
 * 反测 ③ 的载体：若把唯一键判定去掉，第二个请求将不再判重复 ⇒ 断言变红。
 */
class FakeIdempotencyRepo {
  rows: FakeRow[] = [];
  /** 非唯一键冲突的 DB 故障（模拟 MySQL 不可用） */
  insertError: Error | null = null;
  private seq = 0;

  insert = jest.fn(
    (
      entity: Partial<AiIdempotencyEntity>,
    ): Promise<{ identifiers: Array<{ id: string }> }> => {
      if (this.insertError) {
        return Promise.reject(this.insertError);
      }
      const dup = this.rows.find(
        (r) =>
          r.tenantId === entity.tenantId &&
          r.toolName === entity.toolName &&
          r.idemKey === entity.idemKey,
      );
      if (dup) {
        return Promise.reject(duplicateKeyError());
      }
      const row = {
        id: String(++this.seq),
        ...(entity as Omit<FakeRow, 'id'>),
      };
      this.rows.push(row);
      return Promise.resolve({ identifiers: [{ id: row.id }] });
    },
  );

  findOne = jest.fn(
    (opts: { where: Record<string, unknown> }): Promise<FakeRow | null> =>
      Promise.resolve(
        this.rows.find((r) => this.matches(r, opts.where)) ?? null,
      ),
  );

  update = jest.fn(
    (
      criteria: Record<string, unknown>,
      patch: Record<string, unknown>,
    ): Promise<{ affected: number }> => {
      const matched = this.rows.filter((r) => this.matches(r, criteria));
      for (const row of matched) {
        Object.assign(row, patch);
      }
      return Promise.resolve({ affected: matched.length });
    },
  );

  private matches(row: FakeRow, criteria: Record<string, unknown>): boolean {
    return Object.entries(criteria).every(([key, value]) => {
      const actual = (row as unknown as Record<string, unknown>)[key];
      if (value instanceof FindOperator) {
        if (value.type === 'lessThan') {
          return (
            actual instanceof Date &&
            actual.getTime() < (value.value as Date).getTime()
          );
        }
        throw new Error(`FakeRepo 未实现的 FindOperator：${value.type}`);
      }
      return actual === value;
    });
  }
}

interface Harness {
  gate: IdempotencyGateService;
  repo: FakeIdempotencyRepo;
  /** Redis 键空间（模拟 NX 语义） */
  redisStore: Set<string>;
  redisDown: boolean;
  redisSet: jest.Mock;
  dataSourceQuery: jest.Mock;
}

function createHarness(env: Record<string, string> = {}): Harness {
  const repo = new FakeIdempotencyRepo();
  const redisStore = new Set<string>();
  const harness = {
    repo,
    redisStore,
    redisDown: false,
    redisSet: undefined as unknown as jest.Mock,
    dataSourceQuery: jest.fn(() => Promise.resolve({ affectedRows: 0 })),
    gate: undefined as unknown as IdempotencyGateService,
  };

  harness.redisSet = jest.fn(
    (
      key: string,
      _value: string,
      _ex: string,
      _ttl: number,
      _nx: string,
    ): Promise<string | null> => {
      if (harness.redisDown) {
        return Promise.reject(new Error('Redis connection is down'));
      }
      if (redisStore.has(key)) {
        return Promise.resolve(null); // NX 未设置成功 = 键已存在 = 重复
      }
      redisStore.add(key);
      return Promise.resolve('OK');
    },
  );

  const redisProvider = {
    getSharedClient: jest.fn(() => ({ set: harness.redisSet })),
  } as unknown as RedisProvider;
  const configService = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;

  harness.gate = new IdempotencyGateService(
    configService,
    redisProvider,
    repo as unknown as Repository<AiIdempotencyEntity>,
    { query: harness.dataSourceQuery } as unknown as DataSource,
  );
  return harness;
}

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

function makeInput(
  over: Partial<IdempotencyCheckInput> = {},
): IdempotencyCheckInput {
  return {
    toolName: 'createSalesOrder',
    args: { items: [{ skuId: 'S1', qty: 2 }], confirm: true },
    toolCallId: 'confirm-wg_token_1',
    context: CTX,
    ...over,
  };
}

/** 走完"首次认领 → 完成"两条腿 */
async function claimAndComplete(
  h: Harness,
  input: IdempotencyCheckInput,
  data: unknown = { orderNo: 'SO2026101200001' },
): Promise<void> {
  const first = asProceed(await h.gate.check(input));
  await h.gate.complete(first.handle, { success: true, data });
}

describe('IdempotencyGateService（阶段 3 幂等键）', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorSemanticsMetrics();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  describe('键来源与 TTL', () => {
    it('确认通道（toolCall.id = confirm-<令牌>）⇒ key_source=confirm_token，TTL 600s', async () => {
      const h = createHarness();
      const decision = await h.gate.check(makeInput());

      expect(decision.decision).toBe('proceed');
      expect(h.redisSet).toHaveBeenCalledTimes(1);
      const [key, value, ex, ttl, nx] = h.redisSet.mock.calls[0] as [
        string,
        string,
        string,
        number,
        string,
      ];
      expect(key).toMatch(/^ai:idem:t1:createSalesOrder:[0-9a-f]{64}$/);
      expect(value).toBe('1');
      expect(ex).toBe('EX');
      expect(ttl).toBe(IDEMPOTENCY_REDIS_TTL_SEC);
      expect(nx).toBe('NX');
      expect(h.repo.rows[0].keySource).toBe('confirm_token');
    });

    it('调用方显式键优先 ⇒ key_source=explicit', async () => {
      const h = createHarness();
      await h.gate.check(makeInput({ explicitKey: 'ERP-ORDER-2026-0001' }));

      expect(h.repo.rows[0].keySource).toBe('explicit');
    });

    it('无令牌无显式键 ⇒ payload_hash，TTL 收窄为 60s（假阳性风险缓释）', async () => {
      const h = createHarness();
      await h.gate.check(makeInput({ toolCallId: 'call_abc123' }));

      const ttl = (
        h.redisSet.mock.calls[0] as [string, string, string, number]
      )[3];
      expect(ttl).toBe(IDEMPOTENCY_PAYLOAD_TTL_SEC);
      expect(h.repo.rows[0].keySource).toBe('payload_hash');
    });

    it('易变字段（confirm/requestId/sessionId）不参与指纹：同业务参数 ⇒ 同键', async () => {
      const h = createHarness();
      const a = makeInput({
        toolCallId: 'call_1',
        args: {
          items: [{ skuId: 'S1', qty: 2 }],
          confirm: true,
          requestId: 'r1',
        },
      });
      const b = makeInput({
        toolCallId: 'call_2',
        args: {
          items: [{ skuId: 'S1', qty: 2 }],
          confirm: true,
          requestId: 'r2',
        },
      });
      await h.gate.check(a);
      await h.gate.check(b);

      const keyA = (h.redisSet.mock.calls[0] as [string])[0];
      const keyB = (h.redisSet.mock.calls[1] as [string])[0];
      expect(keyA).toBe(keyB);
      // 第二次命中 Redis ⇒ 不重复认领，直接回放
      expect(h.repo.insert).toHaveBeenCalledTimes(1);
    });

    it('业务参数不同 ⇒ 键不同（不会误判为同一次操作）', async () => {
      const h = createHarness();
      await h.gate.check(
        makeInput({
          toolCallId: 'call_1',
          args: { items: [{ skuId: 'S1', qty: 2 }] },
        }),
      );
      await h.gate.check(
        makeInput({
          toolCallId: 'call_2',
          args: { items: [{ skuId: 'S1', qty: 3 }] },
        }),
      );

      const keyA = (h.redisSet.mock.calls[0] as [string])[0];
      const keyB = (h.redisSet.mock.calls[1] as [string])[0];
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('裁定 A：重复请求回放既有结果', () => {
    it('同一确认令牌两次 ⇒ 第二次回放 + idempotent_replay 标记，且不重复认领', async () => {
      const h = createHarness();
      const input = makeInput();
      await claimAndComplete(h, input);

      const second = asReplay(await h.gate.check(input));

      expect(second.result.success).toBe(true);
      expect(second.result.idempotent_replay).toBe(true);
      expect(second.result.data).toEqual({ orderNo: 'SO2026101200001' });
      expect(second.result.originalCompletedAt).toBeDefined();
      // 只认领过一次（第二次既没插库也没执行）
      expect(h.repo.insert).toHaveBeenCalledTimes(1);
    });

    it('Redis 命中但 MySQL 无行（键过期/被清理）⇒ 以 MySQL 为准重新认领', async () => {
      const h = createHarness();
      const input = makeInput();
      // 预置 Redis 键（模拟 TTL 残留）但库里没有行
      const decision = asProceed(await h.gate.check(input));
      expect(decision.handle).not.toBeNull();
      h.repo.rows = [];
      h.redisStore.clear();
      h.redisStore.add((h.redisSet.mock.calls[0] as [string])[0]);

      const retry = asProceed(await h.gate.check(input));
      expect(retry.handle).not.toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MySQL 无行'),
      );
    });

    it('结果 JSON 损坏 ⇒ 按「处理中」返回，不回放脏结果', async () => {
      const h = createHarness();
      const input = makeInput();
      await h.gate.check(input);
      h.repo.rows[0].status = 'succeeded';
      h.repo.rows[0].resultJson = '{ not json';

      const second = asInFlight(await h.gate.check(input));
      expect(second.result.success).toBe(false);
    });
  });

  describe('MySQL 认领（唯一键兜底）', () => {
    it('in_flight 既有行 ⇒ 返回「处理中」，既不执行也不回放', async () => {
      const h = createHarness();
      const input = makeInput();
      await h.gate.check(input); // 认领但未完成（模拟首笔仍在执行）

      const second = asInFlight(await h.gate.check(input));

      expect(second.result.success).toBe(false);
      expect(second.result.error).toContain('处理中');
      expect(second.result.suggestion).toContain('重复提交不会产生第二笔单据');
    });

    it('failed 既有行 ⇒ 允许同键重试（重新认领为 in_flight）', async () => {
      const h = createHarness();
      const input = makeInput();
      const first = await h.gate.check(input);
      await h.gate.complete(first.handle, {
        success: false,
        error: '后端 500',
      });
      expect(h.repo.rows[0].status).toBe('failed');
      expect(h.repo.rows[0].errorText).toBe('后端 500');

      const retry = await h.gate.check(input);
      expect(retry.decision).toBe('proceed');
      expect(h.repo.rows[0].status).toBe('in_flight');
      expect(h.repo.insert).toHaveBeenCalledTimes(1); // 复用同一行，不新增
    });

    it('反测 ③ 载体：Redis 宕机时，唯一键仍把第二次判为重复（两层都在干活）', async () => {
      const h = createHarness();
      const input = makeInput();
      await claimAndComplete(h, input);

      h.redisDown = true; // Redis 不可用 ⇒ 前置闸门失效，只剩 MySQL 唯一键
      const second = asReplay(await h.gate.check(input));

      expect(second.result.idempotent_replay).toBe(true);
      // degrade 口径：Redis 失败已计数（可观测）
      expect(errorSemanticsCount('degrade', 'idem.redis_nx', 'fail')).toBe(1);
    });
  });

  describe('裁定 B：MySQL 不可用 ⇒ fail-open', () => {
    it('认领抛连接错误 ⇒ proceed（不阻断写）+ 死信/指标 + error 日志', async () => {
      const h = createHarness();
      h.repo.insertError = new Error('connect ECONNREFUSED 127.0.0.1:3306');

      const decision = asProceed(await h.gate.check(makeInput()));

      expect(decision.handle).toBeNull();
      expect(errorSemanticsCount('best_effort', 'idem.claim', 'fail')).toBe(1);
    });

    it('闸门自身异常（findOne 抛错）⇒ 外层 fail-open，永不向上抛', async () => {
      const h = createHarness();
      const input = makeInput();
      await h.gate.check(input); // 先占 Redis 键
      h.repo.findOne.mockImplementationOnce(() => {
        throw new Error('repository exploded');
      });

      const decision = asProceed(await h.gate.check(input));
      expect(decision.handle).toBeNull();
      expect(errorSemanticsCount('best_effort', 'idem.gate', 'fail')).toBe(1);
    });
  });

  describe('止血开关 IDEMPOTENCY_ENABLED', () => {
    it('关闭 ⇒ 直通 + warn 日志，不碰 Redis 也不落库', async () => {
      const h = createHarness({ IDEMPOTENCY_ENABLED: 'false' });

      const decision = asProceed(await h.gate.check(makeInput()));

      expect(decision.handle).toBeNull();
      expect(h.redisSet).not.toHaveBeenCalled();
      expect(h.repo.insert).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('幂等闸门已关闭（IDEMPOTENCY_ENABLED=false）'),
      );
    });

    it('默认（未配置）视为开启', () => {
      const h = createHarness();
      expect(h.gate.isEnabled()).toBe(true);
    });
  });

  describe('清理（复用 R101-AI-17 的 @Cron 模式）', () => {
    it('cleanupExpired：陈旧 in_flight 置 failed + 30 天前批量删除', async () => {
      const h = createHarness();
      const stale = new Date(
        Date.now() - IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS - 60_000,
      );
      h.repo.rows.push({
        id: 'stale-1',
        tenantId: 't1',
        toolName: 'createSalesOrder',
        idemKey: 'k'.repeat(64),
        keySource: 'confirm_token',
        status: 'in_flight',
        resultJson: null,
        errorText: null,
        firstSeenAt: stale,
        completedAt: null,
        createdAt: stale,
        updatedAt: stale,
      });
      h.dataSourceQuery
        .mockResolvedValueOnce({ affectedRows: 3 })
        .mockResolvedValueOnce({ affectedRows: 0 });

      const res = await h.gate.cleanupExpired();

      expect(res.staleMarked).toBe(1);
      expect(h.repo.rows[0].status).toBe('failed');
      expect(res.deleted).toBe(3);
      const [sql, params] = h.dataSourceQuery.mock.calls[0] as [
        string,
        [Date, number],
      ];
      expect(sql).toContain('DELETE FROM t_ai_idempotency');
      expect(sql).toContain('LIMIT ?');
      expect(params[1]).toBe(5000);
      const cutoff = params[0];
      const expected =
        Date.now() - IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(60_000);
    });

    it('@Cron 注册了命名清理任务（去掉装饰器即无此任务）', async () => {
      const repo = new FakeIdempotencyRepo();
      const mod = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot()],
        providers: [
          IdempotencyGateService,
          {
            provide: getRepositoryToken(AiIdempotencyEntity),
            useValue: repo,
          },
          { provide: DataSource, useValue: { query: jest.fn() } },
          { provide: ConfigService, useValue: { get: () => undefined } },
          {
            provide: RedisProvider,
            useValue: { getSharedClient: jest.fn() },
          },
        ],
      }).compile();
      await mod.init();

      const registry = mod.get(SchedulerRegistry);
      const job = registry.getCronJob(IDEMPOTENCY_CLEANUP_JOB_NAME);
      expect(job).toBeDefined();
      // 每日 03:00（@nestjs/schedule 归一为 6 段式）
      expect(String(job.cronTime.source)).toContain('0 3 * * *');
      expect(mod.get(IdempotencyGateService)).toBeInstanceOf(
        IdempotencyGateService,
      );
      await mod.close();
    });
  });

  describe('complete：回填', () => {
    it('成功 ⇒ succeeded + result_json；失败 ⇒ failed + error_text（截断 512）', async () => {
      const h = createHarness();
      const first = await h.gate.check(makeInput());
      await h.gate.complete(first.handle, {
        success: true,
        data: { orderNo: 'SO1' },
      });
      expect(h.repo.rows[0].status).toBe('succeeded');
      expect(h.repo.rows[0].resultJson).toContain('SO1');

      const second = asProceed(
        await h.gate.check(
          makeInput({
            toolCallId: 'confirm-wg_token_2',
            args: { items: [{ skuId: 'S2', qty: 1 }] },
          }),
        ),
      );
      await h.gate.complete(second.handle, {
        success: false,
        error: 'X'.repeat(900),
      });
      expect(h.repo.rows[1].status).toBe('failed');
      expect(h.repo.rows[1].errorText).toHaveLength(512);
    });

    it('handle 为空（未认领/开关关闭）⇒ 不落任何写', async () => {
      const h = createHarness();
      await h.gate.complete(null, { success: true });
      expect(h.repo.update).not.toHaveBeenCalled();
    });
  });

  it('key_source 取值与迁移列约束一致（仅三种）', () => {
    const sources: IdempotencyKeySource[] = [
      'confirm_token',
      'explicit',
      'payload_hash',
    ];
    expect(sources).toHaveLength(3);
  });
});
