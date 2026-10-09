/**
 * P0-1 WriteGuardService 单元测试
 *
 * 覆盖：
 * 1. suspend/get/listPending — 令牌生成 + 24h TTL + 租户隔离
 * 2. confirm — 非高危一次放行 / 高危二次确认 / 复用拒绝
 * 3. cancel — 取消 + 已确认不可取消
 * 4. cleanupExpired + maskToken 脱敏
 *
 * 存储：测试环境无 Redis（不调用 onModuleInit），自动走内存降级模式。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { ConfigService } from '@nestjs/config';
import { RedisProvider } from '../common/redis.provider';
import {
  WriteGuardService,
  WRITE_TOKEN_TTL_MS,
  WRITE_TOKEN_TTL_HOURS_KEY,
  maskToken,
  resolveWriteTokenTtlMs,
} from './write-guard.service';

function createService(env: Record<string, string> = {}): WriteGuardService {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  // R101-AI-10：Redis 连接改由共享 provider 提供（本用例不调用 onModuleInit ⇒ 不建连）
  return new WriteGuardService(config, new RedisProvider(config));
}

describe('P0-1 WriteGuardService', () => {
  let service: WriteGuardService;

  beforeEach(() => {
    service = createService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const baseInput = {
    tenantId: 'tenant-A',
    conversationId: 'conv-1',
    toolName: 'createSalesOrder',
    docType: 'sales_order_create',
    risk: 'medium' as const,
    needsReview: false,
    args: { customerId: 1, items: [{ skuId: 101, boxQty: 5 }] },
    preview: {
      operation: '创建销售单',
      summary: '红星商行 5 箱五粮液，合计 4900 元',
      details: { customerName: '红星商行', totalAmount: 4900 },
    },
    operationLabel: '创建销售单',
  };

  describe('suspend/get/listPending', () => {
    it('挂起应生成 wg_ 令牌，TTL 24 小时，状态 pending', async () => {
      const write = await service.suspend(baseInput);

      expect(write.token).toMatch(/^wg_/);
      expect(write.status).toBe('pending');
      expect(write.confirmCount).toBe(0);
      expect(write.expiresAt - write.createdAt).toBe(WRITE_TOKEN_TTL_MS);
      expect(WRITE_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
      expect(write.docType).toBe('sales_order_create');
    });

    it('get 应返回未过期记录并校验租户隔离', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.get(write.token, 'tenant-A')).not.toBeNull();
      expect(await service.get(write.token, 'tenant-B')).toBeNull();
    });

    it('get 不存在的令牌返回 null', async () => {
      expect(await service.get('wg_not-exist', 'tenant-A')).toBeNull();
    });

    it('过期令牌返回 null 并清除', async () => {
      const write = await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      expect(await service.get(write.token, 'tenant-A')).toBeNull();
      expect(await service.listPending('tenant-A')).toHaveLength(0);
    });

    it('listPending 按租户隔离且按创建时间倒序', async () => {
      await service.suspend(baseInput);
      await service.suspend({ ...baseInput, tenantId: 'tenant-B' });
      // 推进时钟确保 later 的 createdAt 更晚（同毫秒排序不稳定）
      jest.advanceTimersByTime(10);
      const later = await service.suspend(baseInput);

      const pendingA = await service.listPending('tenant-A');
      expect(pendingA).toHaveLength(2);
      expect(pendingA[0].token).toBe(later.token);
    });
  });

  describe('confirm', () => {
    it('非高危写操作一次确认即放行', async () => {
      const write = await service.suspend(baseInput);
      const result = await service.confirm(write.token, 'tenant-A');

      expect(result.success).toBe(true);
      expect(result.needsSecondConfirm).toBe(false);
      expect(result.pendingWrite?.status).toBe('confirmed');
      expect(result.pendingWrite?.confirmCount).toBe(1);
    });

    it('高危写操作首次确认进入 first_confirmed，二次确认才放行', async () => {
      const write = await service.suspend({
        ...baseInput,
        toolName: 'adjustCreditLimit',
        docType: 'credit_limit_adjust',
        risk: 'high',
        needsReview: true,
        operationLabel: '信用额度调整',
      });

      const first = await service.confirm(write.token, 'tenant-A');
      expect(first.success).toBe(true);
      expect(first.needsSecondConfirm).toBe(true);
      expect(first.pendingWrite?.status).toBe('first_confirmed');
      expect(first.pendingWrite?.confirmCount).toBe(1);

      const second = await service.confirm(write.token, 'tenant-A');
      expect(second.success).toBe(true);
      expect(second.needsSecondConfirm).toBe(false);
      expect(second.pendingWrite?.status).toBe('confirmed');
      expect(second.pendingWrite?.confirmCount).toBe(2);
    });

    it('needsReview=true 即使 medium 风险也触发二次确认', async () => {
      const write = await service.suspend({
        ...baseInput,
        toolName: 'createPlatformAnnouncement',
        risk: 'medium',
        needsReview: true,
      });
      const first = await service.confirm(write.token, 'tenant-A');
      expect(first.needsSecondConfirm).toBe(true);
    });

    it('确认后令牌不可复用', async () => {
      const write = await service.suspend(baseInput);
      await service.confirm(write.token, 'tenant-A');
      const again = await service.confirm(write.token, 'tenant-A');
      expect(again.success).toBe(false);
      expect(again.error).toContain('重复');
    });

    it('已取消的令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      await service.cancel(write.token, 'tenant-A');
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(false);
      // 取消后令牌即删除，按"不存在"处理（不留可复用凭证）
      expect(result.error).toContain('不存在');
    });

    it('过期令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('其他租户令牌不可确认', async () => {
      const write = await service.suspend(baseInput);
      const result = await service.confirm(write.token, 'tenant-B');
      expect(result.success).toBe(false);
      // 租户 key 隔离：跨租户一律"不存在"，不泄露令牌存在性
      expect(result.error).toContain('不存在');
    });
  });

  describe('cancel', () => {
    it('pending 可取消并移除', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.cancel(write.token, 'tenant-A')).toBe(true);
      expect(await service.get(write.token, 'tenant-A')).toBeNull();
    });

    it('first_confirmed 可取消', async () => {
      const write = await service.suspend({
        ...baseInput,
        risk: 'high',
        needsReview: true,
      });
      await service.confirm(write.token, 'tenant-A');
      expect(await service.cancel(write.token, 'tenant-A')).toBe(true);
    });

    it('已确认不可取消', async () => {
      const write = await service.suspend(baseInput);
      await service.confirm(write.token, 'tenant-A');
      expect(await service.cancel(write.token, 'tenant-A')).toBe(false);
    });

    it('其他租户不可取消', async () => {
      const write = await service.suspend(baseInput);
      expect(await service.cancel(write.token, 'tenant-B')).toBe(false);
    });
  });

  describe('批次4 运营客户端本人确认（customerScope）', () => {
    const customerInput = {
      ...baseInput,
      customerId: 'c-100',
      toolName: 'api_create_return_apply',
      docType: 'return_apply',
    };

    it('写操作绑定 customerId：本人确认放行', async () => {
      const write = await service.suspend(customerInput);
      const result = await service.confirm(write.token, 'tenant-A', 'c-100');
      expect(result.success).toBe(true);
      expect(result.pendingWrite?.status).toBe('confirmed');
    });

    it('非本人确认 → AI_012 拒绝且令牌不被消耗', async () => {
      const write = await service.suspend(customerInput);
      const result = await service.confirm(write.token, 'tenant-A', 'c-200');
      expect(result.success).toBe(false);
      expect(result.error).toContain('AI_012');
      const after = await service.get(write.token, 'tenant-A');
      expect(after?.status).toBe('pending');
    });

    it('本人确认缺 customerId → 拒绝', async () => {
      const write = await service.suspend(customerInput);
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(false);
      expect(result.error).toContain('AI_012');
    });

    it('非客户写操作不要求 customerId（兼容管理端）', async () => {
      const write = await service.suspend(baseInput);
      const result = await service.confirm(write.token, 'tenant-A');
      expect(result.success).toBe(true);
    });
  });

  describe('cleanupExpired / maskToken', () => {
    it('cleanupExpired 清理内存模式过期令牌', async () => {
      await service.suspend(baseInput);
      jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
      expect(service.cleanupExpired()).toBe(1);
      expect(await service.listPending('tenant-A')).toHaveLength(0);
    });

    it('maskToken 应脱敏令牌（保留首尾）', () => {
      const masked = maskToken('wg_12345678-1234-1234-1234-123456789abc');
      expect(masked).toContain('…');
      expect(masked.startsWith('wg_12345')).toBe(true);
      expect(masked.endsWith('9abc')).toBe(true);
      expect(masked).not.toContain('1234-1234-1234-1234');
    });
  });

  // ── 5. TTL 可配置（WRITE_TOKEN_TTL_HOURS）──
  describe('写审核令牌 TTL 可配置', () => {
    it('未配置时回落默认 24 小时（行为与改造前一致）', () => {
      expect(resolveWriteTokenTtlMs(undefined)).toBe(WRITE_TOKEN_TTL_MS);
      expect(resolveWriteTokenTtlMs('')).toBe(WRITE_TOKEN_TTL_MS);
      expect(createService().getTokenTtlMs()).toBe(WRITE_TOKEN_TTL_MS);
    });

    it('合法值应按小时换算', () => {
      expect(resolveWriteTokenTtlMs('2')).toBe(2 * 60 * 60 * 1000);
      expect(resolveWriteTokenTtlMs(8)).toBe(8 * 60 * 60 * 1000);
      expect(resolveWriteTokenTtlMs('1.5')).toBe(90 * 60 * 1000);
    });

    it('非法值（非数字/≤0）回落默认并告警', () => {
      const warn = jest.fn();
      expect(resolveWriteTokenTtlMs('abc', warn)).toBe(WRITE_TOKEN_TTL_MS);
      expect(resolveWriteTokenTtlMs('-1', warn)).toBe(WRITE_TOKEN_TTL_MS);
      expect(resolveWriteTokenTtlMs('0', warn)).toBe(WRITE_TOKEN_TTL_MS);
      expect(warn).toHaveBeenCalledTimes(3);
    });

    it('越界值应钳制到 [1, 720] 并告警', () => {
      const warn = jest.fn();
      // 0.5 小时太短，用户来不及确认 → 钳到 1 小时
      expect(resolveWriteTokenTtlMs('0.5', warn)).toBe(60 * 60 * 1000);
      // 8760 小时 = 一年，令牌常年不释放 → 钳到 720 小时（30 天）
      expect(resolveWriteTokenTtlMs('8760', warn)).toBe(720 * 60 * 60 * 1000);
      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('服务实例应读取环境变量且与 suspend 的 expiresAt 对齐', async () => {
      const svc = createService({ [WRITE_TOKEN_TTL_HOURS_KEY]: '2' });
      expect(svc.getTokenTtlMs()).toBe(2 * 60 * 60 * 1000);

      const record = await svc.suspend(baseInput);
      expect(record.expiresAt - record.createdAt).toBe(2 * 60 * 60 * 1000);
    });

    it('配短 TTL 后令牌应在 2 小时后过期（而非默认 24 小时）', async () => {
      const svc = createService({ [WRITE_TOKEN_TTL_HOURS_KEY]: '2' });
      await svc.suspend(baseInput);

      jest.advanceTimersByTime(2 * 60 * 60 * 1000 - 1000);
      expect(await svc.listPending('tenant-A')).toHaveLength(1);

      jest.advanceTimersByTime(2000);
      expect(await svc.listPending('tenant-A')).toHaveLength(0);
    });
  });
});

// P2 返工回归（验收意见）：NX 锁与 owner CAS 的直接信号
describe('WriteGuardService 令牌锁（NX + owner CAS）', () => {
  interface LockApi {
    acquireTokenLock: (t: string) => Promise<{ ok: boolean; owner?: string }>;
    releaseTokenLock: (t: string, o: string) => Promise<void>;
  }
  function createRedisBackedService(): {
    svc: LockApi;
    store: Map<string, string>;
  } {
    const svc = createService();
    const store = new Map<string, string>();
    const redis = {
      set: jest.fn((key: string, val: string): Promise<string | null> => {
        if (store.has(key)) return Promise.resolve(null); // NX：已存在即失败
        store.set(key, val);
        return Promise.resolve('OK');
      }),
      eval: jest.fn(
        (
          _lua: string,
          _n: number,
          key: string,
          owner: string,
        ): Promise<number> => {
          if (store.get(key) === owner) {
            store.delete(key);
            return Promise.resolve(1);
          }
          return Promise.resolve(0);
        },
      ),
    };
    const slot = svc as unknown as Record<string, unknown>;
    slot.redis = redis;
    slot.redisAvailable = true;
    return { svc: svc as unknown as LockApi, store };
  }

  it('互斥：未释放前第二次获取失败', async () => {
    const { svc } = createRedisBackedService();

    const first = await svc.acquireTokenLock('wg_tok');
    expect(first.ok).toBe(true);

    const second = await svc.acquireTokenLock('wg_tok');
    expect(second.ok).toBe(false);
  });

  it('owner CAS：错误 owner 释放不删锁，正确 owner 释放后可重新获取', async () => {
    const { svc, store } = createRedisBackedService();

    const first = await svc.acquireTokenLock('wg_tok');
    expect(first.ok).toBe(true);

    // 误删防护（此前无条件 del 的缺陷）：错误 owner 释放后锁仍在
    await svc.releaseTokenLock('wg_tok', 'not-the-owner');
    expect(store.get('ai:wg:lock:wg_tok')).toBeDefined();

    // 正确 owner 释放 → 可再次获取
    await svc.releaseTokenLock('wg_tok', first.owner!);
    expect(store.has('ai:wg:lock:wg_tok')).toBe(false);
    const again = await svc.acquireTokenLock('wg_tok');
    expect(again.ok).toBe(true);
  });
});

/**
 * P1 修复回归（2026-10-10）：write-guard Redis 索引集合 TTL
 *
 * 缺陷：`save()` 的 MULTI 只给令牌 key 下发 setex，索引集合 `sadd` 后无
 * expire ⇒ 索引永驻内存；smembers 读索引时把早已过期的陈旧 token 读回，
 * 写令牌互斥判定失真（全仓 `.expire(` 零命中）。
 *
 * 本组用例对「带 TTL 语义的模拟 Redis」下发的命令序列与读回结果双向取值：
 * - 结构：MULTI 内必须有 expire(indexKey, ttl)，且 ttl 与 setex 同一取值
 * - 行为：令牌 TTL 走完后索引必须一并消失（陈旧 token 不再被读回）
 *
 * 反测方向：删掉 `.expire(` 或把 ttl 改成 0 ⇒ 第 1、2 条断言变红。
 */
