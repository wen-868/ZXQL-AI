/**
 * RequestLoggingMiddleware — 请求日志中间件
 *
 * 职责：
 * 1. 记录每次 HTTP 请求的 IP / User-Agent / tenantId / 方法 / 路径 / 状态码 / 响应耗时
 * 2. 通过 res.on('finish') 在响应完成时记录，覆盖整个请求生命周期
 * 3. tenantId 从 TenantContext 读取（在 TenantMiddleware 之后注册时才有值）
 *
 * 应用范围：全局（forRoutes('*')）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenantContext } from '../tenant/tenant-context';

@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestLoggingMiddleware.name);

  constructor(private readonly tenantContext: TenantContext) {}

  /**
   * 记录请求日志（响应完成时输出）
   */
  use(req: Request, res: Response, next: NextFunction): void {
    const startAt = process.hrtime();

    res.on('finish', () => {
      const [sec, nano] = process.hrtime(startAt);
      const costMs = Math.round(sec * 1000 + nano / 1e6);
      const tenantId = this.tenantContext.getData()?.tenantId;

      this.logger.log(
        {
          ip: this.getClientIp(req),
          userAgent: req.headers['user-agent'] ?? '',
          tenantId: tenantId ?? null,
          method: req.method,
          url: req.originalUrl ?? req.url,
          status: res.statusCode,
          costMs,
        },
        'HTTP 请求完成',
      );
    });

    next();
  }

  /**
   * 获取客户端 IP（优先取 X-Forwarded-For 首项，兼容反向代理）
   */
  private getClientIp(req: Request): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0].trim();
    }
    return req.ip ?? 'unknown';
  }
}
