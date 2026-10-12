/**
 * DeadLetterReplayService 单元测试（R101-AI-23 死信重放队列）
 *
 * 覆盖交付物 1~4 与反测 4 条：
 * - 反测 ①：MySQL 故障 ⇒ 死信进 Stream（不丢；sink 落库失败路径真实联动）
 * - 反测 ②：MySQL 恢复 ⇒ 消费补录到 t_ai_dead_letter 且行数对得上（XACK 摘除）
 * - 反测 ③：消费任务自身失败 ⇒ 不抛、不阻塞、有告警
 * - 反测 ④：超过最大重试 ⇒ 明确终态（终态流 + error 日志 + XACK 摘除，不无限循环）
 * - 验收 3：MySQL 正常时 sink 直接落库，**不经过 Stream**（正常路径行为零变化）
 * - 退避与可观测：失败后按退避跳过（deferred）；XLEN 积压深度随消费落日志
 * - 连接口径：复用共享 provider 的 `retry-forever` 池（不新建连接）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiDeadLetterEntity } from '../database/entities/ai-dead-letter.entity';
import { RedisProvider } from '../common/redis.provider';
import {
  bestEffort,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
} from '../common/error-semantics';
import { DeadLetterSinkService } from './dead-letter-sink.service';
import {
  DEAD_LETTER_REPLAY_GROUP,
  DEAD_LETTER_REPLAY_JOB_NAME,
  DEAD_LETTER_REPLAY_STREAM,
  DEAD_LETTER_REPLAY_TERMINAL_STREAM,
  DeadLetterReplayService,
} from './dead-letter-replay.service';

/** 内存仓储替身：可切换"MySQL 故障/恢复" */
class FakeDeadLetterRepo {
  rows: Array<Partial<AiDeadLetterEntity>> = [];
  failInsert = false;

  insert = jest.fn((entity: Partial<AiDeadLetterEntity>) => {
    if (this.failInsert) {
      return Promise.reject(new Error('insert ECONNREFUSED 127.0.0.1:3306'));
    }
    this.rows.push(entity);
    return Promise.resolve({ identifiers: [{ id: String(this.rows.length) }] });
  });
}

/**
 * 内存 Stream 替身：实现 XADD / XGROUP / XREADGROUP(0 与 >) / XACK / XLEN 语义
 */
class FakeRedisStream {
  entries: Array<{ id: string; fields: string[] }> = [];
  pending = new Set<string>();
  acked: string[] = [];
  terminal: string[][] = [];
  depth = 0;
  private cursor = 0;
  private seq = 0;
  /** 让所有 stream 命令抛错（模拟 Redis 不可用 / 消费自身失败） */
  broken = false;

  xadd = jest.fn((key: string, ...args: string[]) => {
    if (this.broken) {
      return Promise.reject(new Error('redis down'));
    }
    // 去掉 MAXLEN ~ n 前缀
    let rest = args;
    if (args[0] === 'MAXLEN') {
      rest = args.slice(3);
    }
    const fields = rest.slice(1); // 跳过 '*'
    const id = `${++this.seq}-0`;
    if (key === DEAD_LETTER_REPLAY_TERMINAL_STREAM) {
      this.terminal.push(fields);
      return Promise.resolve(id);
    }
    this.entries.push({ id, fields });
    return Promise.resolve(id);
  });

  xgroup = jest.fn(() => {
    if (this.broken) {
      return Promise.reject(new Error('redis down'));
    }
    return Promise.resolve('OK');
  });

  xreadgroup = jest.fn(
    (
      _group: string,
      _groupName: string,
      _consumer: string,
      _countFlag: string,
      _count: number,
      _streamsFlag: string,
      _key: string,
      cursor: string,
    ) => {
      if (this.broken) {
        return Promise.reject(new Error('redis down'));
      }
      let picked: Array<{ id: string; fields: string[] }>;
      if (cursor === '0') {
        picked = this.entries.filter((e) => this.pending.has(e.id));
      } else {
        picked = this.entries.slice(this.cursor);
        this.cursor += picked.length;
        for (const e of picked) {
          this.pending.add(e.id);
        }
      }
      if (picked.length === 0) {
        return Promise.resolve(null);
      }
      return Promise.resolve([
        [_key, picked.map((e) => [e.id, e.fields] as [string, string[]])],
      ]);
    },
  );

  xack = jest.fn((_key: string, _group: string, id: string) => {
    if (this.broken) {
      return Promise.reject(new Error('redis down'));
    }
    this.pending.delete(id);
    this.acked.push(id);
    return Promise.resolve(1);
  });

