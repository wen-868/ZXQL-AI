/**
 * 数据库模块
 *
 * 职责：
 * 1. 配置 TypeORM 连接 MySQL（与现有 Express.js backend 共享同一数据库实例）
 * 2. 注册所有 AI 底座 Entity（**清单以下方 `AI_ENTITIES` 常量为准，不写死数量**——
 *    历史上写作"5 张表"，随 Entity 增加已漂移到实际 20 项；数量会随新增再次漂移，
 *    故改为以清单为准的自校验表述）
 * 3. 导出 Entity Repository 供 BridgeModule / TenantModule / GatewayModule 注入
 *
 * 连接配置来源：.env 环境变量（DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_DATABASE）
 * 库名必须与 backend/.env 的 DB_NAME 一致（默认 liquor_inventory）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { AiAuditLogEntity } from './entities/ai-audit-log.entity';
import { AiUsageDailyEntity } from './entities/ai-usage-daily.entity';
import { PlatformAiConfigEntity } from './entities/platform-ai-config.entity';
import { TenantAiConfigEntity } from './entities/tenant-ai-config.entity';
import { TenantAiBillingEntity } from './entities/tenant-ai-billing.entity';
import { AiExternalModelEntity } from './entities/ai-external-model.entity';
import { AiModelPriceEntity } from './entities/ai-model-price.entity';
import { AiReviewTaskEntity } from './entities/ai-review-task.entity';
import { AiLtmProfileEntity } from './entities/ai-ltm-profile.entity';
import { AiLtmEpisodicEntity } from './entities/ai-ltm-episodic.entity';
import { AiLtmArchivalEntity } from './entities/ai-ltm-archival.entity';
import { AiLearningLogEntity } from './entities/ai-learning-log.entity';
import { AiEvolutionEntity } from './entities/ai-evolution.entity';
import { McpTokenEntity } from './entities/mcp-token.entity';
import { AiSessionArchiveEntity } from './entities/ai-session-archive.entity';
import { AiExecutionPlanEntity } from './entities/ai-execution-plan.entity';
import { AiIdempotencyEntity } from './entities/ai-idempotency.entity';
import { AiDeadLetterEntity } from './entities/ai-dead-letter.entity';
// R101-AI-35 S1：文档中心（办公能力第一批）
import { AiDocEntity } from './entities/ai-doc.entity';
import { AiAclEntity } from './entities/ai-acl.entity';
// R101-AI-37 办公批次 2：待办
import { AiTodoEntity } from './entities/ai-todo.entity';
// R101-AI-38 办公批次 3：审批实例
import { AiApprovalEntity } from './entities/ai-approval.entity';
// R101-AI-39 办公批次 4：日程
import { AiScheduleEntity } from './entities/ai-schedule.entity';
import {
  ensureStandaloneDbDirectory,
  isStandaloneMode,
  resolveStandaloneDatabasePath,
} from './dialect';
import {
  AiEmployeeEntity,
  AiEmployeeTaskEntity,
} from './entities/ai-employee.entity';

/**
 * 所有 AI 底座 Entity 列表
 *
 * 供 TypeOrmModule.forFeature() 和 TypeOrmModule.forRoot() 的 entities 配置共用。
 */
export const AI_ENTITIES = [
  AiAuditLogEntity,
  AiUsageDailyEntity,
  PlatformAiConfigEntity,
  TenantAiConfigEntity,
  TenantAiBillingEntity,
  AiExternalModelEntity,
  AiModelPriceEntity,
  AiReviewTaskEntity,
  AiLtmProfileEntity,
  AiLtmEpisodicEntity,
  AiLtmArchivalEntity,
  AiLearningLogEntity,
  AiEvolutionEntity,
  McpTokenEntity,
  AiSessionArchiveEntity,
  AiExecutionPlanEntity,
  // R101-AI-21：写工具幂等键（业务库 t_ai_idempotency，迁移 016）
  AiIdempotencyEntity,
  // R101-AI-22：bestEffort 死信落库（业务库 t_ai_dead_letter，迁移 017）
  AiDeadLetterEntity,
  AiEmployeeEntity,
  AiEmployeeTaskEntity,
  // R101-AI-35 S1：办公能力第一批（文档中心）—— t_ai_doc / t_ai_doc_acl
  // 注：结构变更走增量 migrations-sqlite/001_ai_doc.sql（**不重生成 000 基线**，R101-AI-30 乙案）
  AiDocEntity,
  AiAclEntity,
  // R101-AI-37 办公批次 2：待办（t_ai_todo，迁移 019 / sqlite 增量 002）
  AiTodoEntity,
  // R101-AI-38 办公批次 3：审批实例（t_ai_approval，迁移 020 / sqlite 增量 003）
  AiApprovalEntity,
  // R101-AI-39 办公批次 4：日程（t_ai_schedule，迁移 021 / sqlite 增量 004）
  AiScheduleEntity,
];

