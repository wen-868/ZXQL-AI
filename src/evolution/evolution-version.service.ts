/**
 * EvolutionVersionService — 反哺层版本化（P1-1，E3）+ E5 自治闭环
 *
 * 依据：权威文档 26.2/26.4/26.6——Schema/模板/话术校准版本化、
 * 可回滚、不静默改红线（人工确认 staged→active）。
 *
 * 反哺落地机制（文档 26.2）：
 * - 内容本体存于代码常量（如 write-schema-registry.ts）；
 * - ai_evolution_version 仅记录 artifact + from/to 版本号 + 变更摘要，
 *   作为可回滚的版本指针；
 * - 自动学习生成的版本默认 staged，人工确认后才 active（不静默改红线）；
 * - 回滚按版本号定位代码常量还原（DB 不重复存放大段内容）。
 *
 * E5 自治闭环（2026-09-05 工作文件核查补完，文档 26 章 E5）：
 * - 真实评测：用例逐条走 StructuredExtractor，与 groundTruth 逐字段比对
 *   （替换原 Math.random 模拟）；
 * - 达标线（文档 26 章）：新版本准确率 ≥ 上一 active 版本最近一次评测值的
 *   95%，且不引入新必填缺失；无基线不可判 → 保持 staged；
 * - 策略门控：总台配置 evolution_auto_activate（默认 0=人工放行）；
 *   显式开启后达标自动激活、未达标自动拦截（staged 废弃/active 回滚）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-09-05 E5 真评测+自治闭环
 */
import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, Repository } from 'typeorm';
import { AiEvolutionVersionEntity } from '../database/entities/ai-evolution-version.entity';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/** 版本触发方式 */
export type EvolutionTrigger = 'auto_learn' | 'manual';
/** 版本状态 */
export type EvolutionVersionStatus = 'staged' | 'active' | 'rolled_back';

/** 版本提案输入 */
export interface StageVersionInput {
  /** 制品（如 write_schema.customer_create） */
  artifact: string;
  /** 变更前版本 */
  fromVersion?: string;
  /** 变更后版本 */
  toVersion: string;
  /** 变更摘要 */
  changeSummary?: string;
  /** 触发方式 */
  trigger?: EvolutionTrigger;
}

/** E5 评测用例（prompt=用户话术，completion=标准参数 JSON） */
export interface E5EvalCase {
  prompt: string;
  completion: string;
}

/** E5 抽取执行器签名（网关层注入 StructuredExtractor，避免 Evolution↔Brain 模块循环依赖） */
export type E5ExtractFn = (
  docType: string,
  utterance: string,
) => Promise<{
  success: boolean;
  matched: boolean;
  data: Record<string, unknown>;
  valid: boolean;
  issues: Array<{ reason: string }>;
} | null>;

/** E5 回归评测报告 */
export interface E5RegressionReport {
  versionId: number;
  artifact: string;
  newVersion: string;
  /** 基线准确率（上一 active 版本最近一次评测值；null=无基线不可判） */
  baselineAccuracy: number | null;
  /** 新版本评测准确率（0-1） */
  newAccuracy: number;
  /** 评测用例数 */
  caseCount: number;
  /** 达标：newAccuracy ≥ 95% × baseline（权威文档 26 章回归达标线） */
  meetsE5Standard: boolean;
  recommendation: 'keep' | 'rollback' | 'staged_further';
  details: Array<{ promptTail: string; correct: boolean; note?: string }>;
}

/** E5 自动闭包结果 */
export interface E5AutoCloseResult extends E5RegressionReport {
  /** 策略：auto=总台已开启自治；manual=默认人工放行 */
  policy: 'auto' | 'manual';
  action:
    | 'auto_activated'
    | 'auto_rolled_back'
    | 'kept_staged'
    | 'none_manual_review';
  message: string;
}

/** 自动闭包依赖 */
export interface E5AutoCloseDeps {
  /** 抽取执行器 */
  extract: E5ExtractFn;
  /** 显式评测用例（缺省自动从 ai_db 样本池拉取 taskType=artifact 且 quality≥3 的最新 20 条） */
  cases?: E5EvalCase[];
  /** 操作人（自动闭包默认 e5-auto） */
  actor?: string;
}

@Injectable()
export class EvolutionVersionService {
  private readonly logger = new Logger(EvolutionVersionService.name);

  constructor(
    @InjectRepository(AiEvolutionVersionEntity, AI_DB_CONNECTION)
    private readonly repo: Repository<AiEvolutionVersionEntity>,
    @InjectRepository(AiSampleEntity, AI_DB_CONNECTION)
    private readonly sampleRepo: Repository<AiSampleEntity>,
    @InjectRepository(PlatformAiConfigEntity)
    private readonly platformRepo: Repository<PlatformAiConfigEntity>,
  ) {}

