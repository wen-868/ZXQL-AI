/**
 * RequestLoggingMiddleware 单元测试
 *
 * 覆盖：
 * 1. 响应完成后记录 IP/UA/tenantId/方法/路径/状态码/耗时
 * 2. IP 提取：X-Forwarded-For 优先，回退 req.ip
 * 3. 无租户上下文时 tenantId 记录为 null
 */
import { Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RequestLoggingMiddleware } from './request-logging.middleware';
import { TenantContext } from '../tenant/tenant-context';

function createTenantContext(): jest.Mocked<TenantContext> {
  return {
    getData: jest.fn(),
  } as unknown as jest.Mocked<TenantContext>;
}

describe('RequestLoggingMiddleware', () => {
  let tenantContext: jest.Mocked<TenantContext>;
  let middleware: RequestLoggingMiddleware;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    tenantContext = createTenantContext();
    middleware = new RequestLoggingMiddleware(tenantContext);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('响应完成时记录 IP(X-Forwarded-For)/UA/tenantId/耗时', () => {
    tenantContext.getData.mockReturnValue({ tenantId: 'tenant-001' });
    const req = {
      headers: {
        'user-agent': 'jest-agent',
        'x-forwarded-for': '1.2.3.4',
      },
      method: 'POST',
      originalUrl: '/api/chat',
      url: '/api/chat',
    } as unknown as Request;

    let finishCb: (() => void) | undefined;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') {
          finishCb = cb;
        }
        return res;
      }),
      statusCode: 200,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    finishCb?.();

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = (
      logSpy.mock.calls as unknown as Array<Array<unknown>>
    )[0][0] as Record<string, unknown>;
    expect(payload.ip).toBe('1.2.3.4');
    expect(payload.userAgent).toBe('jest-agent');
    expect(payload.tenantId).toBe('tenant-001');
    expect(payload.method).toBe('POST');
    expect(payload.url).toBe('/api/chat');
    expect(payload.status).toBe(200);
    expect(typeof payload.costMs).toBe('number');
    expect(payload.costMs).toBeGreaterThanOrEqual(0);
  });

  it('无 X-Forwarded-For 时回退 req.ip', () => {
    tenantContext.getData.mockReturnValue(undefined);
    const req = {
      headers: {},
      method: 'GET',
      url: '/api/admin/health',
      ip: '10.0.0.1',
    } as unknown as Request;

    let finishCb: (() => void) | undefined;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') {
          finishCb = cb;
        }
        return res;
      }),
      statusCode: 404,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);
    finishCb?.();

    const payload = (
      logSpy.mock.calls as unknown as Array<Array<unknown>>
    )[0][0] as Record<string, unknown>;
    expect(payload.ip).toBe('10.0.0.1');
    expect(payload.tenantId).toBeNull();
    expect(payload.url).toBe('/api/admin/health');
  });

  it('originalUrl 缺失时回退 url', () => {
    tenantContext.getData.mockReturnValue({ tenantId: 'tenant-002' });
    const req = {
      headers: { 'x-forwarded-for': '8.8.8.8' },
      method: 'PUT',
      url: '/api/admin/ai-config/platform',
    } as unknown as Request;

    let finishCb: (() => void) | undefined;
    const res = {
      on: jest.fn((event: string, cb: () => void) => {
        if (event === 'finish') {
          finishCb = cb;
        }
        return res;
      }),
      statusCode: 200,
    } as unknown as Response;
    const next = jest.fn() as unknown as NextFunction;

    middleware.use(req, res, next);
    finishCb?.();

    const payload = (
      logSpy.mock.calls as unknown as Array<Array<unknown>>
    )[0][0] as Record<string, unknown>;
    expect(payload.url).toBe('/api/admin/ai-config/platform');
    expect(payload.tenantId).toBe('tenant-002');
  });
});
