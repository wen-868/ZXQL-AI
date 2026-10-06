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
  };
} {
  const store = new Map<string, string>();
  const handlers = new Map<string, (err?: unknown) => void>();
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
});
