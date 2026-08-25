/**
 * TenantModule — 多租户模块
 *
 * 职责：
 * 1. 注册 TenantContext / CryptoService / AiConfigService / AiConfigAdminService 为 NestJS Provider
 * 2. 注册 TenantMiddleware，应用于 /chat 路由（SSE 对话需要租户上下文）
 * 3. 注册 RateLimiterMiddleware（限流，/api/chat）+ RequestLoggingMiddleware（请求日志，全局）
 * 4. 导出 TenantContext / CryptoService / AiConfigService / AiConfigAdminService 供其他模块注入
 *
 * 中间件执行顺序（R70-19 安全增强）：
 *   RequestLoggingMiddleware（最外层，记录整链路耗时）
 *     → TenantMiddleware（提取租户上下文）
 *       → RateLimiterMiddleware（按租户令牌桶限流，超限 429）
 *         → Controller
 *
 * 依赖：
 * - DatabaseModule（TypeORM Repository：TenantAiConfigEntity / PlatformAiConfigEntity / AiUsageDailyEntity / TenantAiBillingEntity）
 * - CommonModule（RateLimiterService：令牌桶限流）
 * - ConfigService（JWT_SECRET / ENCRYPTION_KEY）
 *
 * 被 AppModule 导入，GatewayModule 也会导入以获取 AiConfigService / AiConfigAdminService。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01 | 更新: 2026-08-02 阿坚（R70-19 限流+请求日志+配置管理）
 */
import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { AiUsageDailyEntity } from '../database/entities/ai-usage-daily.entity';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { AiExternalModelEntity } from '../database/entities/ai-external-model.entity';
import { CommonModule } from '../common/common.module';
import { ProvidersModule } from '../providers/providers.module';
import { RateLimiterMiddleware } from '../common/rate-limiter.middleware';
import { RequestLoggingMiddleware } from '../common/request-logging.middleware';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { AiConfigService } from './ai-config.service';
import { AiConfigAdminService } from './ai-config-admin.service';
import { TenantMiddleware } from './tenant.middleware';
import { ExternalModelService } from './external-model.service';
import { BillingService } from './billing.service';

@Module({
  imports: [
    CommonModule,
    ProvidersModule,
    TypeOrmModule.forFeature([
      TenantAiConfigEntity,
      PlatformAiConfigEntity,
      AiUsageDailyEntity,
      TenantAiBillingEntity,
      AiExternalModelEntity,
    ]),
  ],
  providers: [
    TenantContext,
    CryptoService,
    AiConfigService,
    AiConfigAdminService,
    TenantMiddleware,
    RateLimiterMiddleware,
    RequestLoggingMiddleware,
    ExternalModelService,
    BillingService,
  ],
  exports: [
    TenantContext,
    CryptoService,
    AiConfigService,
    AiConfigAdminService,
    ExternalModelService,
    BillingService,
  ],
})
export class TenantModule implements NestModule {
  /**
   * 注册中间件
   *
   * 1. RequestLoggingMiddleware：全局（forRoutes('*')），记录 IP/UA/tenantId/响应时间
   * 2. TenantMiddleware + RateLimiterMiddleware：应用于 /chat 路由（POST /api/chat SSE 对话）
   *    与 /ai/agent 路由（P0-1 WriteGuard 统一确认端点 POST /api/ai/agent/confirm）
   *
   * 注意：forRoutes('chat') 匹配的是控制器路径（不含全局前缀 /api），
   * 实际匹配的 HTTP 路径为 POST /api/chat。
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestLoggingMiddleware)
      .forRoutes('*')
      .apply(TenantMiddleware, RateLimiterMiddleware)
      .forRoutes('chat', 'ai/agent', 'ai/v2');
  }
}
