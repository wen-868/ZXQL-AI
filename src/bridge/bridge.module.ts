/**
 * Bridge 模块 — 服务桥接层
 *
 * 职责：
 * 1. 导出 ServiceClient（HTTP 客户端，调用现有 Express.js 单体后端 API）
 * 2. 导出 AuditLogger（审计日志服务，写入 t_ai_audit_log + t_ai_usage_daily）
 *
 * 依赖：
 * - DatabaseModule（提供 TypeORM Repository 注入）
 * - ConfigModule（提供环境变量，已全局注册）
 *
 * 被以下模块导入：
 * - ToolsModule（ToolExecutor 注入 AuditLogger 记录工具执行审计）
 * - GatewayModule（R70-06 ChatController 注入 ServiceClient 做 healthCheck）
 * - BrainModule（R70-08 Orchestrator 注入 AuditLogger 记录 AI 调用审计）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Module } from '@nestjs/common';
import { ServiceClient } from './service-client';
import { AuditLogger } from './audit-logger';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [ServiceClient, AuditLogger],
  exports: [ServiceClient, AuditLogger],
})
export class BridgeModule {}
