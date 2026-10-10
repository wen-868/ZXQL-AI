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
import { AiConfigService } from '../tenant/ai-config.service';
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
    private readonly aiConfigService: AiConfigService,
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
      // P2 修复（2026-10-04）：stage 与"标记已反哺"拆成独立 try/catch——
      // 此前标记失败会落入 catch 再生成一个保守提案（同 artifact 双 staged），
      // 且纠正样本仍未标记，下轮重复萃取永不收敛
      let version: string;
      try {
        const summary = await this.summarize(type, group);
        version = `v${Date.now().toString(36)}`;
        await this.versions.stage({
          artifact: this.artifactFor(type),
          toVersion: version,
          changeSummary: summary,
          trigger: 'auto_learn',
        });
        insights.push({
          artifact: this.artifactFor(type),
          fromVersion: null,
          toVersion: version,
          changeSummary: summary,
        });
        staged++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `萃取任务类型失败（降级为保守提案）：type=${type} err=${msg}`,
        );
        degraded = msg;
        // 降级：直接按 reason 统计生成保守提案，不调用 LLM
        const conservative = this.conservativeSummary(group);
        version = `v${Date.now().toString(36)}`;
        try {
          await this.versions.stage({
            artifact: this.artifactFor(type),
            toVersion: version,
            changeSummary: conservative,
            trigger: 'auto_learn',
          });
          staged++;
        } catch (stageErr) {
          this.logger.warn(
            `保守提案也失败（跳过该类型，纠正样本留待下轮）：type=${type} err=${
              stageErr instanceof Error ? stageErr.message : String(stageErr)
            }`,
          );
          continue;
        }
      }

      // 标记已反哺（独立失败域：只 warn，不重生成提案）
      try {
        for (const c of group) {
          c.appliedToVersion = version;
        }
        await this.correctionRepo.save(group);
      } catch (err) {
        this.logger.warn(
          `标记已反哺失败（纠正样本可能下轮重复萃取，需按 appliedToVersion 防重）：type=${type} err=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
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

    // R101-AI-19（2026-10-11）：此前走 factory.getDefault()（env 基线实例），
    // 只配 DB 平台配置、env 为空的部署拿不到凭据。改为经 AiConfigService
    // 显式解析后 create(provider, config)，与全仓同源绑定口径一致：
    // 密钥与端点同源（P0-2）由解析层保证，此处**不**读 env 兜底绕过解析。
    // 解析失败（无租户上下文 / 平台未配置）不吞异常：上抛由 extract() 的
    // 既有降级分支兜住（保守提案），与同类 LLM 旁路口径一致。
    const { provider: providerType, config } =
      await this.aiConfigService.getProviderConfig();
    const provider = this.factory.create(providerType, config);
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