  /**
   * 生成 staged 版本提案（自动学习产物，待人工确认）
   */
  async stage(input: StageVersionInput): Promise<AiEvolutionVersionEntity> {
    const entity = this.repo.create({
      artifact: input.artifact,
      fromVersion: input.fromVersion ?? null,
      toVersion: input.toVersion,
      changeSummary: input.changeSummary ?? null,
      trigger: input.trigger ?? 'auto_learn',
      status: 'staged',
      approvedBy: null,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `版本提案已生成（staged）：artifact=${input.artifact} ${input.fromVersion ?? '-'}→${input.toVersion}`,
    );
    return saved;
  }

  /**
   * 人工确认激活：staged → active
   */
  async activate(
    id: number,
    approver: string,
  ): Promise<AiEvolutionVersionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['staged']);
    entity.status = 'active';
    entity.approvedBy = approver;
    await this.repo.save(entity);
    this.logger.log(
      `版本已激活：id=${id} artifact=${entity.artifact} approver=${approver}`,
    );
    return entity;
  }

  /**
   * 回滚：active → rolled_back（按版本指针还原代码常量，发布流程落盘）
   */
  async rollback(
    id: number,
    reviewer: string,
  ): Promise<AiEvolutionVersionEntity> {
    const entity = await this.getOrThrow(id);
    this.assertStatus(entity, ['active']);
    entity.status = 'rolled_back';
    entity.approvedBy = reviewer;
    await this.repo.save(entity);
    this.logger.warn(
      `版本已回滚：id=${id} artifact=${entity.artifact} 还原至 ${entity.fromVersion ?? '上一版本'}`,
    );
    return entity;
  }

  /**
   * 版本列表（按制品/状态过滤）
   */
  async list(
    artifact?: string,
    status?: string,
  ): Promise<AiEvolutionVersionEntity[]> {
    const qb = this.repo.createQueryBuilder('v').orderBy('v.id', 'DESC');
    if (artifact) {
      qb.where('v.artifact = :artifact', { artifact });
    }
    if (status) {
      qb.andWhere('v.status = :status', { status });
    }
    return qb.getMany();
  }

  /**
   * 当前 active 版本号（供回滚定位/展示）
   */
  async currentVersion(artifact: string): Promise<string | null> {
    const active = await this.repo.findOne({
      where: { artifact, status: 'active' },
      order: { id: 'DESC' },
    });
    return active?.toVersion ?? null;
  }

  /**
   * E5 回归评测（按版本 ID）——真实抽取评测 + 结果落库
   *
   * 流程：
   * 1. 用例：显式传入优先；缺省自动从 ai_db 样本池拉取（taskType=artifact、
   *    quality≥3、最新 20 条）
   * 2. 基线：上一 active 版本最近一次评测准确率（regression_accuracy 列，
   *    迁移 007）；无 active 或无历史评测值 → 无基线
   * 3. 逐用例走注入的抽取执行器，与 groundTruth（completion JSON）逐字段比对，
   *    全字段命中记通过；newAccuracy = 通过用例 / 总用例
   * 4. 达标线（权威文档 26 章）：newAccuracy ≥ 95% × baseline；无基线不可判
   * 5. 结论：达标 → keep；无基线或 ≥90%×baseline → staged_further；
   *    <90%×baseline → rollback（拦截）
   * 6. 评测结果写回版本行（regression_accuracy / regression_evaluated_at）
   */
  async evaluateRegressionById(
    versionId: number,
    deps: { extract: E5ExtractFn; cases?: E5EvalCase[] },
  ): Promise<E5RegressionReport> {
    const entity = await this.getOrThrow(versionId);
    const artifact = entity.artifact;

    // 1. 评测用例
    let cases: E5EvalCase[] = deps.cases ?? [];
    if (cases.length === 0) {
      const samples = await this.sampleRepo.find({
        where: { taskType: artifact, quality: MoreThanOrEqual(3) },
        order: { createdAt: 'DESC' },
        take: 20,
      });
      cases = samples.map((s) => ({
        prompt: s.prompt ?? '',
        completion: s.completion ?? '',
      }));
    }

    if (cases.length === 0) {
      this.logger.warn(
        `E5 回归评测跳过：artifact=${artifact} 无可用样本（显式用例为空且 ai_db 无 quality≥3 样本）`,
      );
      return {
        versionId,
        artifact,
        newVersion: entity.toVersion,
        baselineAccuracy: null,
        newAccuracy: 0,
        caseCount: 0,
        meetsE5Standard: false,
        recommendation: 'staged_further',
        details: [
          {
            promptTail: '（无评测样本）',
            correct: false,
            note: '无可用评测样本',
          },
        ],
      };
    }

    // 2. 基线（上一 active 版本最近一次评测值）
    const active = await this.repo.findOne({
      where: { artifact, status: 'active' },
      order: { id: 'DESC' },
    });
    const baselineAccuracy =
      active?.regressionAccuracy != null
        ? Number(active.regressionAccuracy)
        : null;

    // 3. 真实抽取评测
    const details: E5RegressionReport['details'] = [];
    let correct = 0;
    for (const c of cases) {
      let expected: Record<string, unknown> | null = null;
      const trimmed = (c.completion ?? '').trim();
      if (trimmed.startsWith('{')) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            expected = parsed as Record<string, unknown>;
          }
        } catch {
          expected = null;
        }
      }

      let ok = false;
      let note: string | undefined;
      let r: Awaited<ReturnType<E5ExtractFn>> = null;
      try {
        r = await deps.extract(artifact, c.prompt);
      } catch (err) {
        note = `抽取器异常：${err instanceof Error ? err.message : String(err)}`;
      }
      if (!r) {
        note = note ?? '抽取器无返回';
      } else if (!r.success || !r.matched) {
        note = '未命中 Schema/非写入意图';
      } else if (expected) {
        const keys = Object.keys(expected);
        const data = r.data ?? {};
        // 两侧同规则 JSON 串化比较（对象/字符串/数字口径一致，避免 [object Object]）
        const fmt = (v: unknown): string => (v == null ? '' : JSON.stringify(v));
        ok =
          keys.length > 0 &&
          keys.every((k) => fmt(data[k]).trim() === fmt(expected[k]).trim());
        if (!ok) note = '字段与标准答案不匹配';
      } else {
        // groundTruth 非 JSON：退化为包含判定（历史样本兜底）
        ok = JSON.stringify(r.data ?? {}).includes(trimmed);
        if (!ok) note = '结果未包含标准答案';
      }
      if (ok) correct++;
      details.push({ promptTail: c.prompt.slice(-16), correct: ok, note });
    }
    const newAccuracy = correct / cases.length;

    // 4/5. 达标线与结论（权威文档 26 章：≥95%×baseline 且无基线不可判）
    const meetsE5Standard =
      baselineAccuracy != null && newAccuracy >= 0.95 * baselineAccuracy;
    const recommendation: E5RegressionReport['recommendation'] = meetsE5Standard
      ? 'keep'
      : baselineAccuracy == null || newAccuracy >= 0.9 * baselineAccuracy
        ? 'staged_further'
        : 'rollback';

    // 6. 结果落库（迁移 007 列）
    entity.regressionAccuracy = newAccuracy;
    entity.regressionEvaluatedAt = new Date();
    await this.repo.save(entity);

    this.logger.log(
      `E5 回归评测：id=${versionId} artifact=${artifact} baseline=${
        baselineAccuracy == null ? '无' : baselineAccuracy.toFixed(2)
      } new=${newAccuracy.toFixed(2)} (${correct}/${cases.length}) recommendation=${recommendation}`,
    );

    return {
      versionId,
      artifact,
      newVersion: entity.toVersion,
      baselineAccuracy,
      newAccuracy,
      caseCount: cases.length,
      meetsE5Standard,
      recommendation,
      details,
    };
  }

  /**
   * E5 自动闭环——评测 + 按总台策略自动激活/拦截
   *
   * 策略（t_platform_ai_config.evolution_auto_activate，迁移 007）：
   * - 0（默认，人工放行）：只评测并返回建议，激活/回滚由人工在总台操作；
   * - 1（自治）：达标自动激活（staged→active）；未达标自动拦截
   *   （staged 直接废弃为 rolled_back / active 走回滚）；不足以判定保持 staged。
   */
  async runAutoClosure(
    versionId: number,
    deps: E5AutoCloseDeps,
  ): Promise<E5AutoCloseResult> {
    const report = await this.evaluateRegressionById(versionId, deps);
    const entity = await this.getOrThrow(versionId);
    const actor = deps.actor ?? 'e5-auto';

    const cfg = await this.platformRepo.findOne({ where: { id: 1 } });
    const policyOn = cfg?.evolutionAutoActivate === 1;

    let action: E5AutoCloseResult['action'] = 'none_manual_review';
    let message = '策略=人工放行：评测完成，请在总台确认激活或回滚';

    if (policyOn) {
      const pct = `${(report.newAccuracy * 100).toFixed(1)}%`;
      if (report.recommendation === 'keep') {
        await this.activate(versionId, actor);
        action = 'auto_activated';
        message = `回归达标（${pct}），已按 E5 策略自动激活`;
      } else if (report.recommendation === 'rollback') {
        if (entity.status === 'staged') {
          // staged 从未生效：达标线拦截 = 废弃该提案（不占用版本指针）
          entity.status = 'rolled_back';
          entity.approvedBy = actor;
          await this.repo.save(entity);
          this.logger.warn(
            `E5 自动拦截：staged 提案未达标废弃 id=${versionId} artifact=${entity.artifact}`,
          );
        } else {
          await this.rollback(versionId, actor);
        }
        action = 'auto_rolled_back';
        message = `回归未达标（${pct}），已按 E5 策略自动拦截/回滚`;
      } else {
        action = 'kept_staged';
        message = '回归结果不足以判定，保持 staged 继续观察';
      }
    }

    return {
      policy: policyOn ? 'auto' : 'manual',
      action,
      message,
      ...report,
    };
  }

  private async getOrThrow(id: number): Promise<AiEvolutionVersionEntity> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`进化版本不存在：id=${id}`);
    }
    return entity;
  }

  private assertStatus(
    entity: AiEvolutionVersionEntity,
    allowed: string[],
  ): void {
    if (!allowed.includes(entity.status)) {
      throw new ConflictException(
        `版本状态为 ${entity.status}，仅 ${allowed.join('/')} 可操作`,
      );
    }
  }
}
