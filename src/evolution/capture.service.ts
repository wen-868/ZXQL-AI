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
  ) {}

  /**
   * 任务结束采集（E1）
   *
   * 落库：ai_experience（1 条）+ ai_sample（成功/纠正时 1 条脱敏输入输出对）。
   * 全部 best-effort：ai_db 不可用仅记日志，不阻塞主流程。
   */
  async captureTask(input: CaptureTaskInput): Promise<void> {
    try {
      const inputHash = input.userMessage ? hashInput(input.userMessage) : null;

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
            quality: input.outcome === 'success' ? 3 : 4,
            usedForTraining: 0,
          }),
        );
      }

      this.logger.debug(
        `任务采集落库：tenant=${input.tenantId} domain=${input.domain} intent=${input.intent ?? '-'} outcome=${input.outcome}`,
      );
    } catch (err) {
      this.logger.warn(
        `任务采集失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 用户纠正采集（E1）——校准金标准
   *
   * 落库：ai_correction（wrong/right 均脱敏）。
   */
  async captureCorrection(input: CaptureCorrectionInput): Promise<void> {
    try {
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
      this.logger.log(
        `纠正样本采集：tenant=${input.tenantId} taskType=${input.taskType}`,
      );
    } catch (err) {
      this.logger.warn(
        `纠正采集失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
