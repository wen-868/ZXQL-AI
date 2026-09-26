/**
 * ServiceClient — CSRF 密钥可观测性单测
 *
 * 背景（2026-09-26 调查）：`CSRF_SECRET` 与 `JWT_SECRET` 均未配置时，
 * 本类会**静默**跳过 `x-csrf-token` 注入。后端 csrfMiddleware 对
 * POST/PUT/DELETE 统一拦截，于是所有写工具一律 403，而 AI 侧只看到
 * "写操作调用失败"，与真实业务错误无法区分（见踩坑日志 [34]）。
 *
 * 本单测锁死：
 * 1. 密钥缺失 → 启动期显式告警（不再是静默降级）
 * 2. 密钥存在（含回退 JWT_SECRET）→ 不告警
 * 3. 写请求按 backend csrf.ts 口径注入 x-csrf-token
 * 4. 403 且未注入令牌时，错误信息点名 CSRF 缺失根因
 *
 * 负责人: AI底座 | 创建日期: 2026-09-26
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AxiosError, type AxiosResponse } from 'axios';
import { ServiceClient } from './service-client';
import type { ToolContext } from '../tools/tool.interface';

/** 构造一个 403 响应的 AxiosError（定型构造，避免 any 赋值） */
function make403Error(msg: string): AxiosError {
  const err = new AxiosError('Request failed with status code 403');
  err.response = {
    status: 403,
    statusText: 'Forbidden',
    headers: {},
    config: { headers: {} },
    data: { code: '403', msg },
  } as unknown as AxiosResponse;
  return err;
}

function makeClient(env: Record<string, string> = {}): ServiceClient {
  return new ServiceClient({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

/** 取私有方法（定型后访问，避免 any） */
function internalHeaders(
  client: ServiceClient,
  context: ToolContext,
): Record<string, string> {
  const internal = client as unknown as {
    buildRequestConfig: (ctx: ToolContext) => {
      headers?: Record<string, string>;
    };
  };
  return internal.buildRequestConfig(context).headers ?? {};
}

const baseContext: ToolContext = {
  tenantId: 'tenant-A',
  userId: 'u-1001',
  authToken: 'jwt-xxx',
};

describe('ServiceClient CSRF 可观测性', () => {
  let warnSpy: jest.SpiedFunction<typeof Logger.prototype.warn>;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('CSRF_SECRET 与 JWT_SECRET 均缺失时应启动告警（非静默）', () => {
    makeClient();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CSRF_SECRET'),
    );
  });

  it('配置了 CSRF_SECRET 时不应告警', () => {
    makeClient({ CSRF_SECRET: 's-1' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('仅配置 JWT_SECRET（合法回退）时不应告警', () => {
    makeClient({ JWT_SECRET: 'j-1' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('有密钥 + userId 时应注入 x-csrf-token', () => {
    const headers = internalHeaders(makeClient({ CSRF_SECRET: 's-1' }), {
      ...baseContext,
    });
    expect(headers['x-csrf-token']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('无 userId 时不注入（后端按 userId 计算令牌，缺则无从计算）', () => {
    const headers = internalHeaders(makeClient({ CSRF_SECRET: 's-1' }), {
      tenantId: 'tenant-A',
    });
    expect(headers['x-csrf-token']).toBeUndefined();
  });

  it('403 且未注入令牌时，错误信息应点名 CSRF 缺失根因', () => {
    const client = makeClient(); // 无密钥
    const internal = client as unknown as {
      toBridgeError: (
        err: unknown,
        path: string,
      ) => { message: string; statusCode: number };
    };

    const bridgeErr = internal.toBridgeError(
      make403Error('CSRF token 无效或缺失'),
      '/api/sales/orders',
    );

    expect(bridgeErr.statusCode).toBe(403);
    expect(bridgeErr.message).toContain('疑似 CSRF_SECRET 未配置');
  });

  it('已注入令牌时的 403 不应误报 CSRF 缺失（真权限不足）', () => {
    const client = makeClient({ CSRF_SECRET: 's-1' });
    const internal = client as unknown as {
      toBridgeError: (
        err: unknown,
        path: string,
      ) => { message: string; statusCode: number };
    };

    const bridgeErr = internal.toBridgeError(
      make403Error('无权访问该门店'),
      '/api/sales/orders',
    );

    expect(bridgeErr.message).not.toContain('疑似 CSRF_SECRET 未配置');
    expect(bridgeErr.message).toContain('无权访问该门店');
  });
});