describe('P1 修复：WriteGuard Redis 索引集合 TTL', () => {
  /** 管道内单条命令 */
  interface Op {
    kind: 'setex' | 'sadd' | 'expire' | 'del' | 'srem';
    args: unknown[];
  }

  /** 带 TTL 语义的模拟 Redis：无 expire 的键永不过期（复现缺陷现场） */
  function createTtlAwareRedis(env: Record<string, string> = {}) {
    const kv = new Map<string, { value: string; expireAt: number | null }>();
    const sets = new Map<
      string,
      { members: Set<string>; expireAt: number | null }
    >();
    /** 全部已执行管道命令（断言 expire 是否下发） */
    const executed: Op[] = [];

    const sweep = (
      m: Map<string, { expireAt: number | null }>,
      key: string,
    ): void => {
      const entry = m.get(key);
      if (entry && entry.expireAt !== null && Date.now() > entry.expireAt) {
        m.delete(key);
      }
    };

    const apply = (ops: Op[]): void => {
      for (const op of ops) {
        if (op.kind === 'setex') {
          const [key, ttl, value] = op.args as [string, number, string];
          kv.set(key, { value, expireAt: Date.now() + ttl * 1000 });
        } else if (op.kind === 'sadd') {
          const [key, member] = op.args as [string, string];
          const entry = sets.get(key) ?? {
            members: new Set<string>(),
            expireAt: null, // 无 expire ⇒ 永不过期（缺陷原状）
          };
          entry.members.add(member);
          sets.set(key, entry);
        } else if (op.kind === 'expire') {
          const [key, ttl] = op.args as [string, number];
          const setEntry = sets.get(key);
          if (setEntry) {
            setEntry.expireAt = Date.now() + ttl * 1000;
          }
          const kvEntry = kv.get(key);
          if (kvEntry) {
            kvEntry.expireAt = Date.now() + ttl * 1000;
          }
        } else if (op.kind === 'del') {
          kv.delete(op.args[0] as string);
        } else {
          const [key, member] = op.args as [string, string];
          sets.get(key)?.members.delete(member);
        }
      }
    };

    const multi = () => {
      const ops: Op[] = [];
      const pipeline: Record<string, unknown> = {
        setex: (key: string, ttl: number, value: string) => {
          ops.push({ kind: 'setex', args: [key, ttl, value] });
          return pipeline;
        },
        sadd: (key: string, member: string) => {
          ops.push({ kind: 'sadd', args: [key, member] });
          return pipeline;
        },
        expire: (key: string, ttl: number) => {
          ops.push({ kind: 'expire', args: [key, ttl] });
          return pipeline;
        },
        del: (key: string) => {
          ops.push({ kind: 'del', args: [key] });
          return pipeline;
        },
        srem: (key: string, member: string) => {
          ops.push({ kind: 'srem', args: [key, member] });
          return pipeline;
        },
        exec: () => {
          executed.push(...ops);
          apply(ops);
          return Promise.resolve([]);
        },
      };
      return pipeline;
    };

    const redis = {
      multi,
      get: (key: string) => {
        sweep(kv, key);
        return Promise.resolve(kv.get(key)?.value ?? null);
      },
      smembers: (key: string) => {
        sweep(sets, key);
        return Promise.resolve([...(sets.get(key)?.members ?? [])]);
      },
    };

    const svc = createService(env);
    const slot = svc as unknown as Record<string, unknown>;
    slot.redis = redis;
    slot.redisAvailable = true;

    return { svc, executed, redis };
  }

  const INDEX_KEY = 'ai:writeguard:idx:tenant-A';

  /** 本组用例自带输入（baseInput 属上一 describe 作用域，不可跨块引用） */
  const ttlInput = {
    tenantId: 'tenant-A',
    conversationId: 'conv-ttl',
    toolName: 'createSalesOrder',
    docType: 'sales_order_create',
    risk: 'medium' as const,
    needsReview: false,
    args: { customerId: 1 },
    operationLabel: '创建销售单',
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('suspend 的 MULTI 必须对索引集合下发 expire，且 TTL 与令牌 key 同一取值', async () => {
    const { svc, executed } = createTtlAwareRedis();
    await svc.suspend(ttlInput);

    const setex = executed.find((op) => op.kind === 'setex');
    const expire = executed.find((op) => op.kind === 'expire');

    // 反测锚点：删掉 .expire( ⇒ 此条变红
    expect(expire).toBeDefined();
    expect(expire!.args[0]).toBe(INDEX_KEY);
    // 与令牌 key 对齐（秒）：24h ⇒ 86400
    expect(expire!.args[1]).toBe(Math.ceil(WRITE_TOKEN_TTL_MS / 1000));
    expect(expire!.args[1]).toBe(setex!.args[1]);
  });

  it('索引 TTL 不得短于令牌有效期（令牌还在、索引不能被先清）', async () => {
    const { svc, executed } = createTtlAwareRedis();
    await svc.suspend(ttlInput);

    const setex = executed.find((op) => op.kind === 'setex')!;
    const expire = executed.find((op) => op.kind === 'expire')!;

    expect(expire.args[1] as number).toBeGreaterThanOrEqual(
      setex.args[1] as number,
    );
    // 且必须为正：ttl=0 会立即清键 ⇒ 索引形同不存在
    expect(expire.args[1] as number).toBeGreaterThan(0);
  });

  it('TTL 可配时索引 TTL 同步跟随（WRITE_TOKEN_TTL_HOURS=2 ⇒ 7200s）', async () => {
    const { svc, executed } = createTtlAwareRedis({
      [WRITE_TOKEN_TTL_HOURS_KEY]: '2',
    });
    await svc.suspend(ttlInput);

    const setex = executed.find((op) => op.kind === 'setex')!;
    const expire = executed.find((op) => op.kind === 'expire')!;

    expect(setex.args[1]).toBe(7200);
    expect(expire.args[1]).toBe(7200);
    expect(expire.args[0]).toBe(INDEX_KEY);
  });

  it('行为：令牌 TTL 走完后索引一并过期，smembers 不再读回陈旧 token', async () => {
    const { svc, redis } = createTtlAwareRedis();
    const write = await svc.suspend(ttlInput);

    // TTL 内：索引在，令牌可读
    expect(await redis.smembers(INDEX_KEY)).toEqual([write.token]);
    expect(await svc.listPending('tenant-A')).toHaveLength(1);

    // 越过 24h：索引随 TTL 消失（无 expire 时此处仍返回陈旧 token）
    jest.advanceTimersByTime(WRITE_TOKEN_TTL_MS + 1000);
    expect(await redis.smembers(INDEX_KEY)).toEqual([]);
    expect(await svc.listPending('tenant-A')).toHaveLength(0);
  });

  it('行为：连续挂起共享同一索引，expire 每次续期（不早于最后一条令牌过期）', async () => {
    const { svc, redis } = createTtlAwareRedis();
    const first = await svc.suspend(ttlInput);
    jest.advanceTimersByTime(12 * 60 * 60 * 1000); // 推进 12h
    const second = await svc.suspend(ttlInput);

    expect(await redis.smembers(INDEX_KEY)).toHaveLength(2);

    // 首个令牌已过 24h，但索引已被第二次写入续期 ⇒ 两条都还在
    jest.advanceTimersByTime(12 * 60 * 60 * 1000 + 1000);
    const remaining = await redis.smembers(INDEX_KEY);
    expect(remaining).toContain(second.token);
    expect(remaining).toContain(first.token); // 索引未早于令牌被清
  });
});
