/**
 * LearningService — 自主学习（完善度 P2 认知层 LN）
 *
 * 职责：
 * 1. 反馈信号吸收：任务成功/失败/审核驳回 → 经验结构化（Experience）
 * 2. 经验回流：写情节经验（episodic）+ 回流提示（profile：tool_select/routing）
 * 3. 采纳评估：应用记录入 ai_learning_log（positive/negative）
 * 4. 隔离：全部按 tenantId；不跨租户
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P2 自主学习 LN
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiLearningLogEntity } from '../../database/entities/ai-learning-log.entity';
import { LongTermMemoryService } from '../memory/long-term-memory.service';

/** 反馈信号（对话/图执行结束后由调用方提供） */
export interface FeedbackSignal {
  /** 任务/意图名 */
  taskName: string;
  /** 全部工具是否成功 */
  success: boolean;
  /** 失败信息（失败时） */
  error?: string;
  /** 涉及的工具名（可选） */
  tool?: string;
  /** 审核结论（approved/rejected/undefined） */
  reviewStatus?: 'approved' | 'rejected';
}

/** 回流提示（工具选择/路由优化） */
export interface LearningHints {
  toolSelect: Array<{ tool: string; note: string }>;
  routing: Array<{ key: string; note: string }>;
}

@Injectable()
export class LearningService {
  private readonly logger = new Logger(LearningService.name);

  constructor(
    private readonly ltm: LongTermMemoryService,
    @InjectRepository(AiLearningLogEntity)
    private readonly logRepo: Repository<AiLearningLogEntity>,
  ) {}

  /**
   * 吸收反馈信号 → 经验结构化 → 回流（情节 + 提示）
   */
  async absorb(
    tenantId: string,
    signal: FeedbackSignal,
    _userId?: string,
  ): Promise<void> {
    const outcome = signal.success ? 'good' : 'bad';
    const what = signal.success
      ? `任务「${signal.taskName}」执行成功`
      : `任务「${signal.taskName}」执行失败${signal.error ? `：${signal.error}` : ''}`;

    // 1. 情节经验落库
    await this.ltm.saveEpisodic(tenantId, {
      what,
      outcome,
      why: signal.error,
      summary: what.slice(0, 200),
    });

    // 2. 失败/驳回 → 回流提示（tool_select_hint / routing_hint）
    if (!signal.success && signal.tool) {
      await this.ltm.upsertProfile(
        tenantId,
        'tool_select_hint',
        {
          tool: signal.tool,
          note: `该租户「${signal.taskName}」曾失败${signal.error ? `：${signal.error.slice(0, 100)}` : ''}，优先检查前置条件`,
        },
        'hint',
      );
    }
    if (signal.reviewStatus === 'rejected') {
      await this.ltm.upsertProfile(
        tenantId,
        'routing_hint',
        {
          note: `该租户「${signal.taskName}」曾被人工驳回，涉及审核流程需谨慎`,
        },
        'hint',
      );
    }

    this.logger.debug(
      `学习吸收：tenant=${tenantId} task=${signal.taskName} outcome=${outcome}`,
    );
  }

  /**
   * 获取回流提示（ContextBuilder/工具选择优化用）
   */
  async getHints(tenantId: string, userId?: string): Promise<LearningHints> {
    const profiles = await this.ltm.getProfiles(tenantId, userId);
    const hints: LearningHints = { toolSelect: [], routing: [] };
    for (const p of profiles) {
      if (p.k === 'tool_select_hint') {
        const v = p.v as { tool?: string; note?: string };
        if (v.tool) {
          hints.toolSelect.push({ tool: v.tool, note: v.note ?? '' });
        }
      } else if (p.k === 'routing_hint') {
        const v = p.v as { note?: string };
        hints.routing.push({ key: 'review', note: v.note ?? '' });
      }
    }
    return hints;
  }

  /**
   * 对话级经验沉淀：纯咨询对话（无工具调用）也记录情节经验，
   * 让「总结经验」覆盖所有交互，而非仅工具调用轮次。
   *
   * @param tenantId  租户 ID
   * @param userMessage 用户提问
   * @param reply     AI 回复（截断保存）
   */
  async noteConversation(
    tenantId: string,
    userMessage: string,
    reply: string,
  ): Promise<void> {
    const what = `用户咨询「${userMessage.slice(0, 100)}」，助手回复：${reply.slice(0, 150)}`;
    await this.ltm.saveEpisodic(tenantId, {
      what,
      outcome: 'good',
      why: undefined,
      summary: what.slice(0, 200),
    });
    this.logger.debug(
      `对话经验沉淀：tenant=${tenantId} 用户消息=${userMessage.slice(0, 40)}...`,
    );
  }

  /**
   * 记录经验应用 + 采纳评估（positive/negative）
   */
  async recordApplication(
    tenantId: string,
    input: {
      expId?: number;
      hintKey?: string;
      effect: 'positive' | 'negative';
      note?: string;
    },
  ): Promise<void> {
    await this.logRepo.save(
      this.logRepo.create({
        tenantId,
        expId: input.expId ?? null,
        hintKey: input.hintKey ?? null,
        effect: input.effect,
        note: input.note ?? null,
      }),
    );
  }

  /**
   * 学习回流记录（管理接口）
   */
  async listLogs(tenantId: string, limit = 50): Promise<AiLearningLogEntity[]> {
    return this.logRepo.find({
      where: { tenantId },
      order: { appliedAt: 'DESC' },
      take: limit,
    });
  }
}
