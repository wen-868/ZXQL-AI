/**
 * CommonModule — 公共能力模块
 *
 * 职责：
 * 1. 注册 RateLimiterService（令牌桶限流，Redis + 内存降级）
 * 2. 注册 RedisProvider（R101-AI-10：全仓唯一 Redis 连接来源）
 * 3. 导出上述两者供 TenantModule / BrainModule / GatewayModule 注入
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
import { RedisProvider } from './redis.provider';

@Module({
  providers: [RateLimiterService, MetricsService, RedisProvider],
  exports: [RateLimiterService, MetricsService, RedisProvider],
})
export class CommonModule {}
