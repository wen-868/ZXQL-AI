/**
 * AdminGuard — 管理端点鉴权守卫
 *
 * 依据：2026-09-05 全面审查 P0-2——/api/admin/*、/review、/rag、/voice 等
 * 管理端点此前完全无鉴权（匿名可执行任意工具/读全租户审计/管理 MCP Token）。
 *
 * 放行规则（默认全拒，白名单放行）：
 * 1. 商家 JWT（zhixiang-system）且角色 ∈ MERCHANT_ADMIN_ROLES
 *    （与管理系统 backend/src/middleware/auth.ts 的 ADMIN_ROLES 对齐）
 * 2. 平台 JWT（zhixiang-platform，总台 saas-admin 签发的平台管理员）
 *
 * 错误响应对齐 AI 错误码规范：401→AI_001、403→AI_010。
 * 守卫只做认证与角色判定，不注入 TenantContext（管理端点均显式传 tenantId 参数）。
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { aiError } from '../common/ai-errors';
import {
  MERCHANT_JWT_VERIFY,
  PLATFORM_JWT_VERIFY,
  type MerchantJwtPayload,
  type PlatformJwtPayload,
} from './jwt-verify';

/** 商家侧管理角色（与管理系统 ADMIN_ROLES 一致；门店/收银角色不开放管理端点） */
export const MERCHANT_ADMIN_ROLES = [
  'SUPER_ADMIN',
  'OPERATION_ADMIN',
  'WAREHOUSE_ADMIN',
  'FINANCE_ADMIN',
] as const;

/**
 * 管理端身份（2026-10-04 P0 修复：AdminGuard 验签通过后挂到 request，
 * 管理路由不在 TenantMiddleware 覆盖内，控制器以此做"商户锁本租户、
 * 平台可跨租户"的租户归属判定，不再依赖调用方自报 tenantId）
 */
export interface AdminIdentity {
  identityType: 'merchant' | 'platform';
  /** 商户 JWT 必有；平台 JWT 通常无（跨租户） */
  tenantId?: string;
  userId: number;
  username: string;
  roles?: string[];
}

/** express Request 上的身份挂载键 */
const IDENTITY_KEY = 'adminIdentity';

/** 从 request 取守卫挂载的管理端身份（缺失即拒绝，防绕过守卫直调） */
export function getAdminIdentity(req: Request): AdminIdentity {
  const identity = (req as Request & { [IDENTITY_KEY]?: AdminIdentity })
    .adminIdentity;
  if (!identity) {
    throw new ForbiddenException({
      statusCode: 403,
      ...aiError('AI_010', {
        detail: '缺少管理端身份（须先经 AdminGuard/JwtGuard 鉴权）',
      }),
    });
  }
  return identity;
}

/** 验签成功后把 payload 归一为 AdminIdentity 挂到 request */
function attachIdentity(
  req: Request,
  identityType: 'merchant' | 'platform',
  payload: {
    id: number;
    username: string;
    tenantId?: string;
    roles?: string[];
  },
): void {
  (req as Request & { [IDENTITY_KEY]?: AdminIdentity }).adminIdentity = {
    identityType,
    tenantId: payload.tenantId,
    userId: payload.id,
    username: payload.username,
    roles: payload.roles,
  };
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '')
      .trim();

    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: '缺少 Authorization Bearer JWT' }),
      });
    }

    const secret = process.env.JWT_SECRET || '';
    if (!secret) {
      // 密钥未配置属部署错误：拒绝而非降级（对齐 TenantMiddleware 严格模式）
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: '服务端未配置 JWT_SECRET' }),
      });
    }

    try {
      const payload = jwt.verify(
        token,
        secret,
        MERCHANT_JWT_VERIFY,
      ) as unknown as MerchantJwtPayload;
      const roles = Array.isArray(payload.roles) ? payload.roles : [];
      if (
        !roles.some((r) =>
          (MERCHANT_ADMIN_ROLES as readonly string[]).includes(r),
        )
      ) {
        throw new ForbiddenException({
          statusCode: 403,
          ...aiError('AI_010', {
            detail: `角色 [${roles.join(', ') || '无'}] 无管理端点权限`,
          }),
        });
      }
      attachIdentity(req, 'merchant', payload);
      return true;
    } catch (err) {
      if (err instanceof ForbiddenException) {
        throw err;
      }
      // 商家 JWT 无效 → 继续尝试平台 JWT（总台身份）
    }

    try {
      const payload = jwt.verify(
        token,
        secret,
        PLATFORM_JWT_VERIFY,
      ) as unknown as PlatformJwtPayload;
      attachIdentity(req, 'platform', payload);
      return true;
    } catch {
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: 'JWT 无效或已过期' }),
      });
    }
  }
}

/**
 * JwtGuard — 仅要求有效 JWT（不校验角色），用于非管理但需登录的端点（如 /voice TTS）
 *
 * 与 AdminGuard 同口径：商家 JWT 或平台 JWT 验签通过即放行，其余 401（AI_001）。
 */
@Injectable()
export class JwtGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const token = (req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '')
      .trim();

    if (!token) {
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: '缺少 Authorization Bearer JWT' }),
      });
    }

    const secret = process.env.JWT_SECRET || '';
    if (!secret) {
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: '服务端未配置 JWT_SECRET' }),
      });
    }

    try {
      const payload = jwt.verify(
        token,
        secret,
        MERCHANT_JWT_VERIFY,
      ) as unknown as MerchantJwtPayload;
      attachIdentity(req, 'merchant', payload);
      return true;
    } catch {
      // 商家 JWT 无效 → 尝试平台 JWT
    }

    try {
      const payload = jwt.verify(
        token,
        secret,
        PLATFORM_JWT_VERIFY,
      ) as unknown as PlatformJwtPayload;
      attachIdentity(req, 'platform', payload);
      return true;
    } catch {
      throw new UnauthorizedException({
        statusCode: 401,
        ...aiError('AI_001', { detail: 'JWT 无效或已过期' }),
      });
    }
  }
}
