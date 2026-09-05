/**
 * AgentController — Agent 自主执行内核接口（批次2，文档 22.6）
 *
 * 端点：
 * - POST /api/ai/agent/run       发起自主任务（SSE 流式；写步骤返回 token 挂起）
 * - POST /api/ai/agent/plan      提交长任务（仅规划，返回计划）
 * - GET  /api/ai/agent/plans     计划列表（租户隔离）
 * - GET  /api/ai/agent/plans/:id 计划详情（含步骤六态）
 * - POST /api/ai/agent/plans/:id/run    续跑/断点续跑（SSE）
 * - POST /api/ai/agent/plans/:id/approve  人工审批挂起步骤
 * - POST /api/ai/agent/plans/:id/reject   人工驳回挂起步骤
 * - POST /api/ai/agent/plans/:id/cancel   取消计划
 *
 * 确认入口复用 WriteGuard 统一接口：POST /api/ai/agent/confirm
 * （确认成功后自动回写计划步骤，再调用 plans/:id/run 继续剩余步骤）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AgentEngineService } from '../brain/agent/agent-engine.service';
import { TaskRunnerService } from '../brain/agent/task-runner.service';
import { TenantContext } from '../tenant/tenant-context';
import { aiError } from '../common/ai-errors';
import { AgentRunEvent } from '../brain/agent/agent.types';
import {
  AgentPlanDto,
  AgentResumeDto,
  AgentRunDto,
  ApproveStepDto,
  PlanIdParamDto,
  RejectStepDto,
} from './dto/agent.dto';

@Controller('ai/agent')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    private readonly engine: AgentEngineService,
    private readonly runner: TaskRunnerService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * 发起自主任务（SSE 流式）
   *
   * POST /api/ai/agent/run
   * 流程：Planner 分解 → ai_execution_plan 落库 → TaskRunner 执行
   *       → 读步骤全自动；写步骤挂起 WriteGuard 令牌（pending_write/await_confirm）
   */
  @Post('run')
  async run(@Body() dto: AgentRunDto, @Res() res: Response): Promise<void> {
    // 2026-09-05 鉴权链收紧：身份只认 JWT（TenantContext），请求体 tenantId/userId/role 不再作为身份来源
    const ctxData = this.tenantContext.getData();
    const tenantId = ctxData?.tenantId;
    if (!tenantId) {
      res.status(401).json({
        statusCode: 401,
        ...aiError('AI_001', {
          detail: '未认证：请在 Authorization Header 中携带 JWT',
        }),
      });
      return;
    }
    // scope=platform 仅限平台（总台）身份（AI_010）
    if (dto.scope === 'platform' && ctxData?.authType !== 'platform') {
      res.status(403).json({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: 'platform 工具域仅限总台平台身份调用',
        }),
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const event of this.engine.run({
        goal: dto.goal,
        tenantId,
        userId: ctxData?.userId,
        role: ctxData?.role,
        customerId: ctxData?.customerId,
        authToken: ctxData?.authToken,
        sessionId: dto.conversationId,
        model: dto.model,
        scope: dto.scope,
      })) {
        this.sendSse(res, event);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`自主任务 SSE 异常：${errMsg}`);
      this.sendSse(res, {
        type: 'error',
        message: `自主任务执行失败：${errMsg}`,
      });
    } finally {
      res.end();
    }
  }

  /**
   * 提交长任务（仅规划）
   *
   * POST /api/ai/agent/plan
   */
  @Post('plan')
  async plan(@Body() dto: AgentPlanDto): Promise<{
    success: boolean;
    plan?: import('../brain/agent/agent.types').ExecutionPlan;
    error?: string;
  }> {
    const ctxData = this.tenantContext.getData();
    const tenantId = ctxData?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }
    // scope=platform 仅限平台（总台）身份（AI_010）
    if (dto.scope === 'platform' && ctxData?.authType !== 'platform') {
      return {
        success: false,
        error: '无权限：platform 工具域仅限总台平台身份调用（AI_010）',
      };
    }
    const plan = await this.engine.createPlan({
      goal: dto.goal,
      tenantId,
      userId: ctxData?.userId,
      role: ctxData?.role,
      customerId: ctxData?.customerId,
      authToken: ctxData?.authToken,
      model: dto.model,
      scope: dto.scope,
    });
    return { success: true, plan };
  }

  /**
   * 计划列表（租户隔离）
   *
   * GET /api/ai/agent/plans
   */
  @Get('plans')
  async listPlans(): Promise<{
    success: boolean;
    total: number;
    items: import('../brain/agent/agent.types').ExecutionPlan[];
    error?: string;
  }> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, total: 0, items: [], error: '未认证' };
    }
    const items = await this.runner.listPlans(tenantId);
    return { success: true, total: items.length, items };
  }

  /**
   * 计划详情（含步骤六态）
   *
   * GET /api/ai/agent/plans/:id
   */
  @Get('plans/:id')
  async getPlan(@Param() params: PlanIdParamDto): Promise<{
    success: boolean;
    plan?: import('../brain/agent/agent.types').ExecutionPlan;
    error?: string;
  }> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证' };
    }
    const plan = await this.runner.getPlan(params.id, tenantId);
    if (!plan) {
      return { success: false, error: '计划不存在' };
    }
    return { success: true, plan };
  }

  /**
   * 续跑计划（断点续跑，SSE）
   *
   * POST /api/ai/agent/plans/:id/run
   */
  @Post('plans/:id/run')
  async resume(
    @Param() params: PlanIdParamDto,
    @Body() dto: AgentResumeDto,
    @Res() res: Response,
  ): Promise<void> {
    const ctxData = this.tenantContext.getData();
    const tenantId = ctxData?.tenantId;
    if (!tenantId) {
      res.status(401).json({
        statusCode: 401,
        message: '未认证：无法确定租户身份',
      });
      return;
    }
    // scope=platform 仅限平台（总台）身份（AI_010）
    if (dto.scope === 'platform' && ctxData?.authType !== 'platform') {
      res.status(403).json({
        statusCode: 403,
        message: '无权限：platform 工具域仅限总台平台身份调用（AI_010）',
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    try {
      for await (const event of this.engine.runPlan(params.id, {
        goal: '',
        tenantId,
        userId: ctxData?.userId,
        role: ctxData?.role,
        customerId: ctxData?.customerId,
        authToken: ctxData?.authToken,
        model: dto.model,
        scope: dto.scope,
      })) {
        this.sendSse(res, event);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(`计划续跑 SSE 异常：${errMsg}`);
      this.sendSse(res, { type: 'error', message: `计划续跑失败：${errMsg}` });
    } finally {
      res.end();
    }
  }

  /**
   * 人工审批挂起步骤（suspended → pending）
   *
   * POST /api/ai/agent/plans/:id/approve
   */
  @Post('plans/:id/approve')
  async approve(
    @Param() params: PlanIdParamDto,
    @Body() dto: ApproveStepDto,
  ): Promise<{
    success: boolean;
    plan?: import('../brain/agent/agent.types').ExecutionPlan;
    error?: string;
  }> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证' };
    }
    const result = await this.runner.approveStep(
      params.id,
      tenantId,
      dto.stepId,
    );
    return result;
  }

  /**
   * 人工驳回挂起步骤（suspended → skipped）
   *
   * POST /api/ai/agent/plans/:id/reject
   */
  @Post('plans/:id/reject')
  async reject(
    @Param() params: PlanIdParamDto,
    @Body() dto: RejectStepDto,
  ): Promise<{
    success: boolean;
    plan?: import('../brain/agent/agent.types').ExecutionPlan;
    error?: string;
  }> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证' };
    }
    const result = await this.runner.rejectStep(
      params.id,
      tenantId,
      dto.stepId,
      dto.reason,
    );
    return result;
  }

  /**
   * 取消计划（pending/running/suspended → skipped）
   *
   * POST /api/ai/agent/plans/:id/cancel
   */
  @Post('plans/:id/cancel')
  async cancel(@Param() params: PlanIdParamDto): Promise<{
    success: boolean;
    plan?: import('../brain/agent/agent.types').ExecutionPlan;
    error?: string;
  }> {
    const tenantId = this.tenantContext.getData()?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证' };
    }
    return this.runner.cancelPlan(params.id, tenantId);
  }

  /**
   * 发送 SSE 事件（data: {JSON}\n\n）
   */
  private sendSse(res: Response, data: AgentRunEvent): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}
