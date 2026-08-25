/**
 * TenantMiddleware — 租户上下文中间件
 *
 * 职责：
 * 1. 从 Authorization Header 提取 JWT 并验证（与现有 backend/src/middleware/auth.ts 对齐）
 * 2. 从 JWT payload 提取 tenantId / userId / roles，注入 TenantContext（AsyncLocalStorage）
 * 3. 兼容模式：无 JWT 时从请求体读取 tenantId（R70-06 过渡期，R70-16 前端接入后移除）
 * 4. 用 TenantContext.run() 包裹 next()，确保整个请求链路（Guard → Interceptor → Controller → Service → Tool）
 *    都能通过 TenantContext.getTenantId() 获取当前租户
 *
 * JWT 验证规则（与 backend/src/middleware/auth.ts 完全对齐）：
 * - 算法：HS256
 * - 密钥：JWT_SECRET（与现有 backend 共享）
 * - issuer：zhixiang-system（商家 JWT）
 * - audience：zhixiang-client
 * - payload 结构：{ id, username, realName, roles, storeId, tenantId }
 *
 * 执行顺序（NestJS 请求生命周期）：
 *   Middleware → Guard → Interceptor(before) → Pipe → Controller → Interceptor(after)
 * 本中间件在最外层包裹 AsyncLocalStorage，所有后续阶段都能访问 TenantContext。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.3 多租户隔离
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { TenantContext, TenantContextData } from './tenant-context';

/**
 * 后端 JWT payload 结构（与 backend/src/middleware/auth.ts 的 AuthUser 对齐）
 */
interface AuthUserPayload extends JwtPayload {
  id: number;
  username: string;
  realName?: string;
  roles: string[];
  storeId?: number | null;
  tenantId: string;
  /** 运营客户端：客户 ID（role=customer 时存在） */
  customerId?: number | string;
}

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantMiddleware.name);
  private readonly jwtSecret: string;

  constructor(
    private readonly tenantContext: TenantContext,
    private readonly configService: ConfigService,
  ) {
    this.jwtSecret = this.configService.get<string>('JWT_SECRET', '');
    if (!this.jwtSecret) {
      this.logger.warn(
        'JWT_SECRET 未配置，TenantMiddleware 将无法验证 JWT，所有请求降级为请求体 tenantId 模式',
      );
    }
  }

  use(req: Request, _res: Response, next: NextFunction): void {
    const data = this.extractTenantData(req);

    if (!data) {
      // 无法提取租户信息，继续执行（ChatController 会检查 TenantContext 是否活跃）
      this.logger.debug(
        `无法提取租户信息：${req.method} ${req.path}（无 JWT 且无 body.tenantId）`,
      );
      next();
      return;
    }

    // 用 AsyncLocalStorage 包裹整个请求链路
    this.tenantContext.run(data, () => next());
  }

  /**
   * 从请求中提取租户上下文数据
   *
   * 优先级：
   * 1. Authorization Header 中的 JWT（生产模式）
   * 2. 请求体中的 tenantId（过渡兼容模式，R70-16 前端接入后移除）
   *
   * @returns 租户上下文数据，无法提取返回 undefined
   */
  private extractTenantData(req: Request): TenantContextData | undefined {
    // 1. 尝试从 JWT 提取
    const jwtData = this.extractFromJwt(req);
    if (jwtData) {
      return jwtData;
    }

    // 2. 兼容模式：从请求体提取（R70-06 过渡期）
    return this.extractFromBody(req);
  }

  /**
   * 从 Authorization Header 提取 JWT 并解析
   */
  private extractFromJwt(req: Request): TenantContextData | undefined {
    if (!this.jwtSecret) {
      return undefined;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return undefined;
    }

    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) {
      return undefined;
    }

    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'zhixiang-system',
        audience: 'zhixiang-client',
      }) as AuthUserPayload;

      if (!payload.tenantId) {
        this.logger.warn(
          `JWT 验证成功但 payload 中无 tenantId（user=${payload.username}）`,
        );
        return undefined;
      }

      return {
        tenantId: payload.tenantId,
        userId: String(payload.id),
        role: payload.roles?.[0],
        customerId:
          payload.customerId !== undefined
            ? String(payload.customerId)
            : undefined,
        authToken: token,
      };
    } catch (err) {
      this.logger.debug(
        `JWT 验证失败：${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  /**
   * 从请求体提取 tenantId（过渡兼容模式）
   *
   * R70-06 阶段 ChatDto 仍要求传入 tenantId，R70-16 前端接入 JWT 后此方法将不再命中。
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
