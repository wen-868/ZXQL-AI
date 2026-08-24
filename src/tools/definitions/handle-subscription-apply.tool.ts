/**
 * api_platform_handle_subscription_apply 工具 — 审核订阅申请（总台高危写操作，强制人工审核）
 *
 * 对应后端 API：PUT /api/platform/subscription-applies/:id/audit（requirePlatformAuth）
 * 后端校验（platform-subscription-apply.controller.ts auditApply zod schema）：
 * - action: APPROVED（通过）/ REJECTED（驳回）
 * - auditRemark: string max500（可选）
 *
 * scope = 'platform'：仅总台对话暴露，租户侧绝不出现。
 * 风险分级 high + needsReview=true：审核影响租户订阅开通，命中人工审核闸。
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
export class HandleSubscriptionApplyTool implements ITool {
  private readonly logger = new Logger(HandleSubscriptionApplyTool.name);

  readonly name = 'api_platform_handle_subscription_apply';
  readonly description =
    '审核平台订阅申请（总台高危写操作，需用户确认且强制人工审核）：通过或驳回租户订阅申请。' +
    '入参：applyId(申请ID)、action(APPROVED=通过/REJECTED=驳回)、auditRemark(审核意见,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 提交审核。';
  readonly category = 'platform' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  readonly needsReview = true;
  readonly scope = 'platform' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      applyId: {
        type: 'number',
        description: '订阅申请ID（必填，从申请列表获取）',
      },
      action: {
        type: 'string',
        enum: ['APPROVED', 'REJECTED'],
        description: '审核结果（必填）：APPROVED=通过 / REJECTED=驳回',
      },
      auditRemark: {
        type: 'string',
        description: '审核意见（可选，最长500字）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=提交，默认 false）',
      },
    },
    required: ['applyId', 'action'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const applyId = Number(args.applyId);
    if (!Number.isInteger(applyId) || applyId <= 0) {
      return {
        success: false,
        error: '参数 applyId 必须为正整数',
        suggestion: '请先查询订阅申请列表获取申请ID',
      };
    }
    const action = args.action;
    if (action !== 'APPROVED' && action !== 'REJECTED') {
      return {
        success: false,
        error: '参数 action 必须为 APPROVED 或 REJECTED',
        suggestion: '请指定审核结果',
      };
    }
    const auditRemark =
      typeof args.auditRemark === 'string'
        ? args.auditRemark.slice(0, 500)
        : '';
    const confirm = args.confirm === true;
    const actionLabel = action === 'APPROVED' ? '通过' : '驳回';

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '审核订阅申请',
          summary: `${actionLabel}订阅申请 #${applyId}${auditRemark ? `（意见：${auditRemark}）` : ''}`,
          details: { applyId, action, auditRemark },
          reviewRequired: true,
        },
      };
    }

    try {
      const result = await this.serviceClient.put(
        `${API_ENDPOINTS.PLATFORM_SUBSCRIPTION_APPLIES}/${applyId}/audit`,
        { action, auditRemark },
        context,
      );
      this.logger.log(`订阅申请 ${applyId} 已${actionLabel}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`${actionLabel}订阅申请失败：${msg}`);
      return {
        success: false,
        error: `${actionLabel}订阅申请失败：${msg}`,
        suggestion: '请确认申请ID正确且使用总台账号会话操作',
      };
    }
  }
}
