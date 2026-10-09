/**
 * RedisProvider 单元测试（R101-AI-15）
 *
 * 补齐 R101-AI-10（共享 Redis provider）的规格断言与反测护栏：
 * 1. 按策略分池：stop-after-3 三处共用一池 / retry-forever 独池（同策略同实例、
 *    异策略异实例，且构造总次数 = 长连接数 2）
 * 2. 健康探针一次性实例：createEphemeralClient —— 3s 连接超时、retryStrategy=>
 *    null（不重连）、每次调用新建（调用方负责 disconnect）
 * 3. 「全仓唯一 new Redis( 落点」护栏：扫描 src 下**非 spec** 的 .ts 源码
 *    （剥离注释后计数——provider 头部 JSDoc 本身含该字面量），断言仅
 *    redis.provider.ts 的 `private newClient` 一处；5 个调用点文件 newRedis=0
 *    且 provider 引用仍在
 * 4. 降级行为逐条断言（对照派单表，5 个模块各一条，文案逐字保留）
 *
 * 反测方向：把任一调用点改回 `new Redis()` ⇒ 第 3 节护栏断言变红（见回传卡）。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-10
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { RateLimiterService } from './rate-limiter';
import { RedisProvider } from './redis.provider';
import { MemoryManager } from '../brain/memory-manager.service';
import { WriteGuardService } from '../brain/write-guard.service';
import { CheckpointerService } from '../brain/graph/checkpointer.service';

/**
 * mock ioredis：捕获全部实例与构造参数（不引用工厂外变量，避免提升顺序问题）。
 * 本 spec 需要「多实例 + 逐实例 options」语义，与 rate-limiter.spec 的单例 mock 不同。
 */
jest.mock('ioredis', () => {
  const instances: Array<{
    options: Record<string, unknown>;
    ping: unknown;
    on: unknown;
    disconnect: unknown;
  }> = [];
  class RedisMock {
    static all = instances;
    options: Record<string, unknown>;
    ping: unknown;
    on: unknown;
    disconnect: unknown;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.ping = jest.fn();
      this.on = jest.fn();
      this.disconnect = jest.fn();
      instances.push(this);
    }
  }
  return { __esModule: true, default: RedisMock };
});

/** 被 mock 的 Redis 构造函数（all = 本文件创建的全部实例） */
const redisCtor = Redis as unknown as {
  all: Array<{
    options: Record<string, unknown>;
    ping: jest.Mock;
    on: jest.Mock;
    disconnect: jest.Mock;
  }>;
};

const SRC_ROOT = resolve(__dirname, '..');

