/**
 * Capture intent 归一纯函数（AI-P2-4-CAPTURE-INTENT-NORMALIZE-01）
 *
 * 统一 chat / agent / graph 三通道向进化飞轮提交的 capture intent：
 * `ai_sample.taskType` 与 `ai_experience.intent` 使用同一可消费口径，
 * 恢复 E3 few-shot 与 E5 评测的样本闭环。
 *
 * 归一公式：
 *   normalizeCaptureIntent(toolOrIntent, fallback = 'chat')
 *     = docTypeForTool(trimmed) ?? trimmed ?? fallback
 *
 * 口径铁律：
 * 1. 映射命中（docTypeForTool，以 write-schema-registry 为唯一映射真源）⇒
 *    写裸 docType（如 createSalesOrder ⇒ sales_order）；
 * 2. 未映射的工具名**保持原值**，不得擅自折叠成 chat（防样本误归）；
 * 3. 已有非工具意图（office_document / write / analysis / agent_plan / graph 等）
 *    保持原值——它们不在写 Schema 注册表里，规则推导会凭空造出假 docType；
 * 4. 空值/纯空白才回退 fallback（缺省 'chat'）；
 * 5. 原始工具名的审计语义由调用方的 toolCalls/trajectory/遥测审计保留，
 *    归一只作用于 capture 的 intent/taskType 字段。
 *
 * 负责人: 阿洲（AI协助）| 创建日期: 2026-11-06
 */
import { docTypeForTool } from '../brain/extraction/write-schema-registry';

/** 空值回退的缺省意图 */
export const CAPTURE_INTENT_FALLBACK = 'chat';

/**
 * 归一 capture intent / sample taskType（纯函数，三通道共用唯一口径）
 *
 * @param toolOrIntent 工具名或既有意图标签（可空）
 * @param fallback     空值回退（缺省 'chat'）
 * @returns 映射命中 → 裸 docType；未映射 → trim 后原值；空值 → fallback
 */
export function normalizeCaptureIntent(
  toolOrIntent?: string | null,
  fallback: string = CAPTURE_INTENT_FALLBACK,
): string {
  const trimmed = (toolOrIntent ?? '').trim();
  if (trimmed === '') {
    return fallback || CAPTURE_INTENT_FALLBACK;
  }
  return docTypeForTool(trimmed) ?? trimmed;
}

/** buildCaptureTaskInput 的通道上下文输入（AI-P2-4-ORCHESTRATION-CONVERGENCE-IMPLEMENTATION-01 S2） */
export interface CaptureTaskBuildContext {
  /** 租户 ID（必填，透传） */
  tenantId: string;
  /** 意图/工具名（归一口径；空值回退 fallback） */
  intent?: string | null;
  /** 用户目标（样本 prompt 来源） */
  userMessage?: string;
  /** 工具调用轨迹（原始工具名保留） */
  toolCalls?: Array<Record<string, unknown>>;
  /** 结果：success/corrected/failed */
  outcome: 'success' | 'corrected' | 'failed';
  /** 最终回复（样本 completion 来源） */
  reply?: string;
  /** 失败信息 */
  error?: string;
}

/**
 * captureTask 输入组装单源（S2 · 三通道共用）
 *
 * 收敛 chat/agent/graph 三通道各自拼装 CaptureTaskInput 的机械重复：
 * intent 归一 + domain 判定（write=写工具轨迹含成功写调用 / 其余 analysis）
 * + outcome 透传 + 轨迹透传。调用方只提供通道上下文。
 *
 * 行为不变判据：产出的 CaptureTaskInput 与三通道原手工组装逐字段等价
 * （S2 mutation 靶点：未归一/丢 tenantId/graph 丢轨迹/outcome 误记）。
 *
 * @param ctx       通道上下文
 * @param overrides 通道特有覆盖（domain/outcome 等已有判定结果的字段直接透传，
 *                  防止本函数二次推断与通道语义漂移）
 */
export function buildCaptureTaskInput(
  ctx: CaptureTaskBuildContext,
  overrides: {
    domain?: 'analysis' | 'write' | 'push';
    outcome?: 'success' | 'corrected' | 'failed';
    reply?: string;
    adopted?: boolean;
  } = {},
): {
  tenantId: string;
  domain: 'analysis' | 'write' | 'push';
  intent: string;
  userMessage?: string;
  toolCalls?: Array<Record<string, unknown>>;
  outcome: 'success' | 'corrected' | 'failed';
  reply?: string;
  error?: string;
} {
  const failedToolCall = (ctx.toolCalls ?? []).find((t) => t.success === false);
  return {
    tenantId: ctx.tenantId,
    domain: overrides.domain ?? (failedToolCall ? 'write' : 'analysis'),
    intent: normalizeCaptureIntent(ctx.intent),
    userMessage: ctx.userMessage,
    toolCalls: ctx.toolCalls,
    outcome: overrides.outcome ?? ctx.outcome,
    reply: overrides.reply ?? ctx.reply,
    error: ctx.error,
  };
}

