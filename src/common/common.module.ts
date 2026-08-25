/**
 * CommonModule — 公共能力模块
 *
 * 职责：
 * 1. 注册 RateLimiterService（令牌桶限流，Redis + 内存降级）
 * 2. 导出 RateLimiterService 供 TenantModule 的中间件注入使用
 *
 * 注意：
 * - RateLimiterMiddleware / RequestLoggingMiddleware 因依赖 TenantContext，
 *   注册在 TenantModule（避免模块循环依赖），本模块不注册。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Module } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter';
import { MetricsService } from './metrics.service';

@Module({
  providers: [RateLimiterService, MetricsService],
  exports: [RateLimiterService, MetricsService],
})
export class CommonModule {}
