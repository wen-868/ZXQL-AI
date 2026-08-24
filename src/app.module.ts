import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProvidersModule } from './providers/providers.module';
import { ToolsModule } from './tools/tools.module';
import { DatabaseModule } from './database/database.module';
import { BridgeModule } from './bridge/bridge.module';
import { BrainModule } from './brain/brain.module';
import { GatewayModule } from './gateway/gateway.module';
import { TenantModule } from './tenant/tenant.module';
import { ProactiveModule } from './brain/proactive/proactive.module';
import { RagModule } from './rag/rag.module';
import { OpsModule } from './ops/ops.module';
import { EvolutionModule } from './evolution/evolution.module';

/**
 * 应用根模块
 *
 * 模块依赖关系（按加载顺序）：
 * 1. ConfigModule — 环境变量全局加载
 * 2. DatabaseModule — TypeORM MySQL 连接 + 5 张 AI 表 Entity 注册 ✅ R70-05 已接入
 * 3. ProvidersModule — DeepSeek / Ollama 模型服务商 ✅ R70-03 已接入
 * 4. BridgeModule — ServiceClient(HTTP 调用后端) + AuditLogger(审计日志) ✅ R70-05 已接入
 * 5. ToolsModule — ToolRegistry + ToolExecutor + EchoTool ✅ R70-04 已接入（R70-05 接入 AuditLogger）
 * 6. TenantModule — TenantContext + CryptoService + AiConfigService + TenantMiddleware ✅ R70-07 已接入
 * 7. BrainModule — ContextBuilder + MemoryManager(Redis) + Orchestrator(Agent Loop) ✅ R70-08 已接入
 * 8. GatewayModule — ChatController(SSE) + AdminController(管理API) ✅ R70-06 已接入（R70-08 接入 Orchestrator）
 * 9. RagModule — RAG 知识库引擎（文档加载/分块/向量化/检索，注入 ContextBuilder）✅ R70-21 已接入
 */
@Module({
  imports: [
    // 环境变量全局加载
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    // 定时任务调度（@Cron/@Interval 生效前提）
    ScheduleModule.forRoot(),
    // 数据库层（TypeORM MySQL 连接 + Entity 注册）
    DatabaseModule,
    // Provider 层（DeepSeek + Ollama + ProviderFactory）
    ProvidersModule,
    // Bridge 层（ServiceClient HTTP 客户端 + AuditLogger 审计日志）
    BridgeModule,
    // Tool 系统（ToolRegistry + ToolExecutor + EchoTool 示例工具）
    ToolsModule,
    // 多租户层（TenantContext + CryptoService + AiConfigService + TenantMiddleware）
    TenantModule,
    // 大脑引擎（ContextBuilder + MemoryManager + Orchestrator Agent Loop）
    BrainModule,
    // Gateway 层（ChatController SSE 流式对话 + AdminController 管理 API）
    GatewayModule,
    // 主动能力层（ProactiveService 9 项定时巡检 + ProactivePushService 推送 + 管理 API）✅ R70-20 已接入
    ProactiveModule,
    // RAG 知识库引擎（文档加载/分块/向量化/检索 + ContextBuilder 增强）✅ R70-21 已接入
    RagModule,
    // 运营闭环（用量统计 + 阈值告警 + 健康监控告警）✅ 完善度 P2 已接入
    OpsModule,
    // ai_db 认知闭环（采集→萃取→聚合→反哺）✅ P1-1 已接入
    EvolutionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
