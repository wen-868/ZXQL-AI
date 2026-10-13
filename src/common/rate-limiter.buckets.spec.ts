/**
 * 限流读写分桶测试（R101-AI-31：读全自动、写全审核）
 *
 * 反测 4 条（用**真实** `RateLimiterService` 的内存令牌桶路径 + 真实中间件，非打桩）：
 * ① 同租户连续 61 次 GET ⇒ 第 61 次 200（读宽桶未触顶）、第 601 次 429
 * ② 连续 61 次 POST ⇒ 第 61 次 429（写严桶触顶）
 * ③ 读桶与写桶互不挤占
 * ④ 去掉分桶（key 不按方法分）⇒ 上述断言变红（另跑 mutation 取证）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { RateLimiterService } from './rate-limiter';
import { RateLimiterMiddleware } from './rate-limiter.middleware';
import { TenantContext } from '../tenant/tenant-context';
import { RedisProvider } from './redis.provider';

// 冻结时间：内存令牌桶按 (now-ts)*refill 连续补充，真实时间会让"第 601 次 429"不确定
// ⇒ 用 jest 假定时器（Date.now 一并冻结）锁死补充量，使反测数字与卡片严格一致
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const ENV: Record<string, number> = {
  RATE_LIMIT_WRITE_PER_MIN: 60,
  RATE_LIMIT_READ_PER_MIN: 600,
};

function createService(): RateLimiterService {
  const config = {
    get: (key: string, fallback?: unknown) => ENV[key] ?? fallback,
  } as unknown as ConfigService;
  const provider = {
    getSharedClient: jest.fn(),
  } as unknown as RedisProvider;
  // 不调 onModuleInit ⇒ redisAvailable=false ⇒ 走内存令牌桶（确定性、无 Redis 依赖）
  return new RateLimiterService(config, provider);
}

interface Harness {
  middleware: RateLimiterMiddleware;
  call: (method: string) => Promise<{ status: number; next: jest.Mock }>;
}

function createHarness(tenantId: string | undefined): Harness {
  const service = createService();
  const tenantContext = {
    getData: () => (tenantId ? { tenantId } : undefined),
  } as unknown as TenantContext;
  const middleware = new RateLimiterMiddleware(service, tenantContext);

  const call = async (
    method: string,
  ): Promise<{ status: number; next: jest.Mock }> => {
    const nextMock = jest.fn();
    const next = nextMock as unknown as NextFunction;
    let statusCode = 0;
    const res = {
      setHeader: jest.fn(),
      status(code: number) {
        statusCode = code;
        return res;
      },
      json: jest.fn(),
    } as unknown as Response;
    const req = {
      method,
      ip: '9.9.9.9',
      headers: {},
      socket: { remoteAddress: '9.9.9.9' },
    } as unknown as Request;
    await middleware.use(req, res, next);
    return { status: statusCode, next: nextMock };
  };

  return { middleware, call };
}

describe('R101-AI-31 限流读写分桶（读宽写严）', () => {
  it('① 读宽桶：连续 61 次 GET 全部放行；第 601 次 429', async () => {
    const h = createHarness('tenant-read');
    for (let i = 1; i <= 61; i += 1) {
      const r = await h.call('GET');
      expect(r.status).toBe(0); // 未写 429
      expect(r.next).toHaveBeenCalledTimes(1);
    }
    // 打到第 600 次仍放行
    for (let i = 62; i <= 600; i += 1) {
      await h.call('GET');
    }
    const over = await h.call('GET');
    expect(over.status).toBe(429);
    expect(over.next).not.toHaveBeenCalled();
  });

  it('② 写严桶：连续 61 次 POST ⇒ 第 61 次 429', async () => {
    const h = createHarness('tenant-write');
    for (let i = 1; i <= 60; i += 1) {
      const r = await h.call('POST');
      expect(r.next).toHaveBeenCalledTimes(1);
      expect(r.status).toBe(0);
    }
    const over = await h.call('POST');
    expect(over.status).toBe(429);
    expect(over.next).not.toHaveBeenCalled();
  });

  it('③ 读桶与写桶互不挤占（写打满不影响读；读打满不影响写）', async () => {
    // 写打满后，GET 仍放行
    const h1 = createHarness('tenant-mix-a');
    for (let i = 1; i <= 60; i += 1) await h1.call('POST');
    expect((await h1.call('POST')).status).toBe(429);
    expect((await h1.call('GET')).next).toHaveBeenCalledTimes(1);

    // 读打满后，POST 仍放行
    const h2 = createHarness('tenant-mix-b');
    for (let i = 1; i <= 600; i += 1) await h2.call('GET');
    expect((await h2.call('GET')).status).toBe(429);
    expect((await h2.call('POST')).next).toHaveBeenCalledTimes(1);
  });

  it('④ key 按方法分桶：GET 走 :read、POST 走 :write（同租户两桶独立）', async () => {
    const service = createService();
    const spy = jest.spyOn(service, 'consume');
    const tenantContext = {
      getData: () => ({ tenantId: 'tenant-key' }),
    } as unknown as TenantContext;
    const middleware = new RateLimiterMiddleware(service, tenantContext);
    const next = jest.fn() as unknown as NextFunction;
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as unknown as Response;
    const makeReq = (method: string) =>
      ({
        method,
        ip: '9.9.9.9',
        headers: {},
        socket: { remoteAddress: '9.9.9.9' },
      }) as unknown as Request;

    await middleware.use(makeReq('GET'), res, next);
    await middleware.use(makeReq('POST'), res, next);

    expect(spy).toHaveBeenNthCalledWith(1, 'tenant:tenant-key:read', 1, 'read');
    expect(spy).toHaveBeenNthCalledWith(
      2,
      'tenant:tenant-key:write',
      1,
      'write',
    );
  });
});
