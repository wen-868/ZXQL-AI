/**
 * TenantMiddleware 单元测试
 *
 * 覆盖（2026-09-05 审查 P0-3 修复：身份只认 JWT）：
 * - 商家 JWT → 注入租户上下文（tenantId/userId/role/customerId/authType）
 * - 平台 JWT（总台）+ 请求体目标租户 → 平台身份上下文
 * - 携带伪造 token → 401（AI_001），不降级、不放行
 * - 无 token（默认）→ 401
 * - 应急开关 AI_ALLOW_BODY_TENANT=true 时恢复旧 body 回退
 * - JWT_SECRET 未配置 → 401（拒绝服务而非降级）
 *
 * 说明：jwt.sign 未显式传 algorithm——字符串密钥下默认即 HS256，
 * 且被测中间件验签侧已固定 algorithms:['HS256']（见 jwt-verify.ts）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-09-05
 */
import type { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { TenantContext, TenantContextData } from './tenant-context';
import { TenantMiddleware } from './tenant.middleware';

const SECRET = 'test-jwt-secret-for-middleware-spec';

function signMerchant(payload: Record<string, unknown>): string {
  return jwt.sign(payload, SECRET, {
    issuer: 'zhixiang-system',
    audience: 'zhixiang-client',
  });
}

function signPlatform(): string {
  return jwt.sign(
    { id: 9, username: 'platform-admin', type: 'platform_admin' },
    SECRET,
    {
      issuer: 'zhixiang-platform',
      audience: 'zhixiang-platform-client',
    },
  );
}

function makeDeps(env: Record<string, string> = {}): {
  middleware: TenantMiddleware;
  run: jest.Mock<void, [TenantContextData, () => void]>;
  res: { status: jest.Mock; json: jest.Mock };
  next: NextFunction;
} {
  const run = jest.fn((data: TenantContextData, cb: () => void) => cb());
  const tenantContext = {
    run,
    getData: jest.fn(),
  };
  const configService = {
    get: jest.fn((key: string, def?: string) => env[key] ?? def ?? undefined),
  };
  const middleware = new TenantMiddleware(
    tenantContext as unknown as TenantContext,
    configService as never,
  );
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  const next = jest.fn();
  return { middleware, run, res, next };
}

function makeReq(
  authorization?: string,
  body?: Record<string, unknown>,
): {
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  method: string;
  path: string;
} {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return { headers, body, method: 'POST', path: '/api/chat' };
}

describe('TenantMiddleware（鉴权链收紧后）', () => {
  it('商家 JWT：注入租户上下文（身份全部来自 payload）', () => {
    const token = signMerchant({
      id: 7,
      username: 'u7',
      tenantId: 't_100',
      roles: ['admin'],
      customerId: 55,
    });
    const { middleware, run, res, next } = makeDeps({ JWT_SECRET: SECRET });

    middleware.use(
      makeReq(`Bearer ${token}`) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    const ctx = run.mock.calls[0][0];
    expect(ctx).toMatchObject({
      tenantId: 't_100',
      userId: '7',
      role: 'admin',
      customerId: '55',
      authToken: token,
      authType: 'merchant',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('平台 JWT + 请求体目标租户：平台身份上下文（role=platform）', () => {
    const token = signPlatform();
    const { middleware, run, res, next } = makeDeps({ JWT_SECRET: SECRET });

    middleware.use(
      makeReq(`Bearer ${token}`, { tenantId: 't_target' }) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).not.toHaveBeenCalled();
    const ctx = run.mock.calls[0][0];
    expect(ctx).toMatchObject({
      tenantId: 't_target',
      userId: '9',
      role: 'platform',
      authType: 'platform',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('携带伪造 token：401（AI_001），不降级为 body 模式、不放行', () => {
    const forged = jwt.sign(
      { id: 1, tenantId: 't_evil', roles: ['SUPER_ADMIN'] },
      'wrong-secret',
      {
        issuer: 'zhixiang-system',
        audience: 'zhixiang-client',
      },
    );
    const { middleware, run, res, next } = makeDeps({ JWT_SECRET: SECRET });

    middleware.use(
      makeReq(`Bearer ${forged}`, { tenantId: 't_evil' }) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, code: 'AI_001' }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('无 token（默认严格模式）：401，body 里传 tenantId 也不放行', () => {
    const { middleware, run, res, next } = makeDeps();

    middleware.use(
      makeReq(undefined, { tenantId: 't_any', role: 'admin' }) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(run).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('应急开关 AI_ALLOW_BODY_TENANT=true：恢复旧 body 回退（仅限临时排查）', () => {
    const { middleware, run, res, next } = makeDeps({
      AI_ALLOW_BODY_TENANT: 'true',
    });

    middleware.use(
      makeReq(undefined, { tenantId: 't_legacy', userId: 'u1' }) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).not.toHaveBeenCalled();
    const ctx = run.mock.calls[0][0];
    expect(ctx).toMatchObject({ tenantId: 't_legacy', userId: 'u1' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('JWT_SECRET 未配置：401 拒绝（不静默降级）', () => {
    const token = signMerchant({ id: 1, tenantId: 't_001', roles: ['admin'] });
    const { middleware, res, next } = makeDeps({ JWT_SECRET: '' });

    middleware.use(
      makeReq(`Bearer ${token}`) as never,
      res as unknown as Response,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
