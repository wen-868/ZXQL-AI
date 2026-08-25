/**
 * WriteGuardController — 写全审核令牌统一接口（P0-1）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 23 章
 * 原则：读全自动、写全审核、令牌确认。
 *
 * 端点：
 * - POST /api/ai/agent/confirm  { token, action: 'confirm'|'cancel', remark? }
 *   - confirm：令牌校验 → 高危二次确认（needsSecondConfirm=true 时不执行，等待再次确认）
 *              → 构造 confirm=true 参数执行工具 → 注册 3 分钟撤销窗口
 *   - cancel：取消待确认操作（pending / first_confirmed 可取消）
 *
 * 与旧端点（/api/chat/confirmations/:id/*）等价：confirmationId 即 WriteGuard token，
 * 前端确认卡保持现有交互，无需改动。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Body, Controller, Logger, Post } from '@nestjs/common';
import { ConfirmationService } from '../brain/confirmation.service';
import { TaskRunnerService } from '../brain/agent/task-runner.service';
import { TenantContext } from '../tenant/tenant-context';
import type { ToolContext } from '../tools/tool.interface';
import { WriteGuardActionDto } from './dto/write-guard.dto';

/** WriteGuard 统一确认响应 */
export interface WriteGuardActionResponse {
  success: boolean;
  data?: unknown;
  operationId?: string;
  message?: string;
  error?: string;
  suggestion?: string;
  /** true = 高危写首次确认，需二次确认后才真正执行 */
  needsSecondConfirm?: boolean;
}

@Controller('ai/agent')
export class WriteGuardController {
  private readonly logger = new Logger(WriteGuardController.name);

  constructor(
    private readonly confirmationService: ConfirmationService,
    private readonly taskRunner: TaskRunnerService,
    private readonly tenantContext: TenantContext,
  ) {}

  /**
   * WriteGuard 统一确认/取消
   *
   * POST /api/ai/agent/confirm
   * Headers: Authorization: Bearer <JWT>（TenantMiddleware 注入 tenantId）
   */
  @Post('confirm')
  async confirm(
    @Body() dto: WriteGuardActionDto,
  ): Promise<WriteGuardActionResponse> {
    const ctxData = this.tenantContext.getData();
    const tenantId = ctxData?.tenantId;
    if (!tenantId) {
      return { success: false, error: '未认证：无法确定租户身份' };
    }

    if (dto.action === 'cancel') {
      const cancelled = await this.confirmationService.cancel(
        dto.token,
        tenantId,
      );
      if (!cancelled) {
        return { success: false, error: '待确认操作不存在或已过期' };
      }
      return { success: true, message: '操作已取消' };
    }

    const toolContext: ToolContext = {
      tenantId,
      userId: ctxData?.userId,
      sessionId: ctxData?.sessionId,
      role: ctxData?.role,
      customerId: ctxData?.customerId,
      authToken: ctxData?.authToken,
    };

    const result = await this.confirmationService.confirmAndExecute(
      dto.token,
      tenantId,
      toolContext,
      dto.remark,
    );

    // 批次2 Agent 内核：确认执行后回写计划步骤（若该令牌属于计划写步骤）
    if (result.success && !result.needsSecondConfirm) {
      try {
        await this.taskRunner.markStepExecutedByToken(dto.token, tenantId, {
          success: true,
          data: result.data,
        });
      } catch (err) {
        this.logger.debug(
          `计划步骤回写失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (result.needsSecondConfirm) {
      this.logger.log(
        `高危写操作首次确认（待二次确认）：token=${dto.token} tenant=${tenantId}`,
      );
    }
    return result;
  }
}
