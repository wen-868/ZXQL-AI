/**
 * TelemetryPipelineService — 三通道审计/会话/用量/计费统一遥测管线
 * （AI-P2-4-TELEMETRY-PIPELINE-01，消除 D4/D5/D12）
 *
 * 统一契约：
 * 1. channelBegin/channelEnd 单一生命周期：三通道共用同一 begin/end 语义，
 *    lane 只允许 chat | agent | graph；
 * 2. sessionId 修正：resolveSessionId(preferred, fallback) = preferred ?? fallback，
 *    结果绝不为空、且**绝不把 tenantId 当会话 ID**（旧 agent 行为的反向防护）；
 * 3. usage 真实性：usageSource='measured' 才是真实计量；'unknown' 表示来源未知
 *    ——按 0 记账但在审计 tool_calls JSON 中落 {event:'usage_unknown'} 标记，
 *    不把"未知"伪装成真实 0（graph done usage 修正，D12）；
 * 4. 计费/用量单点：t_ai_usage_daily 由 AuditLogger.logAiCall 内的单条 UPSERT 写入
 *    （唯一写入口），计费只经 BillingService.consume 一个挂点——三通道一致；
 * 5. 失败隔离：channelEnd 内部 bestEffort 语义（审计/计费任一失败只记
 *    logger.error + 指标 + 死信），永不抛出、永不改变主任务结果；
 * 6. 字段口径统一：tenant/user/session/provider/model/channel（=lane）+ usage；
 *    日志不含凭据、正文或未脱敏敏感数据（正文脱敏由 AuditLogger 既有掩码承担）。
 *
 * 负责人: 阿洲（AI协助）| 创建日期: 2026-11-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditLogger } from '../bridge/audit-logger';
import type { ToolCategory } from '../tools/tool.interface';
import { BillingService } from '../tenant/billing.service';
import { MetricsService } from '../common/metrics.service';
import type { FallbackMeta } from './router/provider-router.service';

/** 执行车道（与审计 lane 同枚举） */
export type TelemetryLane = 'chat' | 'agent' | 'graph';
export const TELEMETRY_LANES: readonly TelemetryLane[] = [
  'chat',
  'agent',
  'graph',
];

/** 用量来源：measured=真实计量；unknown=来源未知（显式 0 + 审计标记） */
export type TelemetryUsageSource = 'measured' | 'unknown';

export interface TelemetryUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  usageSource: TelemetryUsageSource;
}

/** begin 输入（会话上下文归一） */
export interface TelemetryBeginInput {
  lane: TelemetryLane;
  tenantId: string;
  /** 优先会话来源（如 plan 运行上下文的 sessionId / 对话 conversationId） */
  sessionId?: string | null;
  /** 退回会话来源（如 conversationId） */
  fallbackSessionId?: string | null;
  userId?: string;
  userMessage?: string;
  intent?: string;
}

/** begin 产出：归一后的会话句柄（end 必须回传同一句柄） */
export interface TelemetrySession {
  lane: TelemetryLane;
  tenantId: string;
  sessionId: string;
  userId?: string;
  userMessage?: string;
  intent?: string;
  startTime: number;
}

/** end 输入（结果侧字段） */
export interface TelemetryEndInput {
  session: TelemetrySession;
  success: boolean;
  usage: TelemetryUsage;
  provider?: string;
  model?: string;
  employeeUid?: string;
  /** 覆盖 begin 时的 intent（如 agent 计划收尾） */
  intent?: string;
  /** 是否计费（缺省 true；三通道统一挂点） */
  billable?: boolean;
  categories?: ToolCategory[];
  toolCalls?: Array<Record<string, unknown>>;
  /** chat 既有分诊字段（不得减少） */
  triageLane?: string | null;
  triageCategories?: string | null;
  fallback?: FallbackMeta;
  error?: string;
}

/** buildTelemetryEndInput 的通道结果上下文（S3 · 组装单源输入） */
export interface TelemetryEndContext {
  /** begin 产出的会话句柄（原样透传） */
  session: TelemetrySession;
  /** 主任务成功与否 */
  success: boolean;
  /** 三元 token 计量（measured 通道提供真实值；unknown 通道全 0） */
  promptTokens: number;
  completionTokens: number;
  /** 用量来源：measured=真实计量；unknown=来源未知（显式 0+审计标记） */
  usageSource: TelemetryUsageSource;
  /** 通道耗时（ms；channelEnd 内不再二次计时） */
  latencyMs: number;
  /** 是否计费（缺省 true；chat 失败路径保持原口径显式传 false） */
  billable?: boolean;
  error?: string;
}

/**
 * channelEnd 输入组装单源（S3 · 三通道共用）
 *
 * 收敛 chat/agent/graph 各自拼装 TelemetryEndInput（usage 三元组+success+
 * billable+error）的机械重复：usage 三元组装、usageSource 透传、billable
 * 缺省 true（真实计费策略 BILLING-POLICY-20261105 口径）、error 透传。
 *
 * 行为不变判据：产出的 TelemetryEndInput 与三通道原手工组装逐字段等价
 * （S3 mutation 靶点：lane 混淆/usage 伪 0/billable 漂移/审计字段缺失）。
 */
