/**
 * MemoryManager 运行时行为测试（P2 返工回归 2026-10-06）
 *
 * 覆盖（验收意见指出的零信号区）：
 * 1. saveHistory 不再破坏性截断——存储层保留原文，截断只发生在
 *    loadHistory（prompt 消费端）
 * 2. Redis 'ready' 事件恢复 redisAvailable（error 后自动回到可用态）
 *
 * 用注入式 Redis 桩直接驱动私有连接字段（构造函数走 ConfigService）。
 */
/* eslint-disable @typescript-eslint/require-await -- Redis 桩方法为同步 Map 操作但须返回 Promise */
import { ConfigService } from '@nestjs/config';
import { MemoryManager, buildMemoryKey } from './memory-manager.service';

function createService(): {
  svc: MemoryManager;
  store: Map<string, string>;
  redis: {
    get: jest.Mock;
    setex: jest.Mock;
    del: jest.Mock;
    ping: jest.Mock;
    on: jest.Mock;
    watch: jest.Mock;
    multi: jest.Mock;
    unwatch: jest.Mock;
  };
} {
  const store = new Map<string, string>();
  const handlers = new Map<string, (err?: unknown) => void>();
  // WATCH 冲突模拟器：conflictOnCall 指定「第几次 exec 返回 null」
  // （null = Redis WATCH 语义：检测到 key 在 get 与 exec 之间被他人改动）
  const state = {
    watched: null as string | null,
    conflictOnCall: 0,
    execCount: 0,
  };
  const redis = {
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    setex: jest.fn(async (k: string, _ttl: number, val: string) => {
      store.set(k, val);
    }),
    del: jest.fn(async (k: string) => {
      store.delete(k);
    }),
    ping: jest.fn(async () => 'PONG'),
    on: jest.fn((event: string, handler: (err?: unknown) => void) => {
      handlers.set(event, handler);
    }),
    watch: jest.fn(async (k: string) => {
      state.watched = k;
    }),
    unwatch: jest.fn(async () => {
      state.watched = null;
    }),
    multi: jest.fn(() => makeTx(store, 0)),
  };
  const svc = new MemoryManager(
    { get: () => undefined } as unknown as ConfigService,
    { save: jest.fn() } as never,
  );
  // 注入 Redis 桩（绕过 onModuleInit 的真实连接）
  const slot = svc as unknown as Record<string, unknown>;
  slot.redis = redis;
  slot.redisAvailable = true;
  return {
    svc,
    store,
    redis: redis,
  };
}

/**
 * 构造 MULTI 事务桩
 *
 * 关键语义（对齐真实 Redis）：`setex` 只记录 payload，**exec 时才落盘**。
 * 初版桩在 setex 调用时就写 store，导致 WATCH 冲突重试时读到已写入的值
 * 而重复拼接 —— 桩本身制造了假缺陷。
 *
 * @param store 目标存储
 * @param conflictAt 第几次 exec 返回 null（WATCH 冲突）；null = 永不冲突
 */
function makeTx(
  store: Map<string, string>,
  conflictAt: number | null,
): {
  setex: jest.Mock<unknown, [string, number, string]>;
  exec: jest.Mock<Promise<Array<[string, string]> | null>, []>;
} {
  let payload: { k: string; val: string } | null = null;
  let execCount = 0;
  const tx: {
    setex: jest.Mock<unknown, [string, number, string]>;
    exec: jest.Mock<Promise<Array<[string, string]> | null>, []>;
  } = {
    setex: jest.fn((k: string, _ttl: number, val: string) => {
      payload = { k, val };
      return tx;
    }),
    exec: jest.fn(async (): Promise<Array<[string, string]> | null> => {
      execCount += 1;
      if (conflictAt !== null && execCount <= conflictAt) {
        return null;
      }
      if (payload) {
        store.set(payload.k, payload.val);
      }
      return [['setex', 'OK']];
    }),
  };
  return tx;
}

