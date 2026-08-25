/**
 * Gateway 模块 — 对外接口层
 *
 * 职责：
 * 1. 注册 ChatController（SSE 流式对话接口）
 * 2. 注册 AdminController（管理 API：工具/Provider/健康检查/审计日志）
 *
 * 依赖：
 * - ProvidersModule（ProviderFactory：创建/管理 LLM Provider 实例）
 * - ToolsModule（ToolRegistry + ToolExecutor：工具注册与执行）
 * - BridgeModule（ServiceClient：后端 API 调用 + AuditLogger：审计日志）
 *
 * 被 AppModule 直接导入，Controller 自动注册到 NestJS 路由系统。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { WriteGuardController } from './write-guard.controller';
import { AgentController } from './agent.controller';
import { McpController } from './mcp.controller';
import { McpAdminController } from './mcp-admin.controller';
import { AiDbController } from './ai-db.controller';
import { CircuitBreakerController } from './circuit-breaker.controller';
import { AdminController } from './admin.controller';
import { AiConfigController } from './ai-config.controller';
import { ExternalModelController } from './external-model.controller';
import { ReviewController } from './review.controller';
import { ApiCatalogController } from './api-catalog.controller';
import { LearningController } from './learning.controller';
import { EvolutionController } from './evolution.controller';
import { LtmController } from './ltm.controller';
import { ProvidersModule } from '../providers/providers.module';
import { ToolsModule } from '../tools/tools.module';
import { BridgeModule } from '../bridge/bridge.module';
import { TenantModule } from '../tenant/tenant.module';
import { BrainModule } from '../brain/brain.module';
import { DatabaseModule } from '../database/database.module';
import { AiDbModule } from '../database/ai-db.module';
import { EvolutionModule } from '../evolution/evolution.module';
import { CommonModule } from '../common/common.module';
import { PushGatewayService } from './push-gateway.service';
import { VisionService } from '../providers/vision.service';
import { VoiceService } from '../providers/voice.service';
import { VoiceController } from './voice.controller';

/**
 * Gateway 模块 — 对外接口层
 *
 * 职责：
 * 1. 注册 ChatController（SSE 流式对话接口）
 * 2. 注册 AdminController（管理 API：工具/Provider/健康检查/审计日志）
 *
 * 依赖：
 * - BrainModule（Orchestrator：Agent Loop 编排 + MemoryManager：对话记忆）✅ R70-08
 * - TenantModule（AiConfigService：租户 AI 配置 + TenantContext：租户上下文）✅ R70-07
 * - DatabaseModule（TypeORM DataSource，AdminController 健康检查注入）✅ R70-22
 * - ProvidersModule / ToolsModule / BridgeModule（通过 BrainModule 间接依赖）
 *
 * 被 AppModule 直接导入，Controller 自动注册到 NestJS 路由系统。
 * TenantMiddleware 在 TenantModule 中注册，应用于 /chat 路由。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
@Module({
  imports: [
    BrainModule,
    TenantModule,
    DatabaseModule,
    AiDbModule,
    EvolutionModule,
    CommonModule,
    ProvidersModule,
    ToolsModule,
    BridgeModule,
  ],
  controllers: [
    ChatController,
    AgentController,
    WriteGuardController,
    McpController,
    McpAdminController,
    AiDbController,
    CircuitBreakerController,
    AdminController,
    AiConfigController,
    ExternalModelController,
    ReviewController,
    ApiCatalogController,
    LearningController,
    EvolutionController,
    LtmController,
    VoiceController,
  ],
  providers: [PushGatewayService, VisionService, VoiceService],
  exports: [PushGatewayService],
})
export class GatewayModule {}