export function buildTelemetryEndInput(
  ctx: TelemetryEndContext,
  overrides: {
    provider?: string;
    model?: string;
    employeeUid?: string;
    intent?: string;
    categories?: ToolCategory[];
    toolCalls?: Array<Record<string, unknown>>;
    triageLane?: string | null;
    triageCategories?: string | null;
    fallback?: FallbackMeta;
  } = {},
): TelemetryEndInput {
  return {
    session: ctx.session,
    success: ctx.success,
    usage: {
      promptTokens: ctx.promptTokens,
      completionTokens: ctx.completionTokens,
      totalTokens: ctx.promptTokens + ctx.completionTokens,
      latencyMs: ctx.latencyMs,
      usageSource: ctx.usageSource,
    },
    billable: ctx.billable ?? true,
    error: ctx.error,
    ...overrides,
  };
}

@Injectable()
export class TelemetryPipelineService {
  private readonly logger = new Logger(TelemetryPipelineService.name);

  constructor(
    private readonly auditLogger: AuditLogger,
    private readonly billing: BillingService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 会话 ID 归一：preferred ?? fallback；结果非空且**绝不等于裸 tenantId**
   * （旧 agent 行为把 tenantId 当 sessionId 的反向防护）；兜底 `${lane}-session-${tenantId}`
   * 保证可按租户+会话聚合且不与租户 ID 混淆。
   */
  resolveSessionId(
    lane: TelemetryLane,
    tenantId: string,
    preferred?: string | null,
    fallback?: string | null,
  ): string {
    const candidate =
      preferred && preferred.trim() !== ''
        ? preferred
        : fallback && fallback.trim() !== ''
          ? fallback
          : `${lane}-session-${tenantId}`;
    if (candidate === tenantId) {
      return `${lane}-session-${tenantId}`;
    }
    return candidate;
  }

  /**
   * 通道生命周期开始：归一会话（lane 校验 fail-fast，sessionId 修正）
   */
  channelBegin(input: TelemetryBeginInput): TelemetrySession {
    if (!TELEMETRY_LANES.includes(input.lane)) {
      throw new Error(
        `非法遥测 lane：${String(input.lane)}（只允许 ${TELEMETRY_LANES.join('/')}）`,
      );
    }
    return {
      lane: input.lane,
      tenantId: input.tenantId,
      sessionId: this.resolveSessionId(
        input.lane,
        input.tenantId,
        input.sessionId,
        input.fallbackSessionId,
      ),
      userId: input.userId,
      userMessage: input.userMessage,
      intent: input.intent,
      startTime: Date.now(),
    };
  }

  /**
   * 通道生命周期结束：审计（含 t_ai_usage_daily 单点 UPSERT）+ 计费单点。
   *
   * 失败隔离：任何遥测/计费失败都不抛出（bestEffort 链路），只落
   * logger.error + 指标 + 死信，主任务结果不受影响。
   */
  async channelEnd(input: TelemetryEndInput): Promise<void> {
    const { session } = input;
    const latencyMs = input.usage.latencyMs ?? Date.now() - session.startTime;
    // usage 真实性：unknown 来源显式标记（审计可辨），不伪装成真实 0
    const toolCalls = [...(input.toolCalls ?? [])];
    if (input.usage.usageSource === 'unknown') {
      toolCalls.push({
        event: 'usage_unknown',
        lane: session.lane,
        note: '用量来源未知，按 0 记账（非真实计量值）',
      });
    }
    try {
      this.auditLogger.logAiCall({
        tenantId: session.tenantId,
        userId: session.userId,
        sessionId: session.sessionId,
        employeeUid: input.employeeUid,
        provider: input.provider,
        model: input.model,
        intent: input.intent ?? session.intent ?? session.lane,
        lane: session.lane,
        categories: input.categories,
        userMessage: session.userMessage,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        latencyMs,
        success: input.success,
        triageLane: input.triageLane ?? undefined,
        triageCategories: input.triageCategories ?? undefined,
        fallback: input.fallback,
        errorMessage: input.error,
      });
    } catch (err) {
      // 审计同步段异常（fire-and-forget 内部已 bestEffort，此处兜底隔离）
      this.logger.error(
        `遥测审计失败（已隔离，不影响主任务）：lane=${session.lane} tenant=${session.tenantId} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 计费单点（三通道统一；失败不阻断主任务，但必须可观测）
    if (input.billable !== false) {
      try {
        await this.billing.consume(session.tenantId, input.usage.totalTokens);
      } catch (err) {
        this.logger.error(
          `遥测计费失败（已隔离，可据死信补扣）：lane=${session.lane} tenant=${session.tenantId} tokens=${input.usage.totalTokens} err=${err instanceof Error ? err.message : String(err)}`,
        );
        this.metrics.recordBillingConsume('fail');
      }
    }
  }
}
