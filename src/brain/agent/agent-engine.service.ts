/**
 * AgentEngineService — Agent 自主执行内核门面（批次2，文档 22 章）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md
 * - 22.1 与原架构的关系：叠加在 Brain 层，不重写 Orchestrator（决策 21）
 * - 22.2 自主执行闭环（ReAct）：读全自动、写全审核
 * - 22.4 长任务（TaskRunner）：Planner 分解 → 持久化 → 断点续跑
 * - 22.5 自愈回路：执行失败自动纠错并回流 ai_db 经验
 *
 * 职责：goal → Planner 分解 → ai_execution_plan 落库 → TaskRunner 执行（SSE 事件流）。
 * 写步骤一律挂起 WriteGuard 令牌，由 /ai/agent/confirm 确认后继续。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { PlannerService } from './planner.service';
import { TaskRunnerService } from './task-runner.service';
import { AgentRunEvent, ExecutionPlan, PlanRunContext } from './agent.types';

/** AgentEngine 输入 */
export interface AgentRunInput {
  /** 用户目标（复合任务描述） */
  goal: string;
  /** 租户 ID */
  tenantId: string;
  /** 用户 ID */
  userId?: string;
  /** 用户角色 */
  role?: string;
  /** JWT auth token（透传工具） */
  authToken?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 对话级模型标识（可选） */
  model?: string;
  /** 工具作用域：mgmt/platform */
  scope?: 'mgmt' | 'platform';
}

@Injectable()
export class AgentEngineService {
  private readonly logger = new Logger(AgentEngineService.name);

  constructor(
    private readonly planner: PlannerService,
    private readonly runner: TaskRunnerService,
  ) {}

  /**
   * 规划并创建执行计划（不执行）
   *
   * POST /ai/agent/plan
   */
  async createPlan(input: AgentRunInput): Promise<ExecutionPlan> {
    const steps = await this.planner.plan({
      tenantId: input.tenantId,
      goal: input.goal,
      model: input.model,
      scope: input.scope,
    });
    const plan = await this.runner.createPlan({
      tenantId: input.tenantId,
      goal: input.goal,
      steps,
      createdBy: input.userId,
    });
    this.logger.log(
      `AgentEngine 创建计划：id=${plan.id} tenant=${input.tenantId} steps=${steps.length}`,
    );
    return plan;
  }

  /**
   * 规划 + 执行（SSE 事件流）
   *
   * POST /ai/agent/run
   */
  async *run(input: AgentRunInput): AsyncGenerator<AgentRunEvent> {
    const plan = await this.createPlan(input);
    yield* this.runPlan(plan.id, input);
  }

  /**
   * 续跑已有计划（SSE 事件流；断点续跑）
   *
   * POST /ai/agent/plans/:id/run
   */
  async *runPlan(
    planId: number,
    input: AgentRunInput,
  ): AsyncGenerator<AgentRunEvent> {
    const context: PlanRunContext = {
      tenantId: input.tenantId,
      userId: input.userId,
      role: input.role,
      authToken: input.authToken,
      sessionId: input.sessionId,
      model: input.model,
      scope: input.scope,
    };
    yield* this.runner.run(planId, input.tenantId, context);
  }
}