describe('MemoryManager（P2 返工回归）', () => {
  it('saveHistory 不截断：存量超长消息在存储层保留原文，截断只在 loadHistory 消费端', async () => {
    const { svc, store } = createService();
    const key = buildMemoryKey('t1', 'sess_1');
    const longContent = 'A'.repeat(1000);
    store.set(key, JSON.stringify([{ role: 'user', content: longContent }]));

    // 追加一条新消息
    await svc.saveHistory('t1', 'sess_1', [
      { role: 'assistant', content: '好的' },
    ]);

    // 存储层：旧消息仍是 1000 字符原文（此前会被永久截断到 800）
    const raw = JSON.parse(store.get(key) ?? '[]') as Array<{
      role: string;
      content: string;
    }>;
    expect(raw).toHaveLength(2);
    expect(raw[0].content).toBe(longContent);
    expect(raw[0].content).toHaveLength(1000);

    // 消费端（loadHistory）：仍按 800 截断（prompt 减负语义保留）
    const loaded = await svc.loadHistory('t1', 'sess_1');
    expect(loaded[0].content).toContain('…[已截断]');
    expect(loaded[0].content.length).toBeLessThan(1000);
  });

  it("Redis 'ready' 事件恢复 redisAvailable（error 后自动回到可用态）", async () => {
    const { svc, redis } = createService();
    const slot = svc as unknown as Record<string, unknown>;
    // 注册事件（生产中由 onModuleInit 调用）
    (svc as unknown as { bindRedisEvents: () => void }).bindRedisEvents();
    // 模拟一次 error 后的不可用态
    slot.redisAvailable = false;

    const readyHandler = (
      redis.on.mock.calls as Array<[string, (err?: unknown) => void]>
    ).find(([event]) => event === 'ready')?.[1];
    expect(readyHandler).toBeDefined();

    readyHandler!();
    expect(slot.redisAvailable).toBe(true);

    // 恢复后记忆读写可用
    await svc.saveHistory('t1', 'sess_1', [
      { role: 'user', content: '恢复后的消息' },
    ]);
    const loaded = await svc.loadHistory('t1', 'sess_1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].content).toBe('恢复后的消息');
  });

  // P2 收口回归（2026-10-06）：saveHistory 原为 get → 拼 → setex 三步分离的
  // 读改写，同会话并发（用户连发/前端重试）后写覆盖前写，整轮对话丢失。
  // 现改为 WATCH/MULTI/EXEC 乐观锁，冲突自动重试。
  it('saveHistory：WATCH 冲突 → 自动重试，最终写入不丢消息', async () => {
    const { svc, store, redis } = createService();
    const key = buildMemoryKey('t1', 'sess_concurrent');
    let attempt = 0;

    // 第 1 次 exec 冲突（WATCH 语义：key 在 get 与 exec 之间被他人改动），
    // 第 2 次成功 —— 验证冲突后自动重试且消息不丢
    redis.multi.mockImplementation(() => {
      attempt += 1;
      return makeTx(store, attempt === 1 ? 1 : 0);
    });

    await svc.saveHistory('t1', 'sess_concurrent', [
      { role: 'user', content: '并发消息' },
    ]);

    // 冲突后仍成功写入（消息没丢）
    const raw = JSON.parse(store.get(key) ?? '[]') as Array<{
      role: string;
      content: string;
    }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].content).toBe('并发消息');
    // 确实经历了重试（multi 被调用 ≥2 次）
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('saveHistory：冲突重试超限也不抛错（降级保对话不中断）', async () => {
    const { svc, store, redis } = createService();
    let attempt = 0;
    // 永远冲突（conflictAt = Number.MAX_SAFE_INTEGER ⇒ 每次 exec 都返回 null）
    redis.multi.mockImplementation(() => {
      attempt += 1;
      return makeTx(store, Number.MAX_SAFE_INTEGER);
    });

    await expect(
      svc.saveHistory('t1', 'sess_storm', [
        { role: 'user', content: '风暴中的消息' },
      ]),
    ).resolves.toBeUndefined();
    // 重试次数有上限（不会死循环）
    expect(attempt).toBeLessThanOrEqual(4);
  });

  it('saveHistory：WATCH 生效（saveHistory 前必须先 watch 该key）', async () => {
    const { svc, redis } = createService();
    await svc.saveHistory('t1', 'sess_watch', [{ role: 'user', content: 'x' }]);
    expect(redis.watch).toHaveBeenCalledWith(
      buildMemoryKey('t1', 'sess_watch'),
    );
  });
});
