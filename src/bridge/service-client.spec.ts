/**
 * ServiceClient 重试策略测试（阶段0 B-2 返工 2026-10-07）
 *
 * 阻断缺陷 B-2 回归：isRetryable 此前只看错误类型不看 method——
 * post/put/delete 共用重试循环，网络抖动/响应丢失时写操作（建单/付款/
 * 退款等约 40 个写工具）必然重复提交。修复后非幂等方法（POST/PATCH）
 * 一律不重试；幂等方法（GET/PUT/DELETE）维持原有重试。
 *
 * 用注入式 axios 桩直驱（构造函数走 ConfigService）。
 */
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  ServiceClient,
  BridgeError,
  parseBridgeFieldErrors,
  describeBridgeErrorDetail,
} from './service-client';
import type { ToolContext } from '../tools/tool.interface';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

/** 构造带受控 axios 桩的 client（maxRetries=1：首次 + 至多 1 次重试） */
function createClient(behavior: () => Promise<unknown>): {
  client: ServiceClient;
  request: jest.Mock;
} {
  const request = jest.fn(behavior);
  const client = new ServiceClient({
    get: (key: string, dflt?: unknown) =>
      key === 'BACKEND_BASE_URL' ? 'http://backend' : dflt,
  } as unknown as ConfigService);
  const slot = client as unknown as Record<string, unknown>;
  slot.httpClient = { request };
  slot.baseUrl = 'http://backend';
  slot.timeout = 1000;
  return { client, request };
}

/** 构造网络层错误（无响应 → 旧逻辑必然可重试） */
function networkError(): AxiosError {
  return new AxiosError(
    'ECONNREFUSED',
    'ECONNREFUSED',
    undefined,
    undefined,
    undefined,
  );
}

function httpError(status: number): AxiosError {
  return new AxiosError(
    'error',
    'ERR',
    { headers: new AxiosHeaders() },
    undefined,
    {
      status,
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
      data: { code: 'E', message: 'x' },
    } as never,
  );
}

describe('ServiceClient 重试策略（B-2）', () => {
  it('POST 网络错误 → 不重试（仅 1 次请求，直接抛 BridgeError）', async () => {
    const { client, request } = createClient(() =>
      Promise.reject(networkError()),
    );

    await expect(client.post('/sale-bills', {}, CTX)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('PATCH 网络错误 → 不重试', async () => {
    const { client, request } = createClient(() =>
      Promise.reject(networkError()),
    );

    const rawRequest = (
      client as unknown as {
        request: (
          m: string,
          p: string,
          c: ToolContext,
          b?: unknown,
        ) => Promise<unknown>;
      }
    ).request;

    await expect(
      rawRequest.call(client, 'PATCH', '/x', CTX, {}),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('GET 网络错误 → 仍重试（首次失败 + 重试后抛出）', async () => {
    const { client, request } = createClient(() =>
      Promise.reject(networkError()),
    );

    await expect(client.get('/inventory', CTX)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2); // maxRetries=1
  });

  it('PUT 5xx → 重试（幂等方法维持原口径）', async () => {
    let calls = 0;
    const { client, request } = createClient(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(httpError(500))
        : Promise.resolve({
            data: { code: '0', msg: 'ok', data: { ok: 1 } },
            status: 200,
          });
    });

    const out = await client.put('/x', {}, CTX);
    expect(out).toEqual({ ok: 1 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('POST 5xx → 同样不重试（POST 无幂等保证，5xx 也不重放）', async () => {
    const { client, request } = createClient(() =>
      Promise.reject(httpError(500)),
    );

    await expect(client.post('/sale-bills', {}, CTX)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

/**
 * R101-AI-27：BridgeError 透传后端**字段级 errors + traceId**
 *
 * 背景（S3-181-C 复跑教训）：后端返回
 * `{code,msg,traceId,errors:[{field,message,code?}]}`，此前只保留 msg
 * ⇒ 工具返回只剩静态文案，真实原因（mobile 格式）丢失。
 */
describe('R101-AI-27 BridgeError 字段级 errors 透传', () => {
  /** 构造带响应体的 AxiosError（后端 400 校验失败形态） */
  function httpErrorWithBody(body: unknown, status = 400): AxiosError {
    return new AxiosError(
      'error',
      'ERR',
      { headers: new AxiosHeaders() },
      undefined,
      {
        status,
        headers: new AxiosHeaders(),
        config: { headers: new AxiosHeaders() },
        data: body,
      } as never,
    );
  }

  it('400 带 errors[] ⇒ BridgeError 携带字段级 errors + traceId（不再只剩 msg）', async () => {
    const { client } = createClient(() =>
      Promise.reject(
        httpErrorWithBody({
          code: '400',
          msg: '参数校验失败',
          traceId: '80ce3465-f229-417a-9ad2-6e29dd2df2df',
          errors: [
            {
              field: 'mobile',
              message: '手机号格式不正确',
              code: 'invalid_string',
            },
          ],
        }),
      ),
    );

    const err: unknown = await client
      .post('/admin/members', {}, CTX)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BridgeError);
    const bridgeErr = err as BridgeError;
    expect(bridgeErr.statusCode).toBe(400);
    expect(bridgeErr.traceId).toBe('80ce3465-f229-417a-9ad2-6e29dd2df2df');
    expect(bridgeErr.errors).toEqual([
      { field: 'mobile', message: '手机号格式不正确', code: 'invalid_string' },
    ]);
    // 面向用户可读的拼装（消费侧直接用）
    expect(describeBridgeErrorDetail(bridgeErr)).toContain(
      'mobile：手机号格式不正确',
    );
    expect(describeBridgeErrorDetail(bridgeErr)).toContain(
      'traceId=80ce3465-f229-417a-9ad2-6e29dd2df2df',
    );
  });

  it('errors 非数组/项缺字段 ⇒ 防御式忽略（errors 为 undefined，不抛）', async () => {
    const nonArray = createClient(() =>
      Promise.reject(
        httpErrorWithBody({ code: '400', msg: 'x', errors: 'boom' }),
      ),
    );
    const e1: unknown = await nonArray.client
      .post('/a', {}, CTX)
      .catch((e: unknown) => e);
    expect((e1 as BridgeError).errors).toBeUndefined();

    const partial = createClient(() =>
      Promise.reject(
        httpErrorWithBody({
          code: '400',
          msg: 'x',
          errors: [{ field: 'mobile' }, { message: '缺 field' }, 42],
        }),
      ),
    );
    const e2: unknown = await partial.client
      .post('/a', {}, CTX)
      .catch((e: unknown) => e);
    expect((e2 as BridgeError).errors).toBeUndefined();
  });

  it('无 errors 且无 traceId ⇒ detail 为空串（既有行为零变化）', () => {
    expect(describeBridgeErrorDetail(new Error('x'))).toBe('');
    expect(describeBridgeErrorDetail(new BridgeError('x', 500, '500'))).toBe(
      '',
    );
  });

  it('解析器与格式化函数为纯函数：errors 数组逐字段保留可选 code', () => {
    expect(
      parseBridgeFieldErrors([
        { field: 'a', message: 'A' },
        { field: 'b', message: 'B', code: 'c2' },
      ]),
    ).toEqual([
      { field: 'a', message: 'A' },
      { field: 'b', message: 'B', code: 'c2' },
    ]);
  });
});
