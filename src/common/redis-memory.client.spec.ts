/**
 * standalone 内存 Redis 客户端测试（R101-AI-30）
 *
 * 覆盖**三类不得静默失效**的用法（凌舟清点口径）+ Lua fail-fast：
 * 1. 写令牌索引（write-guard）：sadd/smembers/srem + expire + multi 事务
 * 2. 死信 Stream（AI-23）：xadd/xlen/xreadgroup/xack
 * 3. 对话记忆（memory-manager）：setex + get + TTL 到期消失
 * 4. 幂等闸门第一道：SET NX（含 TTL 到期后可再认领）
 * 5. Lua：本增量**未实现等价** ⇒ 必须 fail-fast 抛错（绝不静默 no-op）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { RedisMemoryClient } from './redis-memory.client';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RedisMemoryClient（standalone 内存 Redis）', () => {
  let redis: RedisMemoryClient;
  beforeEach(() => {
    redis = new RedisMemoryClient();
  });

  describe('① 幂等闸门第一道：SET NX + TTL', () => {
    it('NX：首次成功（OK）、重复返回 null（表示已有认领）', async () => {
      expect(await redis.set('k', 'v1', 'EX', 600, 'NX')).toBe('OK');
      expect(await redis.set('k', 'v2', 'EX', 600, 'NX')).toBeNull();
      expect(await redis.get('k')).toBe('v1');
    });

    it('TTL 到期后键消失 ⇒ 可再次认领（等价 Redis 过期语义）', async () => {
      await redis.set('k', 'v1', 'EX', 0.05, 'NX');
      expect(await redis.get('k')).toBe('v1');
      await sleep(90);
      expect(await redis.get('k')).toBeNull();
      expect(await redis.set('k', 'v2', 'EX', 600, 'NX')).toBe('OK');
    });

    it('incr 累计，del 清零', async () => {
      expect(await redis.incr('n')).toBe(1);
      expect(await redis.incr('n')).toBe(2);
      expect(await redis.del('n')).toBe(1);
      expect(await redis.incr('n')).toBe(1);
    });
  });

  describe('② 写令牌索引（write-guard）：sadd/smembers/srem/expire/multi', () => {
    it('登记后 smembers 能列到；srem 后移除', async () => {
      await redis.sadd('pending', 'tok-1', 'tok-2');
      expect((await redis.smembers('pending')).sort()).toEqual([
        'tok-1',
        'tok-2',
      ]);
      expect(await redis.srem('pending', 'tok-1')).toBe(1);
      expect(await redis.smembers('pending')).toEqual(['tok-2']);
    });

    it('集合整体 expire：到期后 smembers 不再返回（AI-17 TTL 清理）', async () => {
      await redis.sadd('pending', 'tok-1');
      expect(await redis.expire('pending', 0.05)).toBe(1);
      await sleep(90);
      expect(await redis.smembers('pending')).toEqual([]);
    });

    it('multi()：setex + sadd/srem 链式执行并返回结果对', async () => {
      const results = await redis
        .multi()
        .setex('tok:1', 600, 'payload')
        .sadd('pending', 'tok-1')
        .srem('pending', 'tok-1')
        .exec();

      expect(results.map(([err]) => err)).toEqual([null, null, null]);
      expect(await redis.get('tok:1')).toBe('payload');
      expect(await redis.smembers('pending')).toEqual([]);
    });
  });

  describe('③ 死信 Stream（AI-23）：xadd/xlen/xreadgroup/xack', () => {
    it('xadd → xlen → xreadgroup 读到 → xack 后不再重复投递', async () => {
      const id1 = await redis.xadd('ai:dead:replay', '*', 'f', 'v1');
      await redis.xadd('ai:dead:replay', '*', 'f', 'v2');
      expect(await redis.xlen('ai:dead:replay')).toBe(2);

      const batch = await redis.xreadgroup(
        'g1',
        'c1',
        'ai:dead:replay',
        '>',
        1,
      );
      expect(batch).not.toBeNull();
      const entries = batch?.[0]?.[1] ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0][0]).toBe(id1);

      expect(await redis.xack('ai:dead:replay', 'g1', id1)).toBe(1);
      // 游标已前移：再读只拿到第 2 条（不重复第 1 条）
      const again = await redis.xreadgroup(
        'g1',
        'c1',
        'ai:dead:replay',
        '>',
        5,
      );
      expect((again?.[0]?.[1] ?? []).map(([id]) => id)).not.toContain(id1);
      expect((again?.[0]?.[1] ?? []).length).toBe(1);
    });

    it('xack 未登记的 id ⇒ 返回 0（不虚报）', async () => {
      expect(await redis.xack('ai:dead:replay', 'g1', '999-0')).toBe(0);
    });
  });

  describe('④ 对话记忆（memory-manager）：setex + TTL', () => {
    it('setex 后 get 能读；TTL 到期后消失', async () => {
      await redis.setex('mem:t1:s1', 600, '{"turns":[]}');
      expect(await redis.get('mem:t1:s1')).toBe('{"turns":[]}');

      await redis.setex('mem:short', 0.05, 'x');
      await sleep(90);
      expect(await redis.get('mem:short')).toBeNull();
    });
  });

  describe('⑤ Lua 等价（对齐真实调用契约）', () => {
    // 与 write-guard.service.ts:228 逐字一致
    const LOCK_RELEASE_LUA =
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

    it('write-guard 释放锁：仅持有者可释放（CAS），非持有者返回 0 且锁不动', async () => {
      await redis.set('ai:wg:lock:tok-1', 'owner-A');
      expect(
        await redis.eval(LOCK_RELEASE_LUA, 1, 'ai:wg:lock:tok-1', 'owner-B'),
      ).toBe(0);
      expect(await redis.get('ai:wg:lock:tok-1')).toBe('owner-A');
      expect(
        await redis.eval(LOCK_RELEASE_LUA, 1, 'ai:wg:lock:tok-1', 'owner-A'),
      ).toBe(1);
      expect(await redis.get('ai:wg:lock:tok-1')).toBeNull();
    });

    it('write-guard 释放锁：锁不存在/已过期 ⇒ 0（不虚报成功）', async () => {
      expect(
        await redis.eval(LOCK_RELEASE_LUA, 1, 'ai:wg:lock:missing', 'owner-A'),
      ).toBe(0);
    });

    // 与 rate-limiter.ts:49 契约一致：KEYS=[tokens,ts] ARGV=[now,capacity,refill,requested,ttl_ms]
    const RATE_LIMITER_LUA = `
local tokens_key = KEYS[1]
local refill_per_ms = tonumber(ARGV[3])
return { 0, 0 }
`;

    it('rate-limiter 令牌桶：满桶起算、按 requested 扣减、返回 [allowed, floor(remaining)]', async () => {
      const first = (await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        '1000',
        '3',
        '0',
        '1',
        '60000',
      )) as [number, number];
      expect(first).toEqual([1, 2]); // 满桶 3 - 1 = 2
      const second = (await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        '1000',
        '3',
        '0',
        '1',
        '60000',
      )) as [number, number];
      expect(second).toEqual([1, 1]);
      // 余量不足一次请求 3 ⇒ 拒绝，余量不变
      const denied = (await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        '1000',
        '3',
        '0',
        '3',
        '60000',
      )) as [number, number];
      expect(denied).toEqual([0, 1]);
    });

    it('rate-limiter 令牌桶：按 (now-ts)*refill 补桶并封顶 capacity', async () => {
      await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        '1000',
        '3',
        '0',
        '1',
        '60000',
      );
      const refilled = (await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        '2000',
        '3',
        '0.01',
        '1',
        '60000',
      )) as [number, number];
      expect(refilled).toEqual([1, 2]); // min(3, 2 + 10) = 3，扣 1 ⇒ 2
    });

    it('rate-limiter：两键按 PX 续期（TTL 到期后重新满桶）', async () => {
      await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        String(Date.now()),
        '3',
        '0',
        '3',
        '50',
      );
      expect(await redis.get('rl:tokens')).toBe('0');
      await sleep(90);
      const again = (await redis.eval(
        RATE_LIMITER_LUA,
        2,
        'rl:tokens',
        'rl:ts',
        String(Date.now()),
        '3',
        '0',
        '3',
        '60000',
      )) as [number, number];
      expect(again).toEqual([1, 0]);
    });

    it('未知 Lua 脚本 ⇒ fail-fast 抛错（绝不静默 no-op）', async () => {
      await expect(redis.eval("return redis.call('PING')", 0)).rejects.toThrow(
        /不支持该 Lua 脚本（fail-fast/,
      );
    });
  });

  it('on()/status 兼容 ioredis 消费方式（不炸）', () => {
    expect(redis.status).toBe('ready');
    expect(redis.on('error', () => undefined)).toBe(redis);
  });
});