/** 域消费者（三通道外：办公/学习）的 capture 上下文输入（AI-P2-5-CAPTURE-CONSUMER-CONVERGENCE-01） */
export interface DomainCaptureTaskBuildContext {
  /** 租户 ID（域消费者必填：缺失/空白 fail-closed，不补默认租户） */
  tenantId?: string | null;
  /** 意图/域任务类型/任务名（归一口径与三通道同一单源；空值回退 fallback） */
  intent?: string | null;
  /** 用户目标（样本 prompt 来源） */
  userMessage?: string;
  /** 工具调用轨迹（原始工具名保留，不得被归一值覆盖） */
  toolCalls?: Array<Record<string, unknown>>;
  /** 结果：success/corrected/failed */
  outcome: 'success' | 'corrected' | 'failed';
  /** 最终回复（样本 completion 来源） */
  reply?: string;
  /** 失败信息 */
  error?: string;
  /** 样本质量覆盖（1-5；办公评分回流） */
  sampleQuality?: number;
  /** 产出是否被采纳（学习域成功信号） */
  adopted?: boolean;
}

/** 域消费者租户缺失（fail-closed 专用错误，调用方不得捕获后降级续采） */
export class CaptureTenantMissingError extends Error {
  constructor(detail?: string) {
    super(
      `capture fail-closed: tenantId 缺失，拒绝采集（不补默认租户）${detail ? '：' + detail : ''}`,
    );
    this.name = 'CaptureTenantMissingError';
  }
}

/**
 * 域消费者（三通道外）captureTask 输入组装单源
 *
 * 收敛 office-evolution / learning 两消费者三调用点的 capture 输入组装：
 * 与三通道共用同一 normalizeCaptureIntent / buildCaptureTaskInput 归一口径，
 * 在此之上增加两条域消费者铁律：
 * 1. tenantId 缺失/纯空白 ⇒ 抛 CaptureTenantMissingError（fail-closed，
 *    不跨租户、不补回退或默认租户）；
 * 2. sampleQuality（办公评分）经 overrides/ctx 透传，不参与归一推断。
 *
 * 语义保留判据：office/learning 的 intent 是域任务类型或任务名（如
 * office_report / 创建销售单），均不在写 Schema 注册表 → 归一后保持原值；
 * 若确为注册表工具名，归一为裸 docType 与落库层二次归一幂等（行为等价）。
 * 原始工具名的审计语义由调用方 trajectory/提示回流保留。
 *
 * @param ctx       域上下文（tenantId 必填，缺失即 fail-closed）
 * @param overrides 域特有覆盖（domain/outcome/reply/adopted/sampleQuality）
 */
export function buildDomainCaptureTaskInput(
  ctx: DomainCaptureTaskBuildContext,
  overrides: {
    domain?: 'analysis' | 'write' | 'push';
    outcome?: 'success' | 'corrected' | 'failed';
    reply?: string;
    adopted?: boolean;
    sampleQuality?: number;
  } = {},
): {
  tenantId: string;
  domain: 'analysis' | 'write' | 'push';
  intent: string;
  userMessage?: string;
  toolCalls?: Array<Record<string, unknown>>;
  outcome: 'success' | 'corrected' | 'failed';
  reply?: string;
  error?: string;
  sampleQuality?: number;
  adopted?: boolean;
} {
  const tenantId = (ctx.tenantId ?? '').trim();
  if (!tenantId) {
    throw new CaptureTenantMissingError(
      `intent=${normalizeCaptureIntent(ctx.intent)}`,
    );
  }
  const input = buildCaptureTaskInput({ ...ctx, tenantId }, overrides);
  const sampleQuality = overrides.sampleQuality ?? ctx.sampleQuality;
  // adopted 是 ctx 透传字段（学习域成功信号 adopted=true），三通道 builder
  // 返回形状不含它——在此补回，保持与手工组装逐字段等价（不丢采纳标记）
  const adopted = overrides.adopted ?? ctx.adopted;
  return {
    ...input,
    ...(sampleQuality !== undefined ? { sampleQuality } : {}),
    ...(adopted !== undefined ? { adopted } : {}),
  };
}
