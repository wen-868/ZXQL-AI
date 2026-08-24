/**
 * api_calculate_commission 工具 — 计算销售佣金（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/commission/calculate
 * 后端校验（commission.controller.ts calculateCommissionsSchema）：
 * - startDate、endDate（统计区间）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式计算。
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
export class CalculateCommissionTool implements ITool {
  private readonly logger = new Logger(CalculateCommissionTool.name);

  readonly name = 'api_calculate_commission';
  readonly description =
    '计算指定区间的销售佣金（写操作，需用户确认）：按佣金规则生成佣金记录。' +
    '入参：startDate(开始日期)、endDate(结束日期)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式计算。';
  readonly category = 'finance' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      startDate: {
        type: 'string',
        description: '统计开始日期（必填，YYYY-MM-DD）',
      },
      endDate: {
        type: 'string',
        description: '统计结束日期（必填，YYYY-MM-DD）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=计算，默认 false）',
      },
    },
    required: ['startDate', 'endDate'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const startDate = args.startDate;
    const endDate = args.endDate;
    if (
      typeof startDate !== 'string' ||
      typeof endDate !== 'string' ||
      !startDate ||
      !endDate
    ) {
      return {
        success: false,
        error: '参数 startDate/endDate 必填',
        suggestion: '格式如 2026-08-01 / 2026-08-31',
      };
    }
    const confirm = args.confirm === true;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '计算销售佣金',
          summary: `按佣金规则计算 ${startDate} ~ ${endDate} 区间佣金`,
          details: { startDate, endDate },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.COMMISSION}/calculate`,
        { startDate, endDate },
        context,
      );
      this.logger.log(`佣金计算完成：${startDate} ~ ${endDate}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`佣金计算失败：${msg}`);
      return {
        success: false,
        error: `佣金计算失败：${msg}`,
        suggestion: '请确认佣金规则已配置且日期区间有效',
      };
    }
  }
}
