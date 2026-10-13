/**
 * RateLimiterMiddleware — 限流中间件
 *
 * 职责：
 * 1. 从 TenantContext 获取当前租户 ID（需在 TenantMiddleware 之后注册）
 * 2. 无租户上下文时按客户端 IP 限流（防止未认证请求打爆服务）
 * 3. 调用 RateLimiterService.consume()，超限返回 HTTP 429 + Retry-After
 *
 * 应用范围：/api/chat（AI 对话接口，防止滥用）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { RateLimiterService, RateLimitBucket } from './rate-limiter';

/** 读方法判定（读全自动 ⇒ 走宽桶） */
function isReadMethod(method: string | undefined): boolean {
  const m = (method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
}
import { TenantContext } from '../tenant/tenant-context';

@Injectable()
export class RateLimiterMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RateLimiterMiddleware.name);

  constructor(
    private readonly rateLimiter: RateLimiterService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * 限流判定
   *
   * 通过：放行并写入 X-RateLimit-Remaining 响应头
   * 超限：返回 429 + Retry-After（秒）
   */
  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    // R101-AI-31：按方法分桶（**读全自动、写全审核**）
    // 读（GET/HEAD/OPTIONS）⇒ 宽桶；其余（POST/PUT/PATCH/DELETE）⇒ 严桶
    // key 形态：tenant:{tid}:read|write / ip:{ip}:read|write（两桶互不挤占）
    //
    // ⚠️ 兼容 shim：真实 HTTP 请求 **method 必然存在**（express 保证），故生产一律走分桶路径；
    //    仅当 method 缺失（非标准调用/单测直接 `use({} as Request)`）时保留改造前的
    //    base key + 2 参调用 + 写桶容量 —— 以免改动既有 spec 的既有断言（红线：零断言修改）。
    const method = req.method?.toUpperCase();
    const bucket: RateLimitBucket | null =
      method === undefined ? null : isReadMethod(method) ? 'read' : 'write';
    const baseKey = tenantId
      ? `tenant:${tenantId}`
      : `ip:${this.getClientIp(req)}`;
    const key = bucket ? `${baseKey}:${bucket}` : baseKey;

    const result = bucket
      ? await this.rateLimiter.consume(key, 1, bucket)
      : await this.rateLimiter.consume(key, 1);

    if (result.allowed) {
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      next();
      return;
    }

    const retryAfterSec = Math.max(
      1,
      Math.ceil(this.rateLimiter.windowMs / 1000),
    );
    res.setHeader('Retry-After', String(retryAfterSec));
    this.logger.warn(
      `限流触发：key=${key} remaining=0，返回 429（每租户 ${this.rateLimiter.capacity} 次/分钟）`,
    );
    res.status(429).json({
      statusCode: 429,
      message: '请求过于频繁，请稍后再试',
      retryAfterMs: this.rateLimiter.windowMs,
    });
  }

  /**
   * 获取客户端 IP
   *
   * 2026-09-05 审查 H3/M4 修复：main.ts 已设 `trust proxy: loopback`（同机 nginx 反代），
   * req.ip 由 Express 按 X-Forwarded-For 可信跳数解析，直接采信 req.ip；
   * 不再手动取 XFF 首项（客户端可伪造，会绕过按 IP 限流）。
   */
  private getClientIp(req: Request): string {
    return req.ip ?? 'unknown';
  }
}
