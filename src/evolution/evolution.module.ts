/**
 * EvolutionModule — ai_db 认知闭环模块（P1-1）
 *
 * 四层：采集（CaptureService）→ 萃取（ExperienceExtractorService）
 *       → 聚合（AggregatorService）→ 反哺（EvolutionVersionService）
 *
 * 依赖：
 * - AiDbModule（ai_db 独立连接 + 4 实体）
 * - ProvidersModule（萃取 LLM 调用）
 *
 * 被 BrainModule 导入（Orchestrator/LearningService 采集接入），
 * 服务导出供 Gateway 管理 API 注入。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Module } from '@nestjs/common';
import { AiDbModule } from '../database/ai-db.module';
import { ProvidersModule } from '../providers/providers.module';
import { CaptureService } from './capture.service';
import { AggregatorService } from './aggregator.service';
import { ExperienceExtractorService } from './experience-extractor.service';
import { EvolutionVersionService } from './evolution-version.service';

@Module({
  imports: [AiDbModule, ProvidersModule],
  providers: [
    CaptureService,
    AggregatorService,
    ExperienceExtractorService,
    EvolutionVersionService,
  ],
  exports: [
    CaptureService,
    AggregatorService,
    ExperienceExtractorService,
    EvolutionVersionService,
  ],
})
export class EvolutionModule {}
