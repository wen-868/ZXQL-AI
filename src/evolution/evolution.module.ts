/**
 * EvolutionModule — ai_db 认知闭环模块（P1-1）
 *
 * 四层：采集（CaptureService）→ 萃取（ExperienceExtractorService）
 *       → 聚合（AggregatorService）→ 反哺（EvolutionVersionService）
 *
 * 依赖：
 * - AiDbModule（ai_db 独立连接 + 4 实体）
 * - ProvidersModule（萃取 LLM 调用）
 * - TenantModule（AiConfigService：萃取 LLM 凭据解析，R101-AI-19）
 * - 默认业务连接（PlatformAiConfigEntity：E5 自治策略开关读取，迁移 007）
 *
 * 被 BrainModule 导入（Orchestrator/LearningService 采集接入），
 * 服务导出供 Gateway 管理 API 注入。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiDbModule } from '../database/ai-db.module';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { ProvidersModule } from '../providers/providers.module';
import { TenantModule } from '../tenant/tenant.module';
import { CaptureService } from './capture.service';
import { AggregatorService } from './aggregator.service';
import { ExperienceExtractorService } from './experience-extractor.service';
import { EvolutionVersionService } from './evolution-version.service';
import { E4DistillationService } from './e4-distillation.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    AiDbModule,
    ProvidersModule,
    CommonModule,
    // R101-AI-19：萃取 LLM 凭据改经 AiConfigService 解析（不再用 env 基线实例），
    // 故本模块需能看到 AiConfigService。TenantModule 不反向依赖本模块，无环。
    TenantModule,
    TypeOrmModule.forFeature([PlatformAiConfigEntity]),
  ],
  providers: [
    CaptureService,
    AggregatorService,
    ExperienceExtractorService,
    EvolutionVersionService,
    E4DistillationService,
  ],
  exports: [
    CaptureService,
    AggregatorService,
    ExperienceExtractorService,
    EvolutionVersionService,
    E4DistillationService,
  ],
})
export class EvolutionModule {}
