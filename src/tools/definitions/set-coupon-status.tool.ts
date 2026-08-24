/**
 * api_set_coupon_status 工具 — 优惠券模板激活/暂停（写操作，预览确认）
 *
 * 对应后端 API：
 * - POST /api/admin/marketing/coupons/templates/:id/activate
 * - POST /api/admin/marketing/coupons/templates/:id/pause
 * 后端路由：admin-marketing-coupon.routes.ts（prefix: /api/admin/marketing）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 执行。
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
export class SetCouponStatusTool implements ITool {
  private readonly logger = new Logger(SetCouponStatusTool.name);

  readonly name = 'api_set_coupon_status';
  readonly description =
    '激活或暂停优惠券模板（写操作，需用户确认）。' +
    '入参：templateId(模板ID)、action(activate=激活/pause=暂停)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 执行。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      templateId: {
        type: 'number',
        description: '优惠券模板ID（必填，从查询模板结果获取）',
      },
      action: {
        type: 'string',
        enum: ['activate', 'pause'],
        description: '操作：activate=激活 / pause=暂停（必填）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=执行，默认 false）',
      },
    },
    required: ['templateId', 'action'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const templateId = Number(args.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      return {
        success: false,
        error: '参数 templateId 必须为正整数',
        suggestion: '请先查询优惠券模板列表获取模板ID',
      };
    }
    const action = args.action;
    if (action !== 'activate' && action !== 'pause') {
      return {
        success: false,
        error: '参数 action 必须为 activate 或 pause',
        suggestion: '请指定操作：激活或暂停',
      };
    }
    const confirm = args.confirm === true;
    const actionLabel = action === 'activate' ? '激活' : '暂停';

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: `${actionLabel}优惠券模板`,
          summary: `${actionLabel}优惠券模板 #${templateId}`,
          details: { templateId, action },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.MARKETING_COUPONS}/${templateId}/${action}`,
        {},
        context,
      );
      this.logger.log(`优惠券模板 ${templateId} 已${actionLabel}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`${actionLabel}优惠券模板失败：${msg}`);
      return {
        success: false,
        error: `${actionLabel}优惠券模板失败：${msg}`,
        suggestion: '请确认模板ID正确且模板处于可操作状态',
      };
    }
  }
}
