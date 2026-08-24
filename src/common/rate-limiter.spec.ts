/**
 * RateLimiterService 单元测试
 *
 * 覆盖：
 * 1. 容量配置（默认 60 / RATE_LIMIT_PER_MINUTE / 非法值回退）
 * 2. Redis 模式（Lua 脚本：通过 / 超限 / eval 失败降级 / 连接失败降级）
 * 3. 内存模式（令牌消耗 / 超限 / 时间推进补充 / 过期清理 / 时间倒退不补充）
 */
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { RateLimiterService } from './rate-limiter';

/**
 * mock ioredis 模块：
 * - 工厂在内部创建 mock 实例与构造函数（不引用外部变量，避免 jest.mock 提升顺序问题）
 * - mock 实例挂载在构造函数 __mockInstance 属性上，测试通过 redisCtor 访问
 */
jest.mock('ioredis', () => {
  const mockInstance = {
    ping: jest.fn(),
    eval: jest.fn(),
    on: jest.fn(),
  };
  const mockCtor = jest.fn(() => mockInstance);
  return {
    __esModule: true,
    default: Object.assign(mockCtor, { __mockInstance: mockInstance }),
  };
});

/** 被 mock 的 Redis 构造函数（含挂载的 mock 实例） */
const redisCtor = Redis as unknown as jest.Mock & {
  __mockInstance: {
    ping: jest.Mock;
    eval: jest.Mock;
    on: jest.Mock;
  };
};

/** mock 实例：控制 ping/eval/on 行为 */
const mockRedisInstance = redisCtor.__mockInstance;

/** 构造 ConfigService mock（支持覆盖指定 key） */
function createConfigService(
  overrides: Record<string, unknown> = {},
): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

/** 让 Redis 连接成功（ping 通过） */
function enableRedis(): void {
  mockRedisInstance.ping.mockResolvedValue('PONG');
}

/** 让 Redis 连接失败（ping 拒绝） */
function disableRedis(): void {
  mockRedisInstance.ping.mockRejectedValue(new Error('ECONNREFUSED'));
}

