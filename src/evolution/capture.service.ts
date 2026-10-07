/**
 * CaptureService — 采集层（P1-1，E1）
 *
 * 依据：权威文档 26.2 闭环第一步「采集（Capture）」——
 * 每次任务结束落 ai_experience（成功路径）、ai_correction（用户纠正）、
 * ai_sample（脱敏输入输出对）。全部写入经脱敏与租户隔离。
 *
 * 接入点：
 * - Orchestrator 任务结束（done 事件）→ captureTask
 * - LearningService.absorb（反馈信号）→ captureTask（对齐现有认知层）
 * - 人工纠正（审核驳回/管理员提交）→ captureCorrection
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiExperienceEntity } from '../database/entities/ai-experience.entity';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';
import { hashInput, sanitizeJson, toTrajectory } from './sanitize';
import { MetricsService } from '../common/metrics.service';
import { bestEffort } from '../common/error-semantics';

/** 任务采集输入 */
export interface CaptureTaskInput {
  tenantId: string;
  /** 领域：analysis/write/push */
  domain: 'analysis' | 'write' | 'push';
  /** 意图标签（如 sales_order_create） */
  intent?: string;
  /** 用户消息（用于 input_hash 与样本 prompt） */
  userMessage?: string;
  /** 工具调用链路（脱敏后入库） */
  toolCalls?: Array<Record<string, unknown>>;
  /** 结果：success/corrected/failed */
  outcome: 'success' | 'corrected' | 'failed';
  /** 样本质量覆盖（1-5；缺省按 outcome：success=3、corrected=4。办公评分回流用） */
  sampleQuality?: number;
  /** 最终回复（脱敏后作为样本 completion） */
  reply?: string;
  /** 失败信息（可选） */
  error?: string;
  /** 产出是否被采纳 */
  adopted?: boolean;
}

/** 纠正采集输入 */
export interface CaptureCorrectionInput {
  tenantId: string;
  taskType: string;
  wrongPayload?: Record<string, unknown>;
  rightPayload?: Record<string, unknown>;
  reason?: string;
}

@Injectable()
export class CaptureService {
  private readonly logger = new Logger(CaptureService.name);

  constructor(
    @InjectRepository(AiExperienceEntity, AI_DB_CONNECTION)
    private readonly experienceRepo: Repository<AiExperienceEntity>,
    @InjectRepository(AiCorrectionEntity, AI_DB_CONNECTION)
    private readonly correctionRepo: Repository<AiCorrectionEntity>,
    @InjectRepository(AiSampleEntity, AI_DB_CONNECTION)
    private readonly sampleRepo: Repository<AiSampleEntity>,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 任务结束采集（E1）
   *
   * 落库：ai_experience（1 条）+ ai_sample（成功/纠正时 1 条脱敏输入输出对）。
   * 全部 best-effort：ai_db 不可用仅记日志，不阻塞主流程。
   */
  async captureTask(input: CaptureTaskInput): Promise<void> {
    // P1-C 迁移：此前 catch + logger.warn 静默吞掉，样本丢失且无痕，进化飞轮断链
    // 无人知晓。改为 bestEffort：仍不阻断主流程，但失败必落 logger.error + 指标 +
    // 死信，运维可据死信补采。
    await bestEffort(
      async () => {
        const inputHash = input.userMessage
          ? hashInput(input.userMessage)
          : null;

        await this.experienceRepo.save(
          this.experienceRepo.create({
            tenantId: input.tenantId,
            domain: input.domain,
            intent: input.intent ?? null,
            inputHash,
            trajectory: toTrajectory(input.toolCalls),
            outcome: input.outcome,
            adopted: input.adopted === undefined ? null : input.adopted ? 1 : 0,
          }),
        );
        this.metrics.recordDbSample('experience');

        // 样本：成功/纠正路径（失败路径不进样本池）
        if (input.outcome !== 'failed' && (input.userMessage || input.reply)) {
          await this.sampleRepo.save(
            this.sampleRepo.create({
              tenantId: input.tenantId,
              taskType: input.intent ?? input.domain,
              prompt: input.userMessage
                ? String(sanitizeJson(input.userMessage)).slice(0, 2000)
                : null,
              completion: input.reply
                ? String(sanitizeJson(input.reply)).slice(0, 2000)
                : null,
              quality:
                input.sampleQuality ?? (input.outcome === 'success' ? 3 : 4),
              usedForTraining: 0,
            }),
          );
          // P3 修复（2026-10-04）：指标在 save 成功后计——此前 save 前虚计，
          // 落库失败时样本计数虚高
          this.metrics.recordDbSample('sample');
        }

        this.logger.debug(
          `任务采集落库：tenant=${input.tenantId} domain=${input.domain} intent=${input.intent ?? '-'} outcome=${input.outcome}`,
        );
      },
      {
        op: 'capture.captureTask',
        tenantId: input.tenantId,
        detail: `domain=${input.domain} intent=${input.intent ?? '-'} outcome=${input.outcome}`,
      },
    );
  }

  /**
   * 用户纠正采集（E1）——校准金标准
   *
   * 落库：ai_correction（wrong/right 均脱敏）。
   */
  async captureCorrection(input: CaptureCorrectionInput): Promise<void> {
    // P1-C 迁移：纠正样本是校准金标准，丢失即静默劣化；改为 bestEffort 落死信。
    await bestEffort(
      async () => {
        await this.correctionRepo.save(
          this.correctionRepo.create({
            tenantId: input.tenantId,
            taskType: input.taskType,
            wrongPayload: input.wrongPayload
              ? (sanitizeJson(input.wrongPayload) as Record<string, unknown>)
              : null,
            rightPayload: input.rightPayload
              ? (sanitizeJson(input.rightPayload) as Record<string, unknown>)
              : null,
            reason: input.reason ?? null,
            appliedToVersion: null,
          }),
        );
        this.metrics.recordDbSample('correction');
        this.logger.log(
          `纠正样本采集：tenant=${input.tenantId} taskType=${input.taskType}`,
        );
      },
      {
        op: 'capture.captureCorrection',
        tenantId: input.tenantId,
        detail: `taskType=${input.taskType}`,
      },
    );
  }

  // ── 查询（管理 API 用）──

  async listExperiences(
    tenantId?: string,
    limit = 50,
  ): Promise<AiExperienceEntity[]> {
    const where = tenantId ? { tenantId } : {};
    return this.experienceRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async listCorrections(
    tenantId?: string,
    limit = 50,
  ): Promise<AiCorrectionEntity[]> {
    const where = tenantId ? { tenantId } : {};
    return this.correctionRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async listSamples(tenantId?: string, limit = 50): Promise<AiSampleEntity[]> {
    const where = tenantId ? { tenantId } : {};
    return this.sampleRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }
}
