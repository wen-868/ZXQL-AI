/**
 * api_set_marketing_activity_status 工具 — 营销活动激活/暂停（写操作，预览确认）
 *
 * 对应后端 API（前缀 /api/admin/marketing）：
 * - POST /flash-sales/:id/activate|pause
 * - POST /full-reductions/:id/activate|pause
 * - POST /group-buys/:id/activate|pause
 * - POST /limited-discounts/:id/activate|pause
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

const ACTIVITY_BASE: Record<string, string> = {
  flash_sale: API_ENDPOINTS.MARKETING_FLASH_SALES,
  full_reduction: API_ENDPOINTS.MARKETING_FULL_REDUCTIONS,
  group_buy: API_ENDPOINTS.MARKETING_GROUP_BUYS,
  limited_discount: API_ENDPOINTS.MARKETING_LIMITED_DISCOUNTS,
};

@Injectable()
export class SetMarketingActivityStatusTool implements ITool {
  private readonly logger = new Logger(SetMarketingActivityStatusTool.name);

  readonly name = 'api_set_marketing_activity_status';
  readonly description =
    '激活或暂停营销活动（写操作，需用户确认）。' +
    '入参：activityType(flash_sale秒杀/full_reduction满减/group_buy拼团/limited_discount限量折扣)、' +
    'activityId(活动ID)、action(activate=激活/pause=暂停)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 执行。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      activityType: {
        type: 'string',
        enum: ['flash_sale', 'full_reduction', 'group_buy', 'limited_discount'],
        description: '活动类型（必填）',
      },
      activityId: { type: 'number', description: '活动ID（必填）' },
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
    required: ['activityType', 'activityId', 'action'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const activityType = args.activityType;
    if (typeof activityType !== 'string' || !ACTIVITY_BASE[activityType]) {
      return {
        success: false,
        error:
          '参数 activityType 必须为 flash_sale/full_reduction/group_buy/limited_discount',
        suggestion: '请指定活动类型',
      };
    }
    const activityId = Number(args.activityId);
    if (!Number.isInteger(activityId) || activityId <= 0) {
      return {
        success: false,
        error: '参数 activityId 必须为正整数',
        suggestion: '请提供活动ID',
      };
    }
    const action = args.action;
    if (action !== 'activate' && action !== 'pause') {
      return {
        success: false,
        error: '参数 action 必须为 activate 或 pause',
        suggestion: '请指定操作',
      };
    }
    const confirm = args.confirm === true;
    const actionLabel = action === 'activate' ? '激活' : '暂停';

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: `${actionLabel}营销活动`,
          summary: `${actionLabel}${activityType}活动 #${activityId}`,
          details: { activityType, activityId, action },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${ACTIVITY_BASE[activityType]}/${activityId}/${action}`,
        {},
        context,
      );
      this.logger.log(`${activityType} 活动 ${activityId} 已${actionLabel}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`${actionLabel}营销活动失败：${msg}`);
      return {
        success: false,
        error: `${actionLabel}营销活动失败：${msg}`,
        suggestion: '请确认活动ID与活动类型匹配且状态可操作',
      };
    }
  }
}