describe('RateLimiterService', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    mockRedisInstance.ping.mockReset();
    mockRedisInstance.eval.mockReset();
    mockRedisInstance.on.mockReset();
    redisCtor.mockClear();
  });

  describe('容量配置', () => {
    it('默认每分钟 60 次', () => {
      const service = new RateLimiterService(createConfigService());
      expect(service.capacity).toBe(60);
      expect(service.windowMs).toBe(60_000);
    });

    it('读取 RATE_LIMIT_PER_MINUTE 环境变量', () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 10 }),
      );
      expect(service.capacity).toBe(10);
    });

    it('非法值（0）回退为 1', () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 0 }),
      );
      expect(service.capacity).toBe(1);
    });
  });

  describe('onModuleInit', () => {
    it('Redis 连接成功：输出成功日志并走 Redis 计数', async () => {
      enableRedis();
      mockRedisInstance.eval.mockResolvedValue([1, 59]);
      const service = new RateLimiterService(createConfigService());
      await service.onModuleInit();

      const result = await service.consume('tenant:t1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(59);
      expect(mockRedisInstance.eval).toHaveBeenCalledTimes(1);
    });

    it('Redis 连接失败：降级为内存令牌桶', async () => {
      disableRedis();
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 2 }),
      );
      await service.onModuleInit();

      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(false);
      // 降级后不再调用 Redis eval
      expect(mockRedisInstance.eval).not.toHaveBeenCalled();
    });

    it('retryStrategy：超过 3 次停止重连，否则指数退避', async () => {
      disableRedis();
      const service = new RateLimiterService(createConfigService());
      await service.onModuleInit();

      const options = (
        redisCtor.mock.calls as unknown as Array<Array<unknown>>
      )[0][0] as {
        retryStrategy: (times: number) => number | null;
      };
      expect(options.retryStrategy(1)).toBe(500);
      expect(options.retryStrategy(4)).toBeNull();
    });

    it('Redis 可用后发生 error 事件：降级为内存令牌桶', async () => {
      enableRedis();
      // 捕获 on('error') 注册的回调
      let errorCb: ((err: Error) => void) | undefined;
      mockRedisInstance.on.mockImplementation(
        (event: string, cb: (err: Error) => void) => {
          if (event === 'error') {
            errorCb = cb;
          }
          return mockRedisInstance;
        },
      );

      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 1 }),
      );
      await service.onModuleInit();
      mockRedisInstance.eval.mockResolvedValue([1, 0]);
      expect((await service.consume('tenant:t1')).allowed).toBe(true);

      // 触发 error 事件 → 降级
      errorCb?.(new Error('connection lost'));
      mockRedisInstance.eval.mockClear();
      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      // 降级后不再调用 Redis eval
      expect(mockRedisInstance.eval).not.toHaveBeenCalled();
    });
  });

  describe('Redis 模式 consume', () => {
    it('Redis 返回 [1, remaining] 时放行', async () => {
      enableRedis();
      mockRedisInstance.eval.mockResolvedValue([1, 42]);
      const service = new RateLimiterService(createConfigService());
      await service.onModuleInit();

      const result = await service.consume('tenant:t1');
      expect(result).toEqual({ allowed: true, remaining: 42 });
    });

    it('Redis 返回 [0, 0] 时超限', async () => {
      enableRedis();
      mockRedisInstance.eval.mockResolvedValue([0, 0]);
      const service = new RateLimiterService(createConfigService());
      await service.onModuleInit();

      const result = await service.consume('tenant:t1');
      expect(result).toEqual({ allowed: false, remaining: 0 });
    });

    it('eval 执行失败时本次降级内存令牌桶', async () => {
      enableRedis();
      mockRedisInstance.eval.mockRejectedValue(new Error('NOSCRIPT'));
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 1 }),
      );
      await service.onModuleInit();

      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(false);
    });
  });

  describe('内存模式 consume', () => {
    beforeEach(() => {
      disableRedis();
    });

    it('连续消耗令牌，超过容量后拒绝', async () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 3 }),
      );
      await service.onModuleInit();

      expect((await service.consume('tenant:t1')).remaining).toBe(2);
      expect((await service.consume('tenant:t1')).remaining).toBe(1);
      expect((await service.consume('tenant:t1')).remaining).toBe(0);
      const denied = await service.consume('tenant:t1');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
    });

    it('窗口期内时间推进会按速率补充令牌', async () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 2 }),
      );
      await service.onModuleInit();

      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(false);

      // 前进 30 秒（速率 2/min → 30s 补充 1 个）
      now += 30_000;
      const result = await service.consume('tenant:t1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(0);
    });

    it('时间倒退时不补充令牌', async () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 1 }),
      );
      await service.onModuleInit();

      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      expect((await service.consume('tenant:t1')).allowed).toBe(true);
      expect((await service.consume('tenant:t1')).allowed).toBe(false);

      // 时间倒退 → delta 为 0，仍无令牌
      now = 900_000;
      expect((await service.consume('tenant:t1')).allowed).toBe(false);
    });

    it('桶数量超阈值时清理过期条目', async () => {
      const service = new RateLimiterService(
        createConfigService({ RATE_LIMIT_PER_MINUTE: 10 }),
      );
      service.cleanupThreshold = 1; // 阈值设为 1，便于触发清理
      await service.onModuleInit();

      let now = 1_000_000;
      jest.spyOn(Date, 'now').mockImplementation(() => now);

      await service.consume('tenant:a');
      now += 10_000;
      await service.consume('tenant:b'); // size=2 ≥ 1 → 触发清理（a 未过期）

      // 前进 61 秒后 a/b 均过期 → 下次 consume 触发清理删除
      now += 61_000;
      await service.consume('tenant:c');

      // a 的桶已被清理 → 重新获得满桶
      expect((await service.consume('tenant:a')).allowed).toBe(true);
    });
  });
});