/** 递归列出目录下全部 .ts 文件 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 剥离块注释与行注释后返回代码文本（护栏计数用；字符串内含注释符的场景不受支持，已在本仓核对无此情况） */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** 统计某文件（剥注释后）new Redis( 出现次数 */
function countNewRedis(file: string): number {
  const code = stripComments(readFileSync(file, 'utf8'));
  return (code.match(/new Redis\(/g) ?? []).length;
}

function createConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

function makeConfig(): ConfigService {
  return createConfigService({
    REDIS_HOST: '127.0.0.1',
    REDIS_PORT: '1', // 无效端口：即使 mock 失效也不会真正建连成功
    REDIS_DB: '1',
  });
}

beforeEach(() => {
  redisCtor.all.length = 0;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('R101-AI-15 按重试策略分池（抽取语义：代码落点 5→1，长连接 4→2）', () => {
  it('同策略共用同一实例：stop-after-3 两次 getSharedClient 返回同一对象', () => {
    const provider = new RedisProvider(makeConfig());
    const first = provider.getSharedClient('stop-after-3');
    const second = provider.getSharedClient('stop-after-3');
    expect(second).toBe(first);
    expect(redisCtor.all).toHaveLength(1);
  });

  it('不同策略不同实例：stop-after-3 与 retry-forever 各建一条长连接', () => {
    const provider = new RedisProvider(makeConfig());
    const stopAfter3 = provider.getSharedClient('stop-after-3');
    const retryForever = provider.getSharedClient('retry-forever');
    expect(retryForever).not.toBe(stopAfter3);
    expect(redisCtor.all).toHaveLength(2); // 长连接 4→2 的机械证明
  });

  it('三条 stop-after-3 调用方（checkpointer/write-guard/rate-limiter）共享一池：同一 provider 下构造次数仍为 1', () => {
    const config = makeConfig();
    const provider = new RedisProvider(config);
    // 模拟三个调用方按各自用途取同一策略的共享客户端
    const a = provider.getSharedClient('stop-after-3', () => undefined);
    const b = provider.getSharedClient('stop-after-3', () => undefined);
    const c = provider.getSharedClient('stop-after-3');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(redisCtor.all).toHaveLength(1);
  });

  it('giveUp 回调按策略注册互不串扰：stop-after-3 放弃时触发注册方回调，retry-forever 不触发', () => {
    const provider = new RedisProvider(makeConfig());
    const onGiveUp = jest.fn();
    provider.getSharedClient('stop-after-3', onGiveUp);
    const stopClient = provider.getSharedClient('stop-after-3');
    const stopStrategy = stopClient.options.retryStrategy as (
      times: number,
    ) => number | null;
    stopStrategy(4); // times > 3 → 放弃
    expect(onGiveUp).toHaveBeenCalledTimes(1);

    const foreverClient = provider.getSharedClient('retry-forever');
    const foreverStrategy = foreverClient.options.retryStrategy as (
      times: number,
    ) => number | null;
    foreverStrategy(4);
    foreverStrategy(10000);
    expect(onGiveUp).toHaveBeenCalledTimes(1); // retry-forever 永不放弃 ⇒ 回调不再触发
  });
});

describe('R101-AI-15 健康探针一次性实例（createEphemeralClient）', () => {
  it('默认 3s 连接超时 + retryStrategy=()=>null（不重连、快速失败）', () => {
    const provider = new RedisProvider(makeConfig());
    const client = provider.createEphemeralClient();
    expect(client.options.connectTimeout).toBe(3000);
    const strategy = client.options.retryStrategy as () => number | null;
    expect(strategy()).toBeNull();
    expect(strategy()).toBeNull(); // 任何一次重试询问都立即放弃
  });

  it('每次调用新建实例（无复用、无池化），调用方负责 disconnect', () => {
    const provider = new RedisProvider(makeConfig());
    const first = provider.createEphemeralClient(3000);
    const second = provider.createEphemeralClient(3000);
    expect(second).not.toBe(first);
    expect(redisCtor.all).toHaveLength(2);
    expect(typeof first.disconnect).toBe('function');
    expect(typeof second.disconnect).toBe('function');
  });

  it('超时毫秒可传参覆盖（admin.controller.ts:452 传 3000，与原实现口径一致）', () => {
    const provider = new RedisProvider(makeConfig());
    expect(provider.createEphemeralClient(1234).options.connectTimeout).toBe(
      1234,
    );
    expect(provider.createEphemeralClient(3000).options.connectTimeout).toBe(
      3000,
    );
  });
});

describe('R101-AI-15 「全仓唯一 new Redis( 落点」护栏（剥注释计数）', () => {
  const ALL_TS = listSourceFiles(SRC_ROOT);
  const IMPL_TS = ALL_TS.filter((f) => !f.endsWith('.spec.ts'));

  it('src 下非 spec 的 .ts：new Redis( 仅 1 处，且落在 redis.provider.ts 的 newClient', () => {
    const hits = IMPL_TS.filter((f) => countNewRedis(f) > 0).map((f) =>
      basename(f),
    );
    expect(hits).toEqual(['redis.provider.ts']);
    const providerCode = stripComments(
      readFileSync(join(SRC_ROOT, 'common', 'redis.provider.ts'), 'utf8'),
    );
    expect(providerCode.match(/new Redis\(/g) ?? []).toHaveLength(1);
    expect(providerCode).toContain('private newClient');
  });

  it.each([
    'brain/graph/checkpointer.service.ts',
    'brain/write-guard.service.ts',
    'common/rate-limiter.ts',
    'brain/memory-manager.service.ts',
    'gateway/admin.controller.ts',
  ])('%s：newRedis=0 且 provider 引用仍在（调用点已收敛）', (rel) => {
    const file = join(SRC_ROOT, rel);
    expect(countNewRedis(file)).toBe(0);
    const raw = readFileSync(file, 'utf8');
    expect(raw).toContain('RedisProvider'); // import + 构造注入
    expect(raw).toMatch(/getSharedClient\(|createEphemeralClient\(/);
  });

  it('admin.controller.ts:452 口径：createEphemeralClient(3000)（3s 超时 + 每次新建再销毁）', () => {
    const raw = readFileSync(
      join(SRC_ROOT, 'gateway', 'admin.controller.ts'),
      'utf8',
    );
    expect(raw).toContain('createEphemeralClient(3000)');
    expect(raw).toContain('client.disconnect()'); // 无论成败均销毁
  });
});

describe('R101-AI-15 降级行为逐条断言（对照派单表，文案逐字保留）', () => {
  function captureWarn(): { lines: () => string[] } {
    const spy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    return {
      lines: () => (spy.mock.calls as unknown[][]).map((c) => String(c[0])),
    };
  }
  function strategyOf(index: number): (times: number) => number | null {
    return redisCtor.all[index].options.retryStrategy as (
      times: number,
    ) => number | null;
  }

  it('checkpointer.service.ts:45 → stop-after-3：times>3 放弃并告警「图状态降级为内存模式（跨进程不可续跑）」', async () => {
    const warnSpy = captureWarn();
    const config = makeConfig();
    const svc = new CheckpointerService(new RedisProvider(config));
    await svc.onModuleInit();

    expect(strategyOf(0)(3)).toBe(1500); // times*500，未触 cap
    expect(strategyOf(0)(4)).toBeNull(); // times>3 → null（停止重连）
    expect(
      warnSpy
        .lines()
        .some((l) => l.includes('图状态降级为内存模式（跨进程不可续跑）')),
    ).toBe(true);
  });

  it('write-guard.service.ts:267 → stop-after-3：times>3 放弃并告警「写审核令牌不跨进程持久」', async () => {
    const warnSpy = captureWarn();
    const config = makeConfig();
    const svc = new WriteGuardService(config, new RedisProvider(config));
    await svc.onModuleInit();

    expect(strategyOf(0)(4)).toBeNull();
    expect(
      warnSpy.lines().some((l) => l.includes('写审核令牌不跨进程持久')),
    ).toBe(true);
  });

  it('rate-limiter.ts:129 → stop-after-3：times>3 放弃并告警「内存令牌桶」', async () => {
    const warnSpy = captureWarn();
    const config = makeConfig();
    const svc = new RateLimiterService(config, new RedisProvider(config));
    await svc.onModuleInit();

    expect(strategyOf(0)(3)).toBe(1500);
    expect(strategyOf(0)(4)).toBeNull();
    expect(warnSpy.lines().some((l) => l.includes('内存令牌桶'))).toBe(true);
  });

  it('memory-manager.service.ts:75 → retry-forever：Math.min(times*500,5000) 持续重试，永不返回 null', async () => {
    const config = makeConfig();
    const svc = new MemoryManager(
      config,
      { save: jest.fn() } as never,
      new RedisProvider(config),
    );
    await svc.onModuleInit();

    const strategy = strategyOf(0);
    expect(strategy(1)).toBe(500);
    expect(strategy(4)).toBe(2000);
    expect(strategy(10)).toBe(5000); // 封顶 5s
    expect(strategy(10000)).toBe(5000); // 持续重试：永不放弃
  });

  it('admin.controller.ts:457 → ephemeral：()=>null + 3s 超时 + 每次新建再销毁（语义由 provider 保证）', () => {
    const provider = new RedisProvider(makeConfig());
    const first = provider.createEphemeralClient(3000);
    const second = provider.createEphemeralClient(3000);
    // 每次新建
    expect(second).not.toBe(first);
    // 3s 超时
    expect(first.options.connectTimeout).toBe(3000);
    expect(second.options.connectTimeout).toBe(3000);
    // ()=>null：不重连
    const s1 = first.options.retryStrategy as () => number | null;
    const s2 = second.options.retryStrategy as () => number | null;
    expect(s1()).toBeNull();
    expect(s2()).toBeNull();
    // 调用方销毁（disconnect 由 admin.controller 在成功/失败两分支各调一次）
    expect(typeof first.disconnect).toBe('function');
  });

  it('三型共同口径：maxRetriesPerRequest=1（命令未就绪快速失败，原 5 处一致）', () => {
    const provider = new RedisProvider(makeConfig());
    provider.getSharedClient('stop-after-3');
    provider.getSharedClient('retry-forever');
    provider.createEphemeralClient(3000);
    expect(redisCtor.all[0].options.maxRetriesPerRequest).toBe(1);
    expect(redisCtor.all[1].options.maxRetriesPerRequest).toBe(1);
    expect(redisCtor.all[2].options.maxRetriesPerRequest).toBe(1);
  });

  it('stop-after-3 无调用方回调时放弃：provider 兜底告警（不静默）', () => {
    const warnSpy = captureWarn();
    const provider = new RedisProvider(makeConfig());
    const client = provider.getSharedClient('stop-after-3');
    (client.options.retryStrategy as (t: number) => number | null)(4);
    expect(warnSpy.lines().some((l) => l.includes('无调用方回调'))).toBe(true);
  });
});
