/* eslint-disable @typescript-eslint/unbound-method -- 测试断言需直接引用 mock 方法（toHaveBeenCalledWith/consume 等） */
/**
 * RateLimiterMiddleware 单元测试
 *
 * 覆盖：
 * 1. 放行路径（写入 X-RateLimit-Remaining + next）
 * 2. 超限路径（HTTP 429 + Retry-After）
 * 3. 租户标识提取（tenantId 优先，无租户时按 IP / X-Forwarded-For）
 */
import { Request, Response, NextFunction } from 'express';
import { RateLimiterMiddleware } from './rate-limiter.middleware';
import { RateLimiterService } from './rate-limiter';
import { TenantContext } from '../tenant/tenant-context';

function createRateLimiter(): jest.Mocked<RateLimiterService> {
  return {
    consume: jest.fn(),
    windowMs: 60_000,
    capacity: 60,
  } as unknown as jest.Mocked<RateLimiterService>;
}

function createTenantContext(): jest.Mocked<TenantContext> {
  return {
    getData: jest.fn(),
  } as unknown as jest.Mocked<TenantContext>;
}

function createRes(): {
  res: Response;
  setHeader: jest.Mock;
  status: jest.Mock;
  json: jest.Mock;
} {
  const setHeader = jest.fn();
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res = { setHeader, status, json } as unknown as Response;
  return { res, setHeader, status, json };
}

describe('RateLimiterMiddleware', () => {
  let rateLimiter: jest.Mocked<RateLimiterService>;
  let tenantContext: jest.Mocked<TenantContext>;
  let middleware: RateLimiterMiddleware;

  beforeEach(() => {
    rateLimiter = createRateLimiter();
    tenantContext = createTenantContext();
    middleware = new RateLimiterMiddleware(rateLimiter, tenantContext);
  });

  it('有租户上下文且放行：写入剩余令牌头并 next', async () => {
    tenantContext.getData.mockReturnValue({ tenantId: 'tenant-001' });
    rateLimiter.consume.mockResolvedValue({ allowed: true, remaining: 59 });
    const { res, setHeader } = createRes();
    const next = jest.fn() as unknown as NextFunction;

    await middleware.use({} as Request, res, next);

    expect(rateLimiter.consume).toHaveBeenCalledWith('tenant:tenant-001', 1);
    expect(setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '59');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('超限：返回 429 + Retry-After，不调用 next', async () => {
    tenantContext.getData.mockReturnValue({ tenantId: 'tenant-001' });
    rateLimiter.consume.mockResolvedValue({ allowed: false, remaining: 0 });
    const { res, setHeader, status, json } = createRes();
    const next = jest.fn() as unknown as NextFunction;

    await middleware.use({} as Request, res, next);

    expect(setHeader).toHaveBeenCalledWith('Retry-After', '60');
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 429 }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('无租户上下文：按 X-Forwarded-For 首项 IP 限流', async () => {
    tenantContext.getData.mockReturnValue(undefined);
    rateLimiter.consume.mockResolvedValue({ allowed: true, remaining: 60 });
    const { res } = createRes();
    const next = jest.fn() as unknown as NextFunction;
    const req = {
      headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' },
    } as unknown as Request;

    await middleware.use(req, res, next);

    expect(rateLimiter.consume).toHaveBeenCalledWith('ip:1.2.3.4', 1);
  });

  it('无租户且无 X-Forwarded-For：按 req.ip 限流', async () => {
    tenantContext.getData.mockReturnValue(undefined);
    rateLimiter.consume.mockResolvedValue({ allowed: true, remaining: 60 });
    const { res } = createRes();
    const next = jest.fn() as unknown as NextFunction;
    const req = {
      headers: {},
      ip: '10.0.0.1',
    } as unknown as Request;

    await middleware.use(req, res, next);

    expect(rateLimiter.consume).toHaveBeenCalledWith('ip:10.0.0.1', 1);
  });
});
