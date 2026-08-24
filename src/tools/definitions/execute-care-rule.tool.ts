/**
 * api_execute_care_rule 工具 — 执行客户关怀规则（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/members/care/rules/:id/execute
 * 后端路由：customer-care.routes.ts（prefix: /api/admin/members/care）
 * 后端服务：careService.executeCareRule（按规则触发关怀动作：发消息/赠积分/发券）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式执行。
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
export class ExecuteCareRuleTool implements ITool {
  private readonly logger = new Logger(ExecuteCareRuleTool.name);

  readonly name = 'api_execute_care_rule';
  readonly description =
    '手动执行客户关怀规则（写操作，需用户确认）：按规则对匹配客户触发关怀（消息/积分/优惠券）。' +
    '入参：ruleId(关怀规则ID，从关怀规则列表获取)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式执行。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      ruleId: { type: 'number', description: '关怀规则ID（必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=执行，默认 false）',
      },
    },
    required: ['ruleId'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const ruleId = Number(args.ruleId);
    if (!Number.isInteger(ruleId) || ruleId <= 0) {
      return {
        success: false,
        error: '参数 ruleId 必须为正整数',
        suggestion: '请先查询关怀规则列表获取规则ID',
      };
    }
    const confirm = args.confirm === true;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '执行客户关怀规则',
          summary: `执行关怀规则 #${ruleId}`,
          details: { ruleId },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.CARE_RULES}/${ruleId}/execute`,
        {},
        context,
      );
      this.logger.log(`关怀规则 ${ruleId} 已执行`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`执行关怀规则失败：${msg}`);
      return {
        success: false,
        error: `执行关怀规则失败：${msg}`,
        suggestion: '请确认规则ID正确且规则已启用',
      };
    }
  }
}
