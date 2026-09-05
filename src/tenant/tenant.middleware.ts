/**
 * TenantMiddleware — 租户上下文中间件
 *
 * 职责：
 * 1. 从 Authorization Header 提取 JWT 并验证（与管理系统 backend/src/middleware/auth.ts 对齐）
 * 2. 商家 JWT（zhixiang-system）与平台 JWT（zhixiang-platform，总台 saas-admin）双验签
 * 3. 验签成功后从 payload 提取 tenantId / userId / roles 注入 TenantContext（AsyncLocalStorage）
 * 4. 用 TenantContext.run() 包裹 next()，确保整个请求链路（Guard → Interceptor → Controller → Service → Tool）
 *    都能通过 TenantContext.getTenantId() 获取当前租户
 *
 * 身份来源铁律（2026-09-05 全面审查 P0-3 修复）：
 * - tenantId / userId / role / customerId 一律只认 JWT payload，不再从请求体读取
 *   （旧"请求体身份模式"已在 R70-16 前端接入 JWT 后移除）
 * - 携带了 token 但验签失败 → 直接 401（不再静默降级为 body 模式，防身份伪造）
 * - 未携带 token → 直接 401（应急回退见 AI_ALLOW_BODY_TENANT）
 * - 平台 JWT 无 tenantId：平台管理员跨租户操作，目标租户允许由请求体指定
 *   （此时身份已验签为平台管理员，body.tenantId 仅是操作目标而非身份凭证）
 *
 * JWT 验证规则（与 backend/src/middleware/auth.ts 完全对齐，见 jwt-verify.ts）：
 * - 算法：HS256（固定，防 alg 混淆）
 * - 密钥：JWT_SECRET（与管理系统 backend 共享）
 * - 商家：issuer=zhixiang-system / audience=zhixiang-client
 * - 平台：issuer=zhixiang-platform / audience=zhixiang-platform-client
 *
 * 执行顺序（NestJS 请求生命周期）：
 *   Middleware → Guard → Interceptor(before) → Pipe → Controller → Interceptor(after)
 * 本中间件在最外层包裹 AsyncLocalStorage，所有后续阶段都能访问 TenantContext。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第七章 7.3 多租户隔离
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01 | 更新: 2026-09-05 鉴权链收紧（双JWT+401+去body身份）
 */
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { aiError } from '../common/ai-errors';
import { TenantContext, TenantContextData } from './tenant-context';
import {
  MERCHANT_JWT_VERIFY,
  PLATFORM_JWT_VERIFY,
  type MerchantJwtPayload,
  type PlatformJwtPayload,
} from './jwt-verify';