/**
 * 装配 TypeORM 连接选项（R101-AI-30：按 `INTEGRATION_MODE` 双形态）
 *
 * 抽成**可测导出函数**：让双形态装配可被单测直接断言，而不必真连库。
 *
 * - standalone（桌面嵌入）⇒ `better-sqlite3`：单文件 `data/app.db`（可用 `STANDALONE_DB_PATH` 覆盖）
 *   + `enableWAL: true`；首次启动自动建 `data/` 目录（better-sqlite3 不建父目录）
 * - connected（缺省，共享/云生产）⇒ MySQL，**逐键与改造前一致（生产零改动）**
 */
export function buildTypeOrmOptions(
  configService: ConfigService,
): TypeOrmModuleOptions {
  if (isStandaloneMode()) {
    // R101-AI-30 部署修复：better-sqlite3 为 optionalDependencies（云端 Linux 无编译工具链时
    // prebuild-install/node-gyp 会失败，但 optional 失败不阻塞 pnpm install——生产 connected 用 MySQL 不需要它）。
    // ⇒ standalone（桌面端）启动时必须显式检测可用性：未安装 ⇒ 明确报错（不静默走到驱动加载才炸）。
    try {
      // 运行时探测 better-sqlite3（optionalDependencies：云端安装失败不阻塞；connected 用 MySQL 不需要它）。
      // 静态 import 会在加载期直接崩 ⇒ 必须运行时 require 才能优雅检测（豁免 no-require-imports）：
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('better-sqlite3');
    } catch {
      throw new Error(
        'standalone 模式需要 better-sqlite3（optionalDependencies），但当前环境未安装或原生绑定不可用。' +
          '修复：在桌面端环境执行 `pnpm install`（allowBuilds 已放行其 install 脚本）；' +
          '若为云端/服务器环境，请改用 connected 模式（缺省，使用 MySQL）。',
      );
    }
    const dbPath = resolveStandaloneDatabasePath();
    ensureStandaloneDbDirectory(dbPath);
    return {
      type: 'better-sqlite3',
      database: dbPath,
      entities: AI_ENTITIES,
      synchronize: false, // 桌面端建表走 migrations-sqlite/000_baseline.sql（乙案）
      logging:
        configService.get<string>('NODE_ENV') === 'development'
          ? ['error', 'warn']
          : ['error'],
      enableWAL: true, // 并发读 + 崩溃安全（驱动原生选项）
    };
  }
  return {
    type: 'mysql',
    host: configService.get<string>('DB_HOST', '127.0.0.1'),
    port: configService.get<number>('DB_PORT', 3306),
    username: configService.get<string>('DB_USERNAME', 'root'),
    password: configService.get<string>('DB_PASSWORD', ''),
    database: configService.get<string>('DB_DATABASE', 'liquor_inventory'),
    entities: AI_ENTITIES,
    synchronize: false, // 生产环境禁止自动同步，使用 migration 脚本建表
    logging:
      configService.get<string>('NODE_ENV') === 'development'
        ? ['error', 'warn']
        : ['error'],
    timezone: '+08:00', // 东八区，与现有 backend 保持一致
    charset: 'utf8mb4',
    poolSize: 10,
    extra: {
      connectionLimit: 10,
    },
  };
}

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildTypeOrmOptions(configService),
    }),
    TypeOrmModule.forFeature(AI_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
