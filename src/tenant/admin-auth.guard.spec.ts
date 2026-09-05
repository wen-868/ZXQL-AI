/**
 * AdminGuard / JwtGuard 单元测试
 *
 * 覆盖（2026-09-05 审查 P0-2 修复）：
 * - 商家 JWT + 管理角色 → 放行
 * - 商家 JWT + 非管理角色（CASHIER）→ 403（AI_010）
 * - 平台 JWT（总台 saas-admin）→ 放行
 * - 伪造/过期/缺失 token → 401（AI_001）
 * - JwtGuard：任意合法商家/平台 JWT 放行
 *
 * 说明：jwt.sign 未显式传 algorithm——字符串密钥下默认即 HS256，
 * 且被测 Guard 验签侧已固定 algorithms:['HS256']（见 jwt-verify.ts）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-09-05
 */
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AdminGuard, JwtGuard } from './admin-auth.guard';

const SECRET = 'test-jwt-secret-for-guard-spec';

function signMerchant(
  payload: Record<string, unknown>,
  overrides?: jwt.SignOptions,
): string {
  return jwt.sign(payload, SECRET, {
    issuer: 'zhixiang-system',
    audience: 'zhixiang-client',
    ...overrides,
  });
}

function signPlatform(): string {
  return jwt.sign(
    {
      id: 9,
      username: 'platform-admin',
      realName: '总台管理员',
      type: 'platform_admin',
    },
    SECRET,
    {
      issuer: 'zhixiang-platform',
      audience: 'zhixiang-platform-client',
    },
  );
}

function makeContext(authorization?: string): ExecutionContext {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('AdminGuard', () => {
  let guard: AdminGuard;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  beforeEach(() => {
    guard = new AdminGuard();
  });

  it('商家 JWT + 管理角色（SUPER_ADMIN）→ 放行', () => {
    const token = signMerchant({
      id: 1,
      username: 'boss',
      tenantId: 't_001',
      roles: ['SUPER_ADMIN'],
    });
    expect(guard.canActivate(makeContext(`Bearer ${token}`))).toBe(true);
  });

  it('商家 JWT + 仓库管理角色（WAREHOUSE_ADMIN）→ 放行', () => {
    const token = signMerchant({
      id: 2,
      username: 'wh',
      tenantId: 't_001',
      roles: ['WAREHOUSE_ADMIN'],
    });
    expect(guard.canActivate(makeContext(`Bearer ${token}`))).toBe(true);
  });

  it('商家 JWT + 非管理角色（CASHIER）→ 403（AI_010）', () => {
    const token = signMerchant({
      id: 3,
      username: 'cashier',
      tenantId: 't_001',
      roles: ['CASHIER'],
    });
    expect(() => guard.canActivate(makeContext(`Bearer ${token}`))).toThrow(
      ForbiddenException,
    );
  });

  it('商家 JWT + 无角色 → 403', () => {
    const token = signMerchant({
      id: 4,
      username: 'norole',
      tenantId: 't_001',
    });
    expect(() => guard.canActivate(makeContext(`Bearer ${token}`))).toThrow(
      ForbiddenException,
    );
  });

  it('平台 JWT（总台）→ 放行', () => {
    expect(guard.canActivate(makeContext(`Bearer ${signPlatform()}`))).toBe(
      true,
    );
  });

  it('伪造 token（错误密钥签名）→ 401（AI_001）', () => {
    const forged = jwt.sign(
      { id: 1, username: 'x', tenantId: 't_001', roles: ['SUPER_ADMIN'] },
      'wrong-secret',
      {
        issuer: 'zhixiang-system',
        audience: 'zhixiang-client',
      },
    );
    expect(() => guard.canActivate(makeContext(`Bearer ${forged}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('错误 issuer 的 token（跨域冒充）→ 401', () => {
    const fake = jwt.sign(
      { id: 1, tenantId: 't_001', roles: ['SUPER_ADMIN'] },
      SECRET,
      {
        issuer: 'evil-issuer',
        audience: 'zhixiang-client',
      },
    );
    expect(() => guard.canActivate(makeContext(`Bearer ${fake}`))).toThrow(
      UnauthorizedException,
    );
  });

  it('缺少 Authorization 头 → 401', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('Bearer 以外任意 token → 401', () => {
    expect(() => guard.canActivate(makeContext('garbage-token'))).toThrow(
      UnauthorizedException,
    );
  });
});

describe('JwtGuard（仅要求有效 JWT，不校验角色）', () => {
  let guard: JwtGuard;

  beforeAll(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  beforeEach(() => {
    guard = new JwtGuard();
  });

  it('商家 JWT + 普通角色（CASHIER）→ 放行（语音等非管理端点）', () => {
    const token = signMerchant({
      id: 3,
      username: 'cashier',
      tenantId: 't_001',
      roles: ['CASHIER'],
    });
    expect(guard.canActivate(makeContext(`Bearer ${token}`))).toBe(true);
  });

  it('平台 JWT → 放行', () => {
    expect(guard.canActivate(makeContext(`Bearer ${signPlatform()}`))).toBe(
      true,
    );
  });

  it('缺失/伪造 → 401', () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(makeContext('Bearer bad-token'))).toThrow(
      UnauthorizedException,
    );
  });
});