/** 身份解析结果：ok=false 时 reason 为 401 原因；data=undefined 表示放行无上下文（仅应急兼容模式） */
type ResolveResult =
  | { ok: false; reason: string }
  | { ok: true; data: TenantContextData | undefined };

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly jwtSecret: string;
  /** 应急回退开关（默认关闭）：true 时恢复旧的"请求体身份模式"（仅限紧急回滚，平时禁止开启） */
  private readonly allowBodyTenant: boolean;

  constructor(
    private readonly tenantContext: TenantContext,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', '');
    this.allowBodyTenant =
      this.configService.get<string>('AI_ALLOW_BODY_TENANT', 'false') ===
      'true';
    if (!this.jwtSecret) {
      this.logger.error(
        'JWT_SECRET 未配置：所有需租户上下文的请求将返回 401（禁止降级为请求体身份模式）',
      );
    }
    if (this.allowBodyTenant) {
      this.logger.warn(
        'AI_ALLOW_BODY_TENANT=true：身份伪造防护已关闭（应急回退模式），仅限临时排查，用完立即关闭！',
      );
    }
  }

  use(req: Request, res: Response, next: NextFunction): void {
    const result = this.resolveContext(req);

    if (!result.ok) {
      res.status(401).json({
        statusCode: 401,
        ...aiError('AI_001', { detail: result.reason }),
      });
      return;
    }

    if (!result.data) {
      // 仅应急兼容模式下可能出现：无租户上下文继续放行，由 Controller 自行 401
      this.logger.debug(
        `无租户上下文放行：${req.method} ${req.path}（应急兼容模式且请求体无 tenantId）`,
      );
      next();
      return;
    }

    // 用 AsyncLocalStorage 包裹整个请求链路
    this.tenantContext.run(result.data, () => next());
  }

  /**
   * 解析租户上下文（严格模式）
   *
   * 优先级：
   * 1. 商家 JWT 验签成功 → 商家身份（tenantId/roles 必来自 payload）
   * 2. 平台 JWT 验签成功 → 平台身份（目标租户允许来自请求体）
   * 3. 携带 token 但均验签失败 → 401（不降级，防伪造）
   * 4. 无 token → 应急兼容开关开启时走旧 body 模式，否则 401
   */
  private resolveContext(req: Request): ResolveResult {
    const authHeader = req.headers.authorization;
    const token = authHeader
      ? authHeader.replace(/^Bearer\s+/i, '').trim()
      : '';

    if (token && !this.jwtSecret) {
      return { ok: false, reason: '服务端未配置 JWT_SECRET，无法验证身份' };
    }

    if (token) {
      // 1. 商家 JWT（租户用户 / 运营客户）
      try {
        const payload = jwt.verify(
          token,
          this.jwtSecret,
          MERCHANT_JWT_VERIFY,
        ) as unknown as MerchantJwtPayload;
        if (!payload.tenantId) {
          this.logger.warn(
            `商家 JWT 有效但缺少 tenantId（user=${payload.username}）`,
          );
          return { ok: false, reason: 'JWT 有效但缺少租户信息（tenantId）' };
        }
        return {
          ok: true,
          data: {
            tenantId: payload.tenantId,
            userId: String(payload.id),
            role: payload.roles?.[0],
            customerId:
              payload.customerId !== undefined
                ? String(payload.customerId)
                : undefined,
            authToken: token,
            authType: 'merchant',
          },
        };
      } catch {
        // 商家 JWT 无效 → 尝试平台 JWT（总台身份）
      }

      // 2. 平台 JWT（总台 saas-admin，跨租户操作）
      try {
        const payload = jwt.verify(
          token,
          this.jwtSecret,
          PLATFORM_JWT_VERIFY,
        ) as unknown as PlatformJwtPayload;
        const body = req.body as Record<string, unknown> | undefined;
        const bodyTenant =
          typeof body?.tenantId === 'string' && body.tenantId
            ? body.tenantId
            : undefined;
        const tenantId = payload.tenantId ?? bodyTenant;
        if (!tenantId) {
          return {
            ok: false,
            reason:
              '平台身份缺少目标租户（payload.tenantId 或请求体 tenantId）',
          };
        }
        return {
          ok: true,
          data: {
            tenantId,
            userId: String(payload.id),
            role: 'platform',
            authToken: token,
            authType: 'platform',
          },
        };
      } catch {
        return { ok: false, reason: 'JWT 无效或已过期' };
      }
    }

    // 3. 无 token：应急兼容开关（默认关闭）
    if (this.allowBodyTenant) {
      const legacy = this.extractFromBody(req);
      if (legacy) {
        this.logger.warn(
          `AI_ALLOW_BODY_TENANT 应急模式：从请求体回退身份 tenant=${legacy.tenantId}（${req.method} ${req.path}）`,
        );
        return { ok: true, data: legacy };
      }
      return { ok: true, data: undefined };
    }

    return {
      ok: false,
      reason: '未认证：请在 Authorization Header 中携带 JWT',
    };
  }

  /**
   * 【仅应急回退】从请求体提取租户身份（R70-06 旧兼容模式，默认禁用）
   *
   * ⚠️ 该模式下身份可被请求体伪造，只应在前端 JWT 接入故障时临时开启。
   */
  private extractFromBody(req: Request): TenantContextData | undefined {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.tenantId !== 'string' || !body.tenantId) {
      return undefined;
    }

    return {
      tenantId: body.tenantId,
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      role: typeof body.role === 'string' ? body.role : undefined,
      customerId:
        typeof body.customerId === 'string' ||
        typeof body.customerId === 'number'
          ? String(body.customerId)
          : undefined,
    };
  }
}
