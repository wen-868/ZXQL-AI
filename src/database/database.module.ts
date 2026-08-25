/**
 * 数据库模块
 *
 * 职责：
 * 1. 配置 TypeORM 连接 MySQL（与现有 Express.js backend 共享同一数据库实例）
 * 2. 注册所有 AI 底座 Entity（5 张表）
 * 3. 导出 Entity Repository 供 BridgeModule / TenantModule / GatewayModule 注入
 *
 * 连接配置来源：.env 环境变量（DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_DATABASE）
 * 库名必须与 backend/.env 的 DB_NAME 一致（默认 liquor_inventory）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiAuditLogEntity } from './entities/ai-audit-log.entity';
import { AiUsageDailyEntity } from './entities/ai-usage-daily.entity';
import { PlatformAiConfigEntity } from './entities/platform-ai-config.entity';
import { TenantAiConfigEntity } from './entities/tenant-ai-config.entity';
import { TenantAiBillingEntity } from './entities/tenant-ai-billing.entity';
import { AiExternalModelEntity } from './entities/ai-external-model.entity';
import { AiReviewTaskEntity } from './entities/ai-review-task.entity';
import { AiLtmProfileEntity } from './entities/ai-ltm-profile.entity';
import { AiLtmEpisodicEntity } from './entities/ai-ltm-episodic.entity';
import { AiLtmArchivalEntity } from './entities/ai-ltm-archival.entity';
import { AiLearningLogEntity } from './entities/ai-learning-log.entity';
import { AiEvolutionEntity } from './entities/ai-evolution.entity';
import { McpTokenEntity } from './entities/mcp-token.entity';
import { AiSessionArchiveEntity } from './entities/ai-session-archive.entity';

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
  AiReviewTaskEntity,
  AiLtmProfileEntity,
  AiLtmEpisodicEntity,
  AiLtmArchivalEntity,
  AiLearningLogEntity,
  AiEvolutionEntity,
  McpTokenEntity,
  AiSessionArchiveEntity,
];

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql' as const,
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
      }),
    }),
    TypeOrmModule.forFeature(AI_ENTITIES),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
