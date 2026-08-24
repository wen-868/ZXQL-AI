/**
 * AiDbModule — AI 底座私有库（ai_db）独立连接（P1-1）
 *
 * 依据：权威文档 26.4——ai_db 是 AI 底座的训练与进化专属库，
 * 与业务库物理隔离（独立 schema/连接），跨租户聚合仅限脱敏后的公共模式。
 *
 * 配置：与业务库同一 MySQL 实例、独立 database=ai_db
 * （DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD 共用，DB_AI_DATABASE 可覆盖）。
 * 启动时若 ai_db 库不存在会报错 → 部署脚本先执行 migrations/003_ai_db_evolution.sql。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiExperienceEntity } from './entities/ai-experience.entity';
import { AiCorrectionEntity } from './entities/ai-correction.entity';
import { AiSampleEntity } from './entities/ai-sample.entity';
import { AiEvolutionVersionEntity } from './entities/ai-evolution-version.entity';

/** ai_db 全部实体 */
export const AI_DB_ENTITIES = [
  AiExperienceEntity,
  AiCorrectionEntity,
  AiSampleEntity,
  AiEvolutionVersionEntity,
];

/** ai_db 数据源名称（TypeORM 多连接） */
export const AI_DB_CONNECTION = 'ai_db';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: AI_DB_CONNECTION,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'mysql' as const,
        host: configService.get<string>('DB_HOST', '127.0.0.1'),
        port: configService.get<number>('DB_PORT', 3306),
        username: configService.get<string>('DB_USERNAME', 'root'),
        password: configService.get<string>('DB_PASSWORD', ''),
        database: configService.get<string>('DB_AI_DATABASE', 'ai_db'),
        entities: AI_DB_ENTITIES,
        synchronize: false, // 迁移脚本建表（migrations/003）
        logging:
          configService.get<string>('NODE_ENV') === 'development'
            ? ['error', 'warn']
            : ['error'],
        timezone: '+08:00',
        charset: 'utf8mb4',
        poolSize: 4,
      }),
    }),
    TypeOrmModule.forFeature(AI_DB_ENTITIES, AI_DB_CONNECTION),
  ],
  exports: [TypeOrmModule],
})
export class AiDbModule {}
