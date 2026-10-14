/* eslint-disable @typescript-eslint/require-await --
 * 本类是 **ioredis 的内存替身**：命令体同步完成（单线程语义，天然原子），
 * 但**必须返回 Promise** 才能被既有消费方（`await redis.get(...)` 等）无感替换。
 * 逐个包 `Promise.resolve()` 会让 14 个方法样板化；此处集中豁免该规则。
 * 若团队要求零豁免，可改为非 async + `Promise.resolve()` 包装（行为完全等价）。
 */
/**
 * standalone（桌面嵌入）形态的**内存 Redis 客户端**（R101-AI-30）
 *
 * 目的：桌面端不连 Redis 进程，但 **写令牌索引 / 死信 Stream / 对话记忆缓存** 都依赖 Redis
 * ⇒ 内存态必须**逐项等价**，不得静默失效（凌舟口径，§"不许静默失效"）。
 *
 * 实现面（按全仓实测用法清点，缺一即静默失效）：
 * - 基础：`get` / `set`(含 `EX` / `NX`) / `setex` / `del` / `expire` / `incr` / `eval` / `on` / `status` / `quit`
 * - 集合（write-guard 写令牌索引）：`sadd` / `srem` / `smembers`
 * - 事务（write-guard 登记/释放、memory-manager 记忆写入）：`multi()` → `setex/sadd/srem/exec`
 * - 流（AI-23 死信重放）：`xadd` / `xlen` / `xreadgroup` / `xack`
 *
 * 单线程 JS 语义 ⇒ 每个命令内部同步执行，**天然原子**（`SET NX` 判定不会被并发插入打断）。
 * 过期采用**惰性 + 访问时清理**（按 `Date.now()` 比较），与 Redis 的"到期即不可见"对外等价。
 *
 * ⚠️ Lua：`write-guard` 的释放锁（CAS）与 `rate-limiter` 的令牌桶**已实现等价**（返回契约与
 *     调用方严格对齐）；**其它未知脚本一律 fail-fast 抛错**（绝不静默 no-op）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */

/** 内部条目：值 + 绝对过期时间（毫秒；null = 永不过期） */
interface Entry {
  value: string;
  expireAt: number | null;
}

/** Stream 条目（AI-23 用到的字段形态） */
interface StreamEntry {
  id: string;
  fields: string[];
}

/** multi() 链式返回（只暴露实际用到的三个命令 + exec） */
export interface MemoryMulti {
  setex(key: string, ttlSeconds: number, value: string): MemoryMulti;
  sadd(key: string, ...members: string[]): MemoryMulti;
  srem(key: string, ...members: string[]): MemoryMulti;
  exec(): Promise<Array<[Error | null, unknown]>>;
}

export class RedisMemoryClient {
  private readonly store = new Map<string, Entry>();
  private readonly sets = new Map<string, Map<string, number | null>>();
  private readonly streams = new Map<string, StreamEntry[]>();
  private readonly groupCursor = new Map<string, string>();
  private readonly pendingIds = new Map<string, Set<string>>();
  private seq = 0;

  /** ioredis 兼容：连接状态（消费方按 'ready' 判定可用） */
  readonly status = 'ready';

  /** ioredis 兼容：事件订阅（内存态无重连，仅保证调用不炸） */
  on(_event: string, _handler?: (...args: unknown[]) => void): this {
    return this;
  }

  // ── 基础面 ──

  async get(key: string): Promise<string | null> {
    const entry = this.read(key);
    return entry ? entry.value : null;
  }

