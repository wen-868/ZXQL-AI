/**
 * TaskRunnerService — 长任务执行器（批次2，文档 22.4）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 22.4
 * - 断点续跑：ai_execution_plan 表持久化每步状态，进程重启恢复 pending/running 计划
 * - 人工介入：高风险步骤 suspended，审批后 approveStep/rejectStep 流转
 * - 单步容错：长任务不因单步失败整体中断，记录 failed 继续后续
 * - 写全审核：任何写步骤挂起令牌（WriteGuard），用户 /ai/agent/confirm 确认后继续
 *
 * 步骤状态流转（22.4 六态）：
 *   pending → running → success / failed（自愈不恢复则容错继续） / suspended（写挂起）
 *   suspended → pending（approveStep）→ running；suspended → skipped/failed（rejectStep）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiExecutionPlanEntity } from '../../database/entities/ai-execution-plan.entity';
import { ToolExecutor } from '../../tools/tool-executor';
import { ToolRegistry } from '../../tools/tool-registry';
import { ConfirmationService } from '../confirmation.service';
import { SelfHealLoopService } from './self-heal-loop.service';
import { PlannerService } from './planner.service';
import { CaptureService } from '../../evolution/capture.service';
import { MetricsService } from '../../common/metrics.service';
import { AuditLogger } from '../../bridge/audit-logger';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { WRITE_TOKEN_TTL_MS } from '../write-guard.service';
import type { ToolContext, ToolResult } from '../../tools/tool.interface';
import type { ChatMessage, ToolCall } from '../../providers/provider.interface';
import {
  AgentRunEvent,
  ExecutionPlan,
  PlanRunContext,
  PlanState,
  PlanStep,
} from './agent.types';

/** agent 步骤内最大 ReAct 轮数 */
const MAX_AGENT_STEP_ROUNDS = 6;

/** 创建计划输入 */
export interface CreatePlanInput {
  tenantId: string;
  goal: string;
  steps: PlanStep[];
  createdBy?: string;
}

/** 工具/agent 步骤执行结果 */
interface StepOutcome {
  /** 写步骤挂起（等待确认），当前流应结束 */
  suspended: boolean;
  promptTokens: number;
  completionTokens: number;
}

@Injectable()
export class TaskRunnerService {
  private readonly logger = new Logger(TaskRunnerService.name);

  constructor(
    @InjectRepository(AiExecutionPlanEntity)
    private readonly planRepo: Repository<AiExecutionPlanEntity>,
    private readonly executor: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly confirmationService: ConfirmationService,
    private readonly selfHeal: SelfHealLoopService,
    private readonly planner: PlannerService,
    private readonly capture: CaptureService,
    private readonly metrics: MetricsService,
    private readonly auditLogger: AuditLogger,
    private readonly router: ProviderRouterService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────
  // 计划 CRUD（持久化 ai_execution_plan）
  // ──────────────────────────────────────────────────────────

  /**
   * 创建计划（state=pending）
   */
  async createPlan(input: CreatePlanInput): Promise<ExecutionPlan> {
    const entity = await this.planRepo.save(
      this.planRepo.create({
        tenantId: input.tenantId,
        goal: input.goal,
        steps: JSON.stringify(input.steps),
        state: 'pending',
        createdBy: input.createdBy ?? null,
      }),
    );
    this.logger.log(
      `创建执行计划：id=${entity.id} tenant=${input.tenantId} steps=${input.steps.length} goal="${input.goal.slice(0, 40)}..."`,
    );
    return this.toPlan(entity);
  }

  /**
   * 查询计划（租户隔离）
   */
  async getPlan(id: number, tenantId: string): Promise<ExecutionPlan | null> {
    const entity = await this.planRepo.findOne({
      where: { id, tenantId },
    });
    return entity ? this.toPlan(entity) : null;
  }

  /**
   * 列出租户计划（倒序）
   */
  async listPlans(tenantId: string, limit = 20): Promise<ExecutionPlan[]> {
    const entities = await this.planRepo.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return entities.map((e) => this.toPlan(e));
  }

  /**
   * 保存计划（步骤 JSON + 计划状态）
   */
  async savePlan(plan: ExecutionPlan): Promise<void> {
    const now = new Date();
    plan.updatedAt = now;
    for (const step of plan.steps) {
      step.updatedAt = Date.now();
    }
    await this.planRepo.update(
      { id: plan.id, tenantId: plan.tenantId },
      {
        steps: JSON.stringify(plan.steps),
        state: plan.state,
        updatedAt: now,
      },
    );
  }

  /**
   * 人工介入：审批挂起步骤（suspended → pending，可续跑）
   */
  async approveStep(
    id: number,
    tenantId: string,
    stepId: string,
  ): Promise<{ success: boolean; plan?: ExecutionPlan; error?: string }> {
    const plan = await this.getPlan(id, tenantId);
    if (!plan) {
      return { success: false, error: '计划不存在' };
    }
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      return { success: false, error: '步骤不存在' };
    }
    if (step.status !== 'suspended') {
      return {
        success: false,
        error: `仅 suspended 步骤可审批恢复（当前：${step.status}）`,
      };
    }
    step.status = 'pending';
    step.updatedAt = Date.now();
    plan.state = 'pending';
    await this.savePlan(plan);
    this.logger.log(
      `人工审批通过：plan=${id} step=${stepId} label=${step.label} tenant=${tenantId}`,
    );
    return { success: true, plan };
  }

