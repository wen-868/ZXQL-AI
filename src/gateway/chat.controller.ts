/**
 * Chat Controller — SSE 流式对话接口
 *
 * 职责：
 * 1. 接收用户消息，委托 Orchestrator 执行 Agent Loop
 * 2. 将 Orchestrator 产出的事件转为 SSE 格式发送给前端
 * 3. 仅负责 HTTP/SSE 传输，不包含业务逻辑（Agent Loop 在 Orchestrator 中）
 *
 * SSE 事件格式（每行 `data: {JSON}\n\n`）：
 * - {"type":"text","content":"增量文本"}      — LLM 生成的文本片段
 * - {"type":"tool_start","tool":"工具名"}       — 开始执行工具
 * - {"type":"tool_result","tool":"工具名","success":true,"data":{...}} — 工具执行结果
 * - {"type":"done","conversationId":"xxx","usage":{...}} — 对话结束
 * - {"type":"error","message":"错误描述"}       — 错误事件
 *
 * R70-08 重构：Agent Loop 逻辑已迁移到 Orchestrator，Controller 仅负责 SSE 传输
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
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
import { Orchestrator } from '../brain/orchestrator.service';
import { ConfirmationService } from '../brain/confirmation.service';
import { RollbackExecutorService } from '../brain/rollback-executor.service';
import { TenantContext } from '../tenant/tenant-context';
import { ExternalModelService } from '../tenant/external-model.service';
import { AiConfigService } from '../tenant/ai-config.service';
import { VisionService } from '../providers/vision.service';
import type { ToolContext } from '../tools/tool.interface';
import { ChatDto } from './dto/chat.dto';
import {
  ConfirmConfirmationDto,
  ExecutedOperationResponse,
  PendingConfirmationResponse,
  RevokeOperationDto,
} from './dto/confirmation.dto';

@Controller('chat')
export class ChatController {
  private readonly logger = new Logger(ChatController.name);

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly tenantContext: TenantContext,
    private readonly confirmationService: ConfirmationService,
    private readonly rollbackExecutor: RollbackExecutorService,
    private readonly externalModelService: ExternalModelService,
    private readonly aiConfigService: AiConfigService,
    private readonly visionService: VisionService,
  ) {}

  /**
   * 当前租户可用模型列表（对话级模型切换下拉数据源）
   *
   * GET /api/chat/models
   * 返回：内置模型 + 启用外部模型 + 当前默认模型标识
   */
  @Get('models')
  async listModels(): Promise<{
    default: string;
    models: Array<{
      value: string;
      label: string;
      type: 'builtin' | 'external';
    }>;
  }> {
    const tenantId = this.getTenantId();
    const external = await this.externalModelService.options();
    const builtin = [
      { value: 'glm', label: '智谱 GLM（免费）', type: 'builtin' as const },
      { value: 'deepseek', label: 'DeepSeek', type: 'builtin' as const },
      { value: 'ollama', label: '本地 Ollama', type: 'builtin' as const },
    ];

    let defaultModel = 'glm';
    if (tenantId) {
      try {
        const resolved = await this.aiConfigService.getResolvedConfig();
        defaultModel = resolved.provider;
      } catch {
        // 无配置时保持内置默认
      }
    }

    return {
      default: defaultModel,
      models: [
        ...builtin,
        ...external.map((m) => ({
          value: m.name,
          label: `${m.displayName}（外部模型）`,
          type: 'external' as const,
        })),
      ],
    };
  }

  /**
   * SSE 流式对话
   *
   * POST /api/chat
   * Content-Type: application/json
   * Accept: text/event-stream
   *
   * 请求体：{ "message": "你好" }
   * Headers: Authorization: Bearer <JWT>（TenantMiddleware 自动解析 tenantId）
   *
   * 响应：SSE 流式事件
   */
  @Post()
  async chat(@Body() dto: ChatDto, @Res() res: Response): Promise<void> {
    // ── 多租户：从 TenantContext 获取租户信息（R70-07）──
    const ctxData = this.tenantContext.getData();
    const tenantId = ctxData?.tenantId ?? dto.tenantId;

    if (!tenantId) {
      this.logger.warn('对话请求缺少 tenantId（无 JWT 且请求体未传入）');
      res.status(401).json({
        statusCode: 401,
        message:
          '未认证：请在 Authorization Header 中携带 JWT，或在请求体中传入 tenantId',
      });
      return;
    }

    this.logger.log(
      `收到对话请求：tenant=${tenantId} user=${ctxData?.userId ?? dto.userId ?? 'anonymous'} msg="${dto.message.slice(0, 50)}..."`,
    );

    // 感知·看：图片 → 视觉模型生成描述并入对话上下文（失败降级纯文本）
    let message = dto.message;
    if (dto.image && dto.image.length > 0) {
      try {
        const description = await this.visionService.describeImage(dto.image);
        if (description) {
          message = `${message}\n\n[用户上传了一张图片，识别内容：${description}]`;
          this.logger.log(
            `图片已识别并入对话（描述 ${description.length} 字）`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `图片理解降级（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx 关闭缓冲
    res.flushHeaders();

    try {
      // ── 委托 Orchestrator 执行 Agent Loop，逐事件转 SSE ──
      for await (const event of this.orchestrator.run({
        message,
        conversationId: dto.conversationId,
        tenantId,
        userId: ctxData?.userId ?? dto.userId,
        role: ctxData?.role ?? dto.role,
        authToken: ctxData?.authToken,
        model: dto.model,
        mode: dto.mode,
        graphId: dto.graphId,
        scope: dto.scope,
      })) {
        this.sendSse(res, event);
      }
    } catch (err) {
      // Orchestrator 内部已有 try-catch，此处兜底防止未捕获异常导致连接挂起
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `SSE 传输异常：${errMsg}`,
        err instanceof Error ? err.stack : undefined,
      );
      this.sendSse(res, { type: 'error', message: `SSE 传输异常：${errMsg}` });
    } finally {
      res.end();
    }
  }

  /**
   * 发送 SSE 事件
   *
   * 格式：`data: {JSON}\n\n`
   * 客户端用 EventSource API 接收，或用 fetch + ReadableStream 读取。
   */
  private sendSse(res: Response, data: Record<string, unknown>): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // ──────────────────────────────────────────────────────────────
  // 写操作确认机制（R70-15）
  // ──────────────────────────────────────────────────────────────

  /**
   * 获取当前租户的待确认操作列表
   *
   * GET /api/chat/confirmations
   * Headers: Authorization: Bearer <JWT>（TenantMiddleware 注入 tenantId）
   */
  @Get('confirmations')
  async listConfirmations(): Promise<{
    total: number;
    items: PendingConfirmationResponse[];
  }> {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      return { total: 0, items: [] };
    }

    const records = await this.confirmationService.listPending(tenantId);
    const items: PendingConfirmationResponse[] = records.map((record) => ({
      confirmationId: record.confirmationId,
      operationLabel: record.operationLabel,
      toolName: record.toolName,
      preview: record.preview,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      status:
        record.status === 'confirmed' || record.status === 'first_confirmed'
          ? 'confirmed'
          : 'pending',
    }));

    return { total: items.length, items };
  }

  /**
   * 确认执行待确认操作
   *
   * POST /api/chat/confirmations/:confirmationId/confirm
   * 流程（P0-1 WriteGuard）：令牌校验 → 高危二次确认（needsSecondConfirm=true 时
   *       不执行，等待再次确认）→ 构造 confirm=true 参数 → 调用对应工具真正执行
   *       → 执行成功后注册 3 分钟撤销窗口
   */
  @Post('confirmations/:confirmationId/confirm')
  async confirmOperation(
    @Param('confirmationId') confirmationId: string,
    @Body() dto: ConfirmConfirmationDto,
  ): Promise<{
    success: boolean;
    data?: unknown;
    operationId?: string;
    message?: string;
    error?: string;
    suggestion?: string;
    needsSecondConfirm?: boolean;
  }> {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }

    const result = await this.confirmationService.confirmAndExecute(
      confirmationId,
      tenantId,
      this.buildToolContext(tenantId),
      dto.remark,
    );

    return {
      success: result.success,
      data: result.data,
      operationId: result.operationId,
      message: result.message,
      error: result.error,
      suggestion: result.suggestion,
      needsSecondConfirm: result.needsSecondConfirm,
    };
  }

  /**
   * 取消待确认操作
   *
   * POST /api/chat/confirmations/:confirmationId/cancel
   */
  @Post('confirmations/:confirmationId/cancel')
  async cancelOperation(
    @Param('confirmationId') confirmationId: string,
  ): Promise<{
    success: boolean;
    message?: string;
    error?: string;
  }> {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }

    const cancelled = await this.confirmationService.cancel(
      confirmationId,
      tenantId,
    );
    if (!cancelled) {
      return { success: false, error: '待确认操作不存在或已过期' };
    }

    return { success: true, message: '操作已取消' };
  }

  /**
   * 撤销已执行操作（3 分钟内，仅限未发货状态）
   *
   * POST /api/chat/operations/:operationId/revoke
   * 注意：撤销的最终落地（如取消销售单/回退库存）由业务侧工具完成，
   *       本端点负责校验撤销窗口并登记撤销状态，返回操作指引。
   */
  @Post('operations/:operationId/revoke')
  async revokeOperation(
    @Param('operationId') operationId: string,
    @Body() dto: RevokeOperationDto,
  ): Promise<{
    success: boolean;
    message?: string;
    error?: string;
    revocable?: boolean;
    rollbackHandled?: boolean;
    rollbackSuccess?: boolean;
  }> {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }

    const check = this.confirmationService.canRevoke(operationId, tenantId);
    if (!check.ok) {
      return { success: false, error: check.reason ?? '无法撤销' };
    }

    // 在登记撤销前取操作记录（用于自动回滚）
    const operation = this.confirmationService.getExecuted(operationId);
    this.confirmationService.markRevoked(operationId, tenantId);
    this.logger.log(
      `操作已登记撤销：id=${operationId} tenant=${tenantId} reason=${dto.reason ?? '用户主动撤销'}`,
    );

    // 自动回滚：有映射的写操作自动调用回滚工具，无映射降级为引导
    if (operation) {
      const ctx = this.tenantContext.getData();
      const rollback = await this.rollbackExecutor.executeRollback(operation, {
        tenantId,
        userId: ctx?.userId,
        authToken: ctx?.authToken,
        sessionId: operation.conversationId,
      });
      return {
        success: true,
        revocable: true,
        rollbackHandled: rollback.handled,
        rollbackSuccess: rollback.success,
        message: rollback.message,
      };
    }

    return {
      success: true,
      revocable: true,
      message: '撤销登记成功，操作记录已清理',
    };
  }

  /**
   * 查询已执行操作（含撤销窗口状态）
   *
   * GET /api/chat/operations/:operationId
   */
  @Get('operations/:operationId')
  getOperation(@Param('operationId') operationId: string): {
    success: boolean;
    operation?: ExecutedOperationResponse;
    error?: string;
  } {
    const tenantId = this.getTenantId();
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }

    const operation = this.confirmationService.getExecuted(operationId);
    if (!operation || operation.tenantId !== tenantId) {
      return { success: false, error: '操作记录不存在或已过期' };
    }

    const revocable = this.confirmationService.canRevoke(
      operationId,
      tenantId,
    ).ok;

    return {
      success: true,
      operation: {
        operationId: operation.operationId,
        operationLabel: operation.operationLabel,
        toolName: operation.toolName,
        result: operation.result,
        executedAt: operation.executedAt,
        revokeExpiresAt: operation.revokeExpiresAt,
        revocable,
      },
    };
  }

  /**
   * 从 TenantContext 获取租户 ID
   */
  private getTenantId(): string | undefined {
    return this.tenantContext.getData()?.tenantId;
  }

  /**
   * 构建工具执行上下文
   */
  private buildToolContext(tenantId: string): ToolContext {
    const ctxData = this.tenantContext.getData();
    return {
      tenantId,
      userId: ctxData?.userId,
      sessionId: ctxData?.sessionId,
      role: ctxData?.role,
      authToken: ctxData?.authToken,
    };
  }
}
