/**
 * ExperienceExtractorService — 萃取层（P1-1，E2）
 *
 * 依据：权威文档 26.2——经验抽取器从审计日志+纠正中归纳
 * "为什么错、正确做法是什么"，生成可复用经验。
 *
 * 流程：
 * 1. 取未反哺的纠正样本（ai_correction，appliedToVersion=null）
 * 2. LLM 归纳共性错误 → 生成反哺版本提案（staged，trigger=auto_learn）
 * 3. 标记纠正样本 appliedToVersion（防重复萃取）
 *
 * LLM 不可用时降级：直接按纠正 reason 生成保守提案（不误伤红线）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';
import { ProviderFactory } from '../providers/provider-factory';
import { EvolutionVersionService } from './evolution-version.service';

/** 萃取结果 */
export interface ExtractResult {
  /** 参与萃取的纠正样本数 */
  analyzed: number;
  /** 生成的版本提案数 */
  staged: number;
  /** 每条萃取的摘要 */
  insights: Array<{
    artifact: string;
    fromVersion: string | null;
    toVersion: string;
    changeSummary: string;
  }>;
  /** 降级原因（LLM 不可用时） */
  degraded?: string;
}

@Injectable()
export class ExperienceExtractorService {
  private readonly logger = new Logger(ExperienceExtractorService.name);

  constructor(
    @InjectRepository(AiCorrectionEntity, AI_DB_CONNECTION)
    private readonly correctionRepo: Repository<AiCorrectionEntity>,
    private readonly factory: ProviderFactory,
    private readonly versions: EvolutionVersionService,
  ) {}

  /**
   * 萃取未反哺的纠正样本 → staged 版本提案
   *
   * @param taskType 可选：只萃取指定任务类型
   * @param limit    最多处理条数
   */
  async extract(taskType?: string, limit = 20): Promise<ExtractResult> {
    const where: {
      appliedToVersion: ReturnType<typeof IsNull>;
      taskType?: string;
    } = { appliedToVersion: IsNull() };
    if (taskType) {
      where.taskType = taskType;
    }
    const corrections = await this.correctionRepo.find({
      where,
      order: { createdAt: 'ASC' },
      take: limit,
    });

    if (corrections.length === 0) {
      return { analyzed: 0, staged: 0, insights: [] };
    }

    // 按任务类型分组
    const byType = new Map<string, AiCorrectionEntity[]>();
    for (const c of corrections) {
      const list = byType.get(c.taskType) ?? [];
      list.push(c);
      byType.set(c.taskType, list);
    }

    const insights: ExtractResult['insights'] = [];
    let staged = 0;
    let degraded: string | undefined;

    for (const [type, group] of byType) {
      try {
        const summary = await this.summarize(type, group);
        const toVersion = `v${Date.now().toString(36)}`;
        await this.versions.stage({
          artifact: this.artifactFor(type),
          toVersion,
          changeSummary: summary,
          trigger: 'auto_learn',
        });
        insights.push({
          artifact: this.artifactFor(type),
          fromVersion: null,
          toVersion,
          changeSummary: summary,
        });
        staged++;

        // 标记已反哺
        for (const c of group) {
          c.appliedToVersion = toVersion;
        }
        await this.correctionRepo.save(group);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `萃取任务类型失败（降级为保守提案）：type=${type} err=${msg}`,
        );
        degraded = msg;
        // 降级：直接按 reason 统计生成保守提案，不调用 LLM
        const conservative = this.conservativeSummary(group);
        await this.versions.stage({
          artifact: this.artifactFor(type),
          toVersion: `v${Date.now().toString(36)}`,
          changeSummary: conservative,
          trigger: 'auto_learn',
        });
        staged++;
      }
    }

    this.logger.log(
      `经验萃取完成：纠正=${corrections.length} 提案=${staged}${degraded ? `（含降级：${degraded}）` : ''}`,
    );
    return { analyzed: corrections.length, staged, insights, degraded };
  }

  /** 制品标识：write_schema.{taskType} */
  private artifactFor(taskType: string): string {
    return `write_schema.${taskType}`;
  }

  /**
   * LLM 归纳"为什么错、正确做法"
   */
  private async summarize(
    taskType: string,
    group: AiCorrectionEntity[],
  ): Promise<string> {
    const samples = group
      .slice(0, 10)
      .map(
        (c, i) =>
          `#${i + 1} 原产出=${JSON.stringify(c.wrongPayload ?? {})} 正确=${JSON.stringify(c.rightPayload ?? {})} 原因=${c.reason ?? ''}`,
      )
      .join('\n');

    const provider = this.factory.getDefault();
    const result = await provider.chatSync(
      [
        {
          role: 'system',
          content:
            '你是 AI 底座的经验萃取器。根据纠正样本归纳任务「' +
            taskType +
            '」的共性错误模式与正确做法。' +
            '输出 JSON：{"pattern":"共性错误模式","fix":"正确做法","changeSummary":"给版本提案的变更摘要（为什么改、改了什么）"}。' +
            '只输出 JSON，不要其他文字。样本已脱敏，不要复述客户/商品名。',
        },
        { role: 'user', content: samples },
      ],
      { temperature: 0, max_tokens: 800 },
    );

    const text = result.content?.trim() ?? '';
    const parsed = this.parseJson(text);
    if (!parsed || typeof parsed.changeSummary !== 'string') {
      throw new Error('萃取 LLM 输出格式不合法');
    }
    return parsed.changeSummary.slice(0, 1000);
  }

  /** 降级保守摘要：按 reason 计数，不调用 LLM */
  private conservativeSummary(group: AiCorrectionEntity[]): string {
    const count = new Map<string, number>();
    for (const c of group) {
      const r = (c.reason ?? '未说明').trim().slice(0, 50);
      count.set(r, (count.get(r) ?? 0) + 1);
    }
    const top = [...count.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r}（${n}次）`)
      .join('；');
    return `自动萃取（保守）：纠正样本 ${group.length} 条，高频原因：${top || '无'}。建议人工复核后校准对应 Schema。`;
  }

  private parseJson(text: string): Record<string, unknown> | null {
    let t = text.trim();
    if (t.startsWith('```')) {
      const nl = t.indexOf('\n');
      if (nl >= 0) {
        t = t.slice(nl + 1);
      }
      if (t.endsWith('```')) {
        t = t.slice(0, -3);
      }
      t = t.trim();
    }
    try {
      const value = JSON.parse(t) as unknown;
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}