  /**
   * 人工介入：驳回挂起步骤（suspended → skipped，计划继续）
   */
  async rejectStep(
    id: number,
    tenantId: string,
    stepId: string,
    reason?: string,
  ): Promise<{ success: boolean; plan?: ExecutionPlan; error?: string }> {
    const plan = await this.getPlan(id, tenantId);
    if (!plan) {
      return { success: false, error: '计划不存在' };
    }
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) {
      return { success: false, error: '步骤不存在' };
    }
    if (step.status !== 'suspended') {
      return {
        success: false,
        error: `仅 suspended 步骤可驳回（当前：${step.status}）`,
      };
    }
    step.status = 'skipped';
    step.error = reason ?? '人工驳回';
    step.updatedAt = Date.now();
    plan.state = this.detectFinalState(plan);
    await this.savePlan(plan);
    this.logger.log(
      `人工驳回步骤：plan=${id} step=${stepId} label=${step.label} reason=${reason ?? '-'}`,
    );
    return { success: true, plan };
  }

  /**
   * 取消计划（pending/running/suspended → skipped）
   */
  async cancelPlan(
    id: number,
    tenantId: string,
  ): Promise<{ success: boolean; plan?: ExecutionPlan; error?: string }> {
    const plan = await this.getPlan(id, tenantId);
    if (!plan) {
      return { success: false, error: '计划不存在' };
    }
    if (plan.state === 'success' || plan.state === 'failed') {
      return { success: false, error: `计划已结束（${plan.state}），无法取消` };
    }
    for (const step of plan.steps) {
      if (step.status === 'pending' || step.status === 'running') {
        step.status = 'skipped';
        step.updatedAt = Date.now();
      }
    }
    plan.state = 'skipped';
    await this.savePlan(plan);
    this.logger.log(`取消执行计划：id=${id} tenant=${tenantId}`);
    return { success: true, plan };
  }

  /**
   * WriteGuard 确认后回调：按令牌找到挂起步骤并标记执行结果（确认即断点续跑前提）
   *
   * @param token    WriteGuard token
   * @param tenantId 租户 ID
   * @param result   确认执行结果（写工具返回值）
   * @returns 关联的计划（无则 null）
   */
  async markStepExecutedByToken(
    token: string,
    tenantId: string,
    result: ToolResult,
  ): Promise<ExecutionPlan | null> {
    const plans = await this.listPlans(tenantId, 50);
    for (const plan of plans) {
      const step = plan.steps.find((s) => s.pendingToken === token);
      if (!step) {
        continue;
      }
      if (result.success) {
        step.status = 'success';
        step.result = result.data;
        step.pendingToken = undefined;
        step.error = undefined;
      } else {
        step.status = 'failed';
        step.error = result.error ?? '确认执行失败';
        step.pendingToken = undefined;
      }
      step.updatedAt = Date.now();
      plan.state = this.detectFinalState(plan);
      await this.savePlan(plan);
      this.logger.log(
        `计划步骤确认结果回写：plan=${plan.id} step=${step.id} status=${step.status} token=${token.slice(0, 12)}…`,
      );
      return plan;
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // 执行（SSE 事件流 + 断点续跑）
  // ──────────────────────────────────────────────────────────

  /**
   * 执行/续跑计划（SSE 事件流）
   *
   * 续跑规则（22.4）：仅恢复 pending/running 步骤；suspended 步骤等待人工
   * approveStep（或 WriteGuard confirm）后流转；已 success/skipped 步骤跳过。
   */
  async *run(
    planId: number,
    tenantId: string,
    context: PlanRunContext,
  ): AsyncGenerator<AgentRunEvent> {
    const startTime = Date.now();
    const plan = await this.getPlan(planId, tenantId);
    if (!plan) {
      yield { type: 'error', message: `计划不存在：id=${planId}` };
      return;
    }
    if (
      plan.state === 'success' ||
      plan.state === 'failed' ||
      plan.state === 'skipped'
    ) {
      yield {
        type: 'error',
        message: `计划已结束（${plan.state}），无法再次执行`,
      };
      return;
    }

    // 断点续跑：从首个未决步骤继续
    const resumeFrom = plan.steps.findIndex(
      (s) => s.status === 'pending' || s.status === 'running',
    );
    this.logger.log(
      `执行计划：id=${planId} tenant=${tenantId} state=${plan.state} 续跑起点=${resumeFrom < 0 ? '（无）' : plan.steps[resumeFrom].label}`,
    );
    if (resumeFrom < 0) {
      plan.state = this.detectFinalState(plan);
      await this.savePlan(plan);
      for (const event of this.buildDoneEvent(plan, startTime, 0, 0)) {
        yield event;
      }
      return;
    }

    plan.state = 'running';
    await this.savePlan(plan);
    yield {
      type: 'agent_step',
      planId,
      stepId: 'plan',
      label: '计划启动',
      status: 'running',
      detail: plan.goal,
    };

    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    const toolCalls: Array<Record<string, unknown>> = [];

    for (const step of plan.steps) {
      if (step.status === 'success' || step.status === 'skipped') {
        continue;
      }
      if (step.status === 'suspended') {
        // 人工介入断点：等待确认/审批后续跑
        yield {
          type: 'agent_step',
          planId,
          stepId: step.id,
          label: step.label,
          status: 'suspended',
          detail: step.error ?? '等待人工确认',
        };
        if (step.pendingToken) {
          const expireAt = Date.now() + WRITE_TOKEN_TTL_MS;
          yield {
            type: 'await_confirm',
            token: step.pendingToken,
            expireAt,
          };
        }
        return;
      }

      step.status = 'running';
      step.updatedAt = Date.now();
      await this.savePlan(plan);
      yield {
        type: 'agent_step',
        planId,
        stepId: step.id,
        label: step.label,
        status: 'running',
      };

      try {
        switch (step.type) {
          case 'end': {
            step.status = 'success';
            step.updatedAt = Date.now();
            plan.state = this.detectFinalState(plan);
            await this.savePlan(plan);
            yield {
              type: 'agent_step',
              planId,
              stepId: step.id,
              label: step.label,
              status: 'success',
            };
            for (const event of this.buildDoneEvent(
              plan,
              startTime,
              totalPromptTokens,
              totalCompletionTokens,
            )) {
              yield event;
            }
            return;
          }

          case 'tool': {
            const outcome = await this.drainStep(
              this.runToolStep(plan, step, context, toolCalls),
            );
            for (const event of outcome.events) {
              yield event;
            }
            if (outcome.ret.suspended) {
              return;
            }
            totalPromptTokens += outcome.ret.promptTokens;
            totalCompletionTokens += outcome.ret.completionTokens;
            break;
          }

          case 'agent': {
            const outcome = await this.drainStep(
              this.runAgentStep(plan, step, context, toolCalls),
            );
            for (const event of outcome.events) {
              yield event;
            }
            if (outcome.ret.suspended) {
              return;
            }
            totalPromptTokens += outcome.ret.promptTokens;
            totalCompletionTokens += outcome.ret.completionTokens;
            break;
          }

          case 'condition': {
            step.status = 'success';
            step.updatedAt = Date.now();
            await this.savePlan(plan);
            yield {
              type: 'agent_step',
              planId,
              stepId: step.id,
              label: step.label,
              status: 'success',
            };
            break;
          }

          default:
            step.status = 'failed';
            step.error = `未知步骤类型：${String(step.type)}`;
            step.updatedAt = Date.now();
            await this.savePlan(plan);
        }
      } catch (err) {
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        step.updatedAt = Date.now();
        await this.savePlan(plan);
        yield {
          type: 'agent_step',
          planId,
          stepId: step.id,
          label: step.label,
          status: 'failed',
          detail: step.error,
        };
      }
    }

    // 全部步骤执行完：收尾
    plan.state = this.detectFinalState(plan);
    await this.savePlan(plan);
    for (const event of this.buildDoneEvent(
      plan,
      startTime,
      totalPromptTokens,
      totalCompletionTokens,
    )) {
      yield event;
    }
  }

  // ──────────────────────────────────────────────────────────
  // 步骤执行
  // ──────────────────────────────────────────────────────────

  /**
   * 工具步骤执行：
   * - 无参数时先 LLM 填充（best-effort）
   * - 写步骤返回预览 → 挂起令牌（WriteGuard）→ 返回 suspended=true（流结束等待确认）
   * - 失败 → 自愈回路（重试/澄清/终止），经验回流 ai_db
   */
  private async *runToolStep(
    plan: ExecutionPlan,
    step: PlanStep,
    context: PlanRunContext,
    toolCalls: Array<Record<string, unknown>>,
  ): AsyncGenerator<AgentRunEvent, StepOutcome> {
    if (!step.tool) {
      step.status = 'failed';
      step.error = '工具步骤缺少 tool 名';
      step.updatedAt = Date.now();
      await this.savePlan(plan);
      yield {
        type: 'agent_step',
        planId: plan.id,
        stepId: step.id,
        label: step.label,
        status: 'failed',
        detail: step.error,
      };
      return { suspended: false, promptTokens: 0, completionTokens: 0 };
    }

    // 参数填充（空参数时一次 LLM function calling）
    let args = step.args ?? {};
    if (Object.keys(args).length === 0) {
      args = await this.planner.fillStepArgs(step, plan.goal, {
        tenantId: plan.tenantId,
        goal: plan.goal,
        model: context.model,
        scope: context.scope,
      });
      step.args = args;
    }

    const toolContext = this.toToolContext(context);
    yield {
      type: 'tool_start',
      tool: step.tool,
      args,
    };
    const first = await this.executor.executeToolCall(
      this.toToolCall(step.tool, args),
      toolContext,
    );

    // 写步骤 → 挂起令牌（写全审核）
    const suspend = await this.maybeSuspendWrite(plan, step, first, context);
    for (const event of suspend.events) {
      yield event;
    }
    if (suspend.suspended) {
      return { suspended: true, promptTokens: 0, completionTokens: 0 };
    }

    if (first.success) {
      step.status = 'success';
      step.result = first.data;
      step.error = undefined;
      step.updatedAt = Date.now();
      await this.savePlan(plan);
      yield {
        type: 'tool_result',
        tool: step.tool,
        success: true,
        data: first.data,
      };
      yield {
        type: 'agent_step',
        planId: plan.id,
        stepId: step.id,
        label: step.label,
        status: 'success',
      };
      toolCalls.push({ tool_name: step.tool, success: true });
      return { suspended: false, promptTokens: 0, completionTokens: 0 };
    }

    // 失败 → 自愈回路（重试/澄清/终止），经验回流 ai_db
    yield {
      type: 'tool_result',
      tool: step.tool,
      success: false,
      error: first.error,
    };
    const heal = await this.selfHeal.heal({
      step,
      goal: plan.goal,
      tenantId: plan.tenantId,
      error: first.error ?? '工具执行失败',
      execute: (healArgs) =>
        this.executor.executeToolCall(
          this.toToolCall(step.tool!, healArgs),
          toolContext,
        ),
      capture: (outcome, detail) =>
        this.capture.captureTask({
          tenantId: plan.tenantId,
          domain: 'write',
          intent: step.tool,
          userMessage: plan.goal,
          toolCalls: [{ tool_name: step.tool, success: outcome === 'success' }],
          outcome,
          reply: detail,
          error: outcome === 'failed' ? detail : undefined,
        }),
    });
    step.healLog = heal.healLog ?? [];
    step.retryCount += heal.healLog?.length ?? 0;

    if (heal.ok && heal.result) {
      step.status = 'success';
      step.result = heal.result.data;
      step.error = undefined;
      step.updatedAt = Date.now();
      await this.savePlan(plan);
      yield {
        type: 'tool_result',
        tool: step.tool,
        success: true,
        data: heal.result.data,
      };
      yield {
        type: 'agent_step',
        planId: plan.id,
        stepId: step.id,
        label: step.label,
        status: 'success',
        detail: '自愈恢复',
      };
      toolCalls.push({ tool_name: step.tool, success: true });
    } else {
      // 单步容错：记录 failed，继续后续步骤
      step.status = 'failed';
      step.error = heal.error ?? first.error ?? '工具执行失败（自愈未恢复）';
      step.updatedAt = Date.now();
      await this.savePlan(plan);
      yield {
        type: 'agent_step',
        planId: plan.id,
        stepId: step.id,
        label: step.label,
        status: 'failed',
        detail: `${step.error}｜${heal.suggestion?.message ?? ''}`,
      };
      toolCalls.push({ tool_name: step.tool, success: false });
    }
    return { suspended: false, promptTokens: 0, completionTokens: 0 };
  }

  /**
   * agent 步骤执行：域 Agent 小型 ReAct 循环（≤ MAX_AGENT_STEP_ROUNDS 轮）
   */
  private async *runAgentStep(
    plan: ExecutionPlan,
    step: PlanStep,
    context: PlanRunContext,
    toolCalls: Array<Record<string, unknown>>,
  ): AsyncGenerator<AgentRunEvent, StepOutcome> {
    const resolved = await this.aiConfigService.getResolvedConfig();
    const systemPrompt =
      step.prompt ??
      `你是「${step.label}」域的专家 Agent，负责完成用户目标：${plan.goal}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: plan.goal },
    ];
    const tools = this.registry.toToolDefinitionsForCategories(
      [],
      context.scope,
    );
    const toolContext = this.toToolContext(context);
    let promptTokens = 0;
    let completionTokens = 0;

    for (let round = 0; round < MAX_AGENT_STEP_ROUNDS; round += 1) {
      const generator = this.router.chatWithFallback(
        messages,
        {
          tools: tools.length > 0 ? tools : undefined,
          temperature: resolved.temperature,
          max_tokens: resolved.maxTokens,
        },
        {
          requestedModel: context.model,
          resolved,
          systemScope: this.router.getSystemScope(),
        },
      );
      let chatResult!: Awaited<ReturnType<typeof generator.next>>['value'];
      let textBuf = '';
      try {
        while (true) {
          const { value, done } = await generator.next();
          if (done) {
            chatResult = value;
            break;
          }
          textBuf += value;
          yield { type: 'text', content: value };
        }
      } catch (err) {
        step.status = 'failed';
        step.error = err instanceof Error ? err.message : String(err);
        step.updatedAt = Date.now();
        await this.savePlan(plan);
        yield { type: 'error', message: step.error };
        return { suspended: false, promptTokens: 0, completionTokens: 0 };
      }

      promptTokens += chatResult.prompt_tokens;
      completionTokens += chatResult.completion_tokens;
      if (!chatResult.tool_calls || chatResult.tool_calls.length === 0) {
        step.status = 'success';
        step.result = { text: textBuf };
        step.error = undefined;
        step.updatedAt = Date.now();
        await this.savePlan(plan);
        yield {
          type: 'agent_step',
          planId: plan.id,
          stepId: step.id,
          label: step.label,
          status: 'success',
        };
        return { suspended: false, promptTokens, completionTokens };
      }

      messages.push({
        role: 'assistant',
        content: textBuf,
        tool_calls: chatResult.tool_calls,
      });

      // 执行本轮回工具调用（读自动、写挂起）
      for (const tc of chatResult.tool_calls) {
        const toolName = tc.function.name;
        yield { type: 'tool_start', tool: toolName };
        const result = await this.executor.executeToolCall(tc, toolContext);
        const suspend = await this.maybeSuspendWrite(
          plan,
          step,
          result,
          context,
          tc,
        );
        for (const event of suspend.events) {
          yield event;
        }
        if (suspend.suspended) {
          return { suspended: true, promptTokens, completionTokens };
        }
        yield {
          type: 'tool_result',
          tool: toolName,
          success: result.success,
          data: result.data,
          error: result.error,
        };
        toolCalls.push({ tool_name: toolName, success: result.success });
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: toolName,
          content: JSON.stringify(result),
        });
      }
    }

    step.status = 'success';
    step.result = { text: '达到子循环轮数上限，已停止' };
    step.updatedAt = Date.now();
    await this.savePlan(plan);
    yield {
      type: 'agent_step',
      planId: plan.id,
      stepId: step.id,
      label: step.label,
      status: 'success',
      detail: '达到子循环轮数上限',
    };
    return { suspended: false, promptTokens, completionTokens };
  }

  /**
   * 写步骤挂起（写全审核）：工具返回 preview 时生成 WriteGuard 令牌，
   * 步骤置 suspended，计划置 suspended。
   */
  private async maybeSuspendWrite(
    plan: ExecutionPlan,
    step: PlanStep,
    result: ToolResult,
    context: PlanRunContext,
    toolCall?: ToolCall,
  ): Promise<{ suspended: boolean; events: AgentRunEvent[] }> {
    if (!result.preview) {
      return { suspended: false, events: [] };
    }
    const toolName = toolCall?.function.name ?? step.tool ?? '';
    const tool = this.registry.get(toolName);
    const risk = tool?.risk ?? 'medium';
    try {
      const confirmation = await this.confirmationService.create({
        tenantId: plan.tenantId,
        conversationId: context.sessionId,
        toolName,
        docType: toolName,
        risk,
        needsReview: tool?.needsReview ?? risk === 'high',
        args: toolCall
          ? (JSON.parse(toolCall.function.arguments) as Record<string, unknown>)
          : (step.args ?? {}),
        preview: result.preview,
        operationLabel: result.preview.operation ?? toolName,
        planId: plan.id,
        planStepId: step.id,
      });
      step.pendingToken = confirmation.confirmationId;
      step.preview = result.preview;
      step.status = 'suspended';
      step.updatedAt = Date.now();
      plan.state = 'suspended';
      await this.savePlan(plan);

      const expireAt = Date.now() + WRITE_TOKEN_TTL_MS;
      const events: AgentRunEvent[] = [
        {
          type: 'tool_result',
          tool: toolName,
          success: result.success,
          data: result.data,
          preview: result.preview,
          confirmationId: confirmation.confirmationId,
        },
        {
          type: 'pending_write',
          token: confirmation.confirmationId,
          preview: result.preview,
          writeType: toolName,
          expireAt,
        },
        {
          type: 'await_confirm',
          token: confirmation.confirmationId,
          expireAt,
        },
        {
          type: 'agent_step',
          planId: plan.id,
          stepId: step.id,
          label: step.label,
          status: 'suspended',
          detail: `等待确认：${result.preview.operation ?? toolName}`,
        },
      ];
      this.logger.log(
        `计划写步骤挂起：plan=${plan.id} step=${step.id} tool=${toolName} token=${confirmation.confirmationId.slice(0, 12)}…`,
      );
      return { suspended: true, events };
    } catch (err) {
      this.logger.warn(
        `计划写步骤挂起失败（降级为普通结果）：${err instanceof Error ? err.message : String(err)}`,
      );
      return { suspended: false, events: [] };
    }
  }

  // ──────────────────────────────────────────────────────────
  // 辅助
  // ──────────────────────────────────────────────────────────

  /** 消费子生成器：收集事件 + 返回值 */
  private async drainStep(
    gen: AsyncGenerator<AgentRunEvent, StepOutcome>,
  ): Promise<{ events: AgentRunEvent[]; ret: StepOutcome }> {
    const events: AgentRunEvent[] = [];
    let ret!: StepOutcome;
    while (true) {
      const { value, done } = await gen.next();
      if (done) {
        ret = value;
        break;
      }
      events.push(value);
    }
    return { events, ret };
  }

  /** 计划收尾：审计 + ai_db 采集 + 指标 + done 事件 */
  private buildDoneEvent(
    plan: ExecutionPlan,
    startTime: number,
    promptTokens: number,
    completionTokens: number,
  ): AgentRunEvent[] {
    const latencyMs = Date.now() - startTime;
    const failed = plan.steps.filter((s) => s.status === 'failed');
    this.metrics.recordRequest(
      plan.tenantId,
      'agent',
      failed.length > 0 ? 'fail' : 'success',
    );
    this.metrics.recordDuration(latencyMs);
    this.metrics.recordTokens(promptTokens, completionTokens);
    this.metrics.recordAgentIterations(plan.steps.length);

    // ai_db 经验回流（best-effort）
    try {
      void this.capture.captureTask({
        tenantId: plan.tenantId,
        domain: failed.length > 0 ? 'write' : 'analysis',
        intent: `agent_plan_${plan.id}`,
        userMessage: plan.goal,
        toolCalls: [],
        outcome: failed.length > 0 ? 'failed' : 'success',
        reply: `计划 ${plan.id} 完成：${plan.steps.filter((s) => s.status === 'success').length} 步成功，${failed.length} 步失败`,
        error: failed[0]?.error,
      });
    } catch (err) {
      this.logger.debug(
        `计划经验回流失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 审计
    this.auditLogger.logAiCall({
      tenantId: plan.tenantId,
      sessionId: plan.tenantId,
      provider: 'agent',
      model: 'planner+runner',
      intent: 'agent_plan',
      userMessage: plan.goal,
      toolCalls: [],
      promptTokens,
      completionTokens,
      latencyMs,
      success: failed.length === 0,
    });

    this.logger.log(
      `执行计划完成：id=${plan.id} state=${plan.state} steps=${plan.steps.length} latency=${latencyMs}ms`,
    );
    return [
      {
        type: 'done',
        planId: plan.id,
        state: plan.state,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          latencyMs,
          steps: plan.steps.length,
        },
      },
    ];
  }

  /** 从计划步骤推导终态 */
  private detectFinalState(plan: ExecutionPlan): PlanState {
    const pending = plan.steps.filter(
      (s) => s.status === 'pending' || s.status === 'running',
    );
    if (pending.length > 0) {
      return 'pending';
    }
    const failed = plan.steps.some((s) => s.status === 'failed');
    if (failed) {
      return 'failed';
    }
    return 'success';
  }

  /** entity → 内存模型（解析 steps JSON） */
  private toPlan(entity: AiExecutionPlanEntity): ExecutionPlan {
    let steps: PlanStep[] = [];
    if (entity.steps) {
      try {
        steps = JSON.parse(entity.steps) as PlanStep[];
      } catch {
        steps = [];
      }
    }
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      goal: entity.goal ?? '',
      steps,
      state: entity.state,
      createdBy: entity.createdBy ?? undefined,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  private toToolContext(context: PlanRunContext): ToolContext {
    return {
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: context.sessionId ?? `plan-${context.tenantId}`,
      role: context.role,
      authToken: context.authToken,
    };
  }

  private toToolCall(tool: string, args: Record<string, unknown>): ToolCall {
    return {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: {
        name: tool,
        arguments: JSON.stringify(args),
      },
    };
  }
}
