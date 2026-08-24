/**
 * api_handle_approval 工具 — 审批任务处理（高危写操作，强制人工审核）
 *
 * 对应后端 API：
 * - POST /api/admin/approval/tasks/:id/approve（同意）
 * - POST /api/admin/approval/tasks/:id/reject（驳回）
 * 后端路由：approval.routes.ts（prefix: /api/admin/approval，approvalRecordsController）
 *
 * 风险分级 high + needsReview=true：审批动作影响业务单据状态（付款/入库/报销等），
 * 命中审核闸必须人工确认（P0-4 人工确认闸）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

@Injectable()
export class HandleApprovalTool implements ITool {
  private readonly logger = new Logger(HandleApprovalTool.name);

  readonly name = 'api_handle_approval';
  readonly description =
    '处理审批任务（高危写操作，需用户确认且强制人工审核）：同意或驳回审批任务。' +
    '入参：taskId(审批任务ID)、action(approve=同意/reject=驳回)、comment(意见,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 提交处理。';
  readonly category = 'system' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  readonly needsReview = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      taskId: {
        type: 'number',
        description: '审批任务ID（必填，从审批任务列表获取）',
      },
      action: {
        type: 'string',
        enum: ['approve', 'reject'],
        description: '操作（必填）：approve=同意 / reject=驳回',
      },
      comment: { type: 'string', description: '审批意见（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=提交，默认 false）',
      },
    },
    required: ['taskId', 'action'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const taskId = Number(args.taskId);
    if (!Number.isInteger(taskId) || taskId <= 0) {
      return {
        success: false,
        error: '参数 taskId 必须为正整数',
        suggestion: '请先查询审批任务列表获取任务ID',
      };
    }
    const action = args.action;
    if (action !== 'approve' && action !== 'reject') {
      return {
        success: false,
        error: '参数 action 必须为 approve 或 reject',
        suggestion: '请指定审批操作',
      };
    }
    const comment = typeof args.comment === 'string' ? args.comment : '';
    const confirm = args.confirm === true;
    const actionLabel = action === 'approve' ? '同意' : '驳回';

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '处理审批任务',
          summary: `${actionLabel}审批任务 #${taskId}${comment ? `（意见：${comment}）` : ''}`,
          details: { taskId, action, comment },
          reviewRequired: true,
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.APPROVAL}/tasks/${taskId}/${action}`,
        comment ? { comment } : {},
        context,
      );
      this.logger.log(`审批任务 ${taskId} 已${actionLabel}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`${actionLabel}审批任务失败：${msg}`);
      return {
        success: false,
        error: `${actionLabel}审批任务失败：${msg}`,
        suggestion: '请确认任务ID正确且当前用户有审批权限',
      };
    }
  }
}