  /**
   * `set` 支持 ioredis 的变参形态：`set(k,v)` / `set(k,v,'EX',ttl)` / `set(k,v,'EX',ttl,'NX')`
   *
   * `NX` 已存在 ⇒ 返回 null（与 ioredis 一致，闸门据此判"已有认领"）
   */
  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<'OK' | null> {
    let ttlSeconds: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === 'EX') {
        ttlSeconds = Number(args[i + 1]);
        i += 1;
      } else if (token === 'NX') {
        nx = true;
      } else if (token === 'PX') {
        ttlSeconds = Number(args[i + 1]) / 1000;
        i += 1;
      }
    }
    if (nx && this.read(key)) {
      return null;
    }
    this.write(key, value, ttlSeconds);
    return 'OK';
  }

  /** write-guard 令牌索引 / memory-manager 记忆写入 */
  async setex(key: string, ttlSeconds: number, value: string): Promise<'OK'> {
    this.write(key, value, Number(ttlSeconds));
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.store.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
      if (this.streams.delete(key)) removed += 1;
    }
    return removed;
  }

  /** 对已存在的键设置过期；返回 1/0（键不存在或已过期 ⇒ 0） */
  async expire(key: string, ttlSeconds: number): Promise<number> {
    const entry = this.read(key);
    if (entry) {
      entry.expireAt = Date.now() + Number(ttlSeconds) * 1000;
      return 1;
    }
    const set = this.sets.get(key);
    if (set) {
      // 集合整体 TTL：按成员过期时间统一设置（write-guard 的 AI-17 TTL 清理口径）
      const expireAt = Date.now() + Number(ttlSeconds) * 1000;
      for (const member of set.keys()) set.set(member, expireAt);
      return 1;
    }
    return 0;
  }

  async incr(key: string): Promise<number> {
    const entry = this.read(key);
    const next = (entry ? Number(entry.value) : 0) + 1;
    const ttl = entry ? this.ttlSecondsOf(entry) : null;
    this.write(key, String(next), ttl);
    return next;
  }

  // ── 集合面（write-guard 写令牌索引）──

  async sadd(key: string, ...members: string[]): Promise<number> {
    let added = 0;
    let set = this.sets.get(key);
    if (!set) {
      set = new Map<string, number | null>();
      this.sets.set(key, set);
    }
    for (const member of members) {
      if (!set.has(member)) {
        set.set(member, null);
        added += 1;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    if (set.size === 0) this.sets.delete(key);
    return removed;
  }

  /** 列待确认写（write-guard `listPending`）：已过期成员不返回 */
  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    if (!set) return [];
    const now = Date.now();
    const alive: string[] = [];
    for (const [member, expireAt] of set.entries()) {
      if (expireAt !== null && expireAt <= now) {
        set.delete(member);
        continue;
      }
      alive.push(member);
    }
    if (set.size === 0) this.sets.delete(key);
    return alive;
  }

  // ── 事务面（write-guard 登记/释放、memory-manager 记忆写入）──

  multi(): MemoryMulti {
    const queued: Array<() => Promise<unknown>> = [];
    const chain: MemoryMulti = {
      setex: (key, ttl, value) => {
        queued.push(() => this.setex(key, ttl, value));
        return chain;
      },
      sadd: (key, ...members) => {
        queued.push(() => this.sadd(key, ...members));
        return chain;
      },
      srem: (key, ...members) => {
        queued.push(() => this.srem(key, ...members));
        return chain;
      },
      exec: async () => {
        // 串行执行（单线程语义：与 Redis MULTI/EXEC 的"不被其它命令插入"等价）
        const results: Array<[Error | null, unknown]> = [];
        for (const task of queued) {
          try {
            results.push([null, await task()]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        queued.length = 0;
        return results;
      },
    };
    return chain;
  }

  // ── 流面（AI-23 死信重放）──

  /** `xadd(key, id, ...fields)`：id 传 '*' 时自动生成递增 ID */
  async xadd(key: string, id: string, ...fields: string[]): Promise<string> {
    const list = this.streams.get(key) ?? [];
    if (!this.streams.has(key)) this.streams.set(key, list);
    const resolvedId = !id || id === '*' ? `${Date.now()}-${++this.seq}` : id;
    list.push({ id: resolvedId, fields });
    return resolvedId;
  }

  async xlen(key: string): Promise<number> {
    return (this.streams.get(key) ?? []).length;
  }

  /**
   * `xreadgroup(group, consumer, key, id, count)`
   *
   * 简易消费组：游标按 `key:group` 记录"最后投递 ID"，只投递**游标之后**的条目
   * （支持 `>`；其它 ID 形态按从头投递处理，够 AI-23 复跑用）。
   * 投递即进 pending，`xack` 后移出。
   */
  async xreadgroup(
    group: string,
    _consumer: string,
    key: string,
    id: string,
    count: number,
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    const list = this.streams.get(key) ?? [];
    const cursorKey = `${key}:${group}`;
    const last = this.groupCursor.get(cursorKey);
    let candidates: StreamEntry[];
    if (id === '>' || !last) {
      candidates = last
        ? list.filter((e) => this.isAfter(e.id, last))
        : list.slice();
    } else {
      candidates = list.slice();
    }
    const taken = candidates.slice(0, count > 0 ? count : candidates.length);
    if (taken.length === 0) return null;
    const lastDelivered = taken[taken.length - 1].id;
    this.groupCursor.set(cursorKey, lastDelivered);
    const pending = this.pendingIds.get(cursorKey) ?? new Set<string>();
    for (const entry of taken) pending.add(entry.id);
    this.pendingIds.set(cursorKey, pending);
    return [[key, taken.map((e) => [e.id, e.fields] as [string, string[]])]];
  }

  async xack(key: string, group: string, id: string): Promise<number> {
    const pending = this.pendingIds.get(`${key}:${group}`);
    if (!pending || !pending.delete(id)) return 0;
    return 1;
  }

  // ── Lua（已知两脚本有等价实现；未知脚本 fail-fast）──

  /**
   * `eval` 分派：按脚本内**特征串**识别已知脚本，其余 **fail-fast 抛错**（绝不静默 no-op）
   *
   * 已实现等价的两个脚本（返回契约**严格对齐调用方**）：
   * 1. `write-guard.LOCK_RELEASE_LUA` —— CAS 释放锁：值等于持有者才删；返回 `1`（已删）/`0`
   * 2. `rate-limiter.RATE_LIMITER_LUA` —— 令牌桶：
   *    `KEYS=[tokens_key, ts_key]`、`ARGV=[now, capacity, refill_per_ms, requested, ttl_ms]`；
   *    按 `(now-ts)*refill` 补桶并封顶 capacity，够则扣减；两键按 `PX ttl_ms` 续期；
   *    返回 `[allowed(1/0), floor(tokens)]`
   */
  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const keys = args.slice(0, numKeys).map((v) => String(v));
    const argv = args.slice(numKeys).map((v) => String(v));

    // ① write-guard 释放锁（CAS）
    if (script.includes('== ARGV[1] then return redis.call')) {
      return this.evalReleaseIfMatches(keys[0], argv[0]);
    }
    // ② rate-limiter 令牌桶
    if (script.includes('refill_per_ms')) {
      return this.evalTokenBucket(keys, argv);
    }
    throw new Error(
      'standalone 内存 Redis 不支持该 Lua 脚本（fail-fast，避免静默失效）：' +
        `${script.slice(0, 60).replace(/\s+/g, ' ')}…`,
    );
  }

  /** CAS 释放锁：仅当当前值 === 持有者 token 时删除（对齐 Lua 的 1/0 返回） */
  private async evalReleaseIfMatches(
    key: string,
    owner: string,
  ): Promise<number> {
    const current = await this.get(key);
    if (current !== null && current === owner) {
      return this.del(key);
    }
    return 0;
  }

  /** 令牌桶：与 RATE_LIMITER_LUA 逐行等价（含 PX 续期与 floor 返回） */
  private async evalTokenBucket(
    keys: string[],
    argv: string[],
  ): Promise<[number, number]> {
    const [tokensKey, tsKey] = keys;
    const now = Number(argv[0]);
    const capacity = Number(argv[1]);
    const refillPerMs = Number(argv[2]);
    const requested = Number(argv[3]);
    const ttlMs = Number(argv[4]);

    const rawTokens = await this.get(tokensKey);
    const rawTs = await this.get(tsKey);
    let tokens = rawTokens === null ? capacity : Number(rawTokens);
    const ts = rawTs === null ? now : Number(rawTs);

    let delta = (now - ts) * refillPerMs;
    if (delta < 0) delta = 0;
    tokens += delta;
    if (tokens > capacity) tokens = capacity;

    let allowed = 0;
    if (tokens >= requested) {
      tokens -= requested;
      allowed = 1;
    }

    await this.set(tokensKey, String(tokens), 'PX', ttlMs);
    await this.set(tsKey, String(now), 'PX', ttlMs);
    return [allowed, Math.floor(tokens)];
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    this.sets.clear();
    this.streams.clear();
    return 'OK';
  }

  async disconnect(): Promise<void> {
    await this.quit();
  }

  // ── 内部 ──

  private read(key: string): Entry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expireAt !== null && entry.expireAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry;
  }

  private write(key: string, value: string, ttlSeconds: number | null): void {
    this.store.set(key, {
      value,
      expireAt:
        ttlSeconds === null || Number.isNaN(ttlSeconds)
          ? null
          : Date.now() + ttlSeconds * 1000,
    });
  }

  private ttlSecondsOf(entry: Entry): number | null {
    if (entry.expireAt === null) return null;
    return Math.max(0, (entry.expireAt - Date.now()) / 1000);
  }

  /** Stream ID 比较（`<ms>-<seq>` 形态；非法 ID 走字典序兜底） */
  private isAfter(a: string, b: string): boolean {
    const pa = a.split('-').map((n) => Number(n));
    const pb = b.split('-').map((n) => Number(n));
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return a > b;
    if (pa[0] !== pb[0]) return pa[0] > pb[0];
    return (pa[1] ?? 0) > (pb[1] ?? 0);
  }
}
