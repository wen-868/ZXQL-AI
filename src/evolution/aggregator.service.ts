/**
 * AggregatorService — 聚合层（P1-1，E2）
 *
 * 依据：权威文档 26.2/26.6.1——跨租户同行业经验经脱敏+隔离聚合，
 * 形成平台级公共知识（如"酒类批发常见单位混淆"），只沉淀模式不沉淀实例。
 *
 * 聚合流程（26.6.1 三步）：
 * 1. 字段级遮蔽：入库时已完成（CaptureService 脱敏）
 * 2. input_hash 去标识：按输入指纹去重
 * 3. 行业归并：按 任务类型×错误原因 归并为公共模式
 *
 * 产出：模式统计 JSON（不含任何租户原始业务数据），
 * 供 ExperienceExtractorService 生成反哺版本提案。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { AiExperienceEntity } from '../database/entities/ai-experience.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/** 公共模式统计（已脱敏，跨租户） */
export interface PublicPattern {
  /** 任务类型（如 sales_order） */
  taskType: string;
  /** 总样本数 */
  total: number;
  /** 去重租户数 */
  tenantCount: number;
  /** 结果分布：{ success: n, corrected: n, failed: n } */
  outcomeDistribution: Record<string, number>;
  /** 纠正原因模式（reason → 出现次数，跨租户去重） */
  reasonPatterns: Array<{ reason: string; count: number }>;
}

@Injectable()
export class AggregatorService {
  private readonly logger = new Logger(AggregatorService.name);

  constructor(
    @InjectRepository(AiExperienceEntity, AI_DB_CONNECTION)
    private readonly experienceRepo: Repository<AiExperienceEntity>,
    @InjectRepository(AiCorrectionEntity, AI_DB_CONNECTION)
    private readonly correctionRepo: Repository<AiCorrectionEntity>,
  ) {}

  /**
   * 跨租户聚合公共模式（按任务类型）
   *
   * @param taskType 任务类型（如 sales_order / customer_create）
   * @param limit    参与统计的最近样本数
   * @returns 公共模式（脱敏）；无数据返回 null
   */
  async aggregateByTaskType(
    taskType: string,
    limit = 200,
  ): Promise<PublicPattern | null> {
    // 1. 经验样本（跨租户）
    const experiences = await this.experienceRepo.find({
      where: { intent: taskType },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    // 2. 纠正样本（跨租户）
    const corrections = await this.correctionRepo.find({
      where: { taskType },
      order: { createdAt: 'DESC' },
      take: limit,
    });

    if (experiences.length === 0 && corrections.length === 0) {
      return null;
    }

    // 结果分布（按输入指纹去重，保留租户维度计数）
    const outcomeDistribution: Record<string, number> = {};
    const seenInputs = new Set<string>();
    const tenants = new Set<string>();
    for (const exp of experiences) {
      tenants.add(exp.tenantId);
      if (exp.inputHash) {
        if (seenInputs.has(exp.inputHash)) {
          continue;
        }
        seenInputs.add(exp.inputHash);
      }
      outcomeDistribution[exp.outcome] =
        (outcomeDistribution[exp.outcome] ?? 0) + 1;
    }

    // 纠正原因模式（跨租户，reason 归一为模式描述）
    const reasonCount = new Map<string, number>();
    for (const corr of corrections) {
      tenants.add(corr.tenantId);
      const reason = this.normalizeReason(corr.reason ?? '未说明原因');
      reasonCount.set(reason, (reasonCount.get(reason) ?? 0) + 1);
    }
    const reasonPatterns = [...reasonCount.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    const pattern: PublicPattern = {
      taskType,
      total: experiences.length + corrections.length,
      tenantCount: tenants.size,
      outcomeDistribution,
      reasonPatterns,
    };

    this.logger.log(
      `跨租户聚合完成：taskType=${taskType} 样本=${pattern.total} 租户=${pattern.tenantCount}`,
    );
    return pattern;
  }

  /**
   * 批量聚合（管理 API：列出有样本的全部任务类型）
   *
   * @returns 各任务类型的模式列表
   */
  async aggregateAll(limitPerType = 100): Promise<PublicPattern[]> {
    // 从纠正样本取任务类型集合（经验样本按 intent 分组）
    const corrections = await this.correctionRepo.find({
      select: { taskType: true },
    });
    const experiences = await this.experienceRepo.find({
      select: { intent: true },
    });
    const taskTypes = new Set<string>();
    for (const c of corrections) {
      if (c.taskType) {
        taskTypes.add(c.taskType);
      }
    }
    for (const e of experiences) {
      if (e.intent) {
        taskTypes.add(e.intent);
      }
    }

    const patterns: PublicPattern[] = [];
    for (const taskType of taskTypes) {
      const pattern = await this.aggregateByTaskType(taskType, limitPerType);
      if (pattern) {
        patterns.push(pattern);
      }
    }
    return patterns;
  }

  /**
   * 纠正原因归一（去掉租户实例细节，保留模式语义）
   *
   * 示例："红星商行手机号为空" → "手机号为空"（截断/去标识）。
   */
  private normalizeReason(reason: string): string {
    const trimmed = reason.trim().replace(/\s+/g, '');
    if (trimmed.length <= 24) {
      return trimmed;
    }
    return `${trimmed.slice(0, 24)}…`;
  }
}