  xlen = jest.fn(() => {
    if (this.broken) {
      return Promise.reject(new Error('redis down'));
    }
    return Promise.resolve(this.depth);
  });
}

interface Harness {
  replay: DeadLetterReplayService;
  sink: DeadLetterSinkService;
  repo: FakeDeadLetterRepo;
  redis: FakeRedisStream;
  getSharedClient: jest.Mock;
}

function createHarness(env: Record<string, string> = {}): Harness {
  const repo = new FakeDeadLetterRepo();
  const redis = new FakeRedisStream();
  const getSharedClient = jest.fn(() => redis);
  const redisProvider = { getSharedClient } as unknown as RedisProvider;
  const configService = {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;

  const replay = new DeadLetterReplayService(
    configService,
    redisProvider,
    repo as unknown as Repository<AiDeadLetterEntity>,
  );
  const sink = new DeadLetterSinkService(
    configService,
    repo as unknown as Repository<AiDeadLetterEntity>,
    { query: jest.fn() } as never,
    replay,
  );
  return { replay, sink, repo, redis, getSharedClient };
}

describe('DeadLetterReplayService（死信重放队列）', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorSemanticsMetrics();
    setDefaultDeadLetterSink(null);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setDefaultDeadLetterSink(null);
  });

  it('反测 ①：MySQL 故障 ⇒ 死信进 Stream（不丢），且字段完整', async () => {
    const h = createHarness();
    h.sink.onModuleInit();
    h.repo.failInsert = true; // 模拟 MySQL 故障

    await bestEffort(() => Promise.reject(new Error('ai_db down')), {
      op: 'idem.claim',
      tenantId: 't1',
      detail: 'tool=createSalesOrder',
    });

    expect(h.sink.getStats().failed).toBe(1); // 落库失败
    expect(h.redis.entries).toHaveLength(1); // 但没丢：进了 Stream
    const fields = h.redis.entries[0].fields;
    const map = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, i) => [
        fields[i * 2],
        fields[i * 2 + 1],
      ]),
    );
    expect(map.op).toBe('idem.claim');
    expect(map.tenantId).toBe('t1');
    expect(map.detail).toBe('tool=createSalesOrder');
    expect(map.error).toBe('ai_db down');
    expect(map.level).toBe('best_effort');
    expect(map.at).toBeDefined();
    // 复用共享 provider 的 retry-forever 池（不新建连接）
    expect(h.getSharedClient).toHaveBeenCalledWith('retry-forever');
  });

  it('验收 3：MySQL 正常 ⇒ sink 直接落库，不经过 Stream（正常路径零变化）', async () => {
    const h = createHarness();
    h.sink.onModuleInit();

    await bestEffort(() => Promise.reject(new Error('x')), { op: 'ops.ok' });

    expect(h.repo.rows).toHaveLength(1);
    expect(h.redis.entries).toHaveLength(0); // Stream 为空
    expect(h.sink.getStats().persisted).toBe(1);
  });

  it('反测 ②：MySQL 恢复后消费 ⇒ 补录成功且行数对得上（XACK 摘除）', async () => {
    const h = createHarness();
    h.sink.onModuleInit();
    h.repo.failInsert = true;
    await bestEffort(() => Promise.reject(new Error('db down A')), {
      op: 'op.a',
    });
    await bestEffort(() => Promise.reject(new Error('db down B')), {
      op: 'op.b',
    });
    expect(h.redis.entries).toHaveLength(2);
    expect(h.repo.rows).toHaveLength(0);

    h.repo.failInsert = false; // MySQL 恢复
    const round = await h.replay.consume();

    expect(round.replayed).toBe(2);
    expect(h.repo.rows).toHaveLength(2); // 行数对得上
    expect(h.repo.rows.map((r) => r.op).sort()).toEqual(['op.a', 'op.b']);
    expect(h.redis.acked).toHaveLength(2);
    expect(h.redis.pending.size).toBe(0);
  });

  it('反测 ③：消费任务自身失败（Redis 不可用）⇒ 不抛、不阻塞、有告警', async () => {
    const h = createHarness();
    h.redis.broken = true;

    const round = await expect(h.replay.consume()).resolves.toEqual({
      replayed: 0,
      failed: 0,
      deferred: 0,
      terminal: 0,
      enqueued: 0,
      enqueueFailed: 0,
      depth: null,
    });
    expect(round).toBeUndefined();
    const errs = errorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('死信重放消费失败'),
    );
    expect(errs).toHaveLength(1);
  });

  it('反测 ④：超过最大重试 ⇒ 明确终态（终态流 + error 日志 + XACK 摘除，不无限循环）', async () => {
    const h = createHarness({
      DEAD_LETTER_REPLAY_MAX_ATTEMPTS: '2',
      DEAD_LETTER_REPLAY_BACKOFF_BASE_MS: '0', // 退避置零 ⇒ 立即重试，便于确定性断言
    });
    h.sink.onModuleInit();
    h.repo.failInsert = true;
    await bestEffort(() => Promise.reject(new Error('db down')), {
      op: 'op.t',
    });
    expect(h.redis.entries).toHaveLength(1);

    const first = await h.replay.consume(); // 第 1 次失败
    const second = await h.replay.consume(); // 第 2 次失败（= 上限）
    expect(first.failed).toBe(1);
    expect(second.failed).toBe(1);
    expect(second.terminal).toBe(0);

    const third = await h.replay.consume(); // 第 3 次 ⇒ 超上限 ⇒ 终态
    expect(third.terminal).toBe(1);
    expect(third.failed).toBe(0);
    expect(h.redis.terminal).toHaveLength(1); // 明确终态：转终态流
    expect(h.redis.pending.size).toBe(0); // 已摘除，不再重试
    const errs = errorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('已转终态流'),
    );
    expect(errs).toHaveLength(1);

    // 再消费：队列里已无该条目 ⇒ 不会无限循环
    const fourth = await h.replay.consume();
    expect(fourth.terminal).toBe(0);
    expect(fourth.failed).toBe(0);
    expect(fourth.replayed).toBe(0);
  });

  it('退避：失败后在退避窗口内不重试（deferred），到点后才再试', async () => {
    const h = createHarness({ DEAD_LETTER_REPLAY_BACKOFF_BASE_MS: '60000' });
    h.sink.onModuleInit();
    h.repo.failInsert = true;
    await bestEffort(() => Promise.reject(new Error('db down')), {
      op: 'op.d',
    });

    const first = await h.replay.consume();
    const insertCallsAfterFirst = h.repo.insert.mock.calls.length;
    const second = await h.replay.consume(); // 退避窗口内

    expect(first.failed).toBe(1);
    expect(second.failed).toBe(0);
    expect(second.deferred).toBe(1);
    // 退避窗口内未再次尝试补录（与首轮后的调用次数一致）
    expect(h.repo.insert.mock.calls.length).toBe(insertCallsAfterFirst);
  });

  it('可观测：XLEN 积压深度随消费返回并可单独查询', async () => {
    const h = createHarness();
    h.sink.onModuleInit();
    h.repo.failInsert = true;
    await bestEffort(() => Promise.reject(new Error('db down')), {
      op: 'op.depth',
    });
    h.redis.depth = 7;

    await expect(h.replay.getQueueDepth()).resolves.toBe(7);

    h.repo.failInsert = false;
    const round = await h.replay.consume();
    expect(round.depth).toBe(7);
    expect(h.replay.getStats().depth).toBe(7);
  });

  it('enqueue：Redis 也挂时返回 false + 计数 + error 日志（永不抛）', async () => {
    const h = createHarness();
    h.redis.broken = true;

    await expect(
      h.replay.enqueue({
        op: 'op.x',
        error: 'boom',
        level: 'best_effort',
        at: new Date().toISOString(),
      }),
    ).resolves.toBe(false);
    expect(h.replay.getStats().enqueueFailed).toBe(1);
    const errs = errorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes('死信入重放队列失败'),
    );
    expect(errs).toHaveLength(1);
  });

  it('@Cron 注册了命名消费任务（R101-AI-17 同款范式）', async () => {
    const mod = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        DeadLetterReplayService,
        {
          provide: getRepositoryToken(AiDeadLetterEntity),
          useValue: new FakeDeadLetterRepo(),
        },
        {
          provide: RedisProvider,
          useValue: { getSharedClient: jest.fn(() => new FakeRedisStream()) },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    await mod.init();

    const registry = mod.get(SchedulerRegistry);
    const job = registry.getCronJob(DEAD_LETTER_REPLAY_JOB_NAME);
    expect(job).toBeDefined();
    expect(String(job.cronTime.source)).toContain('*/5 * * * *');
    // 消费组名常量与实现一致（同组多实例自动分摊）
    expect(DEAD_LETTER_REPLAY_GROUP).toBe('ai-dead-letter-replay');
    expect(DEAD_LETTER_REPLAY_STREAM).toBe('ai:dead_letter:replay');
    await mod.close();
  });
});
