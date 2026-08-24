/**
 * api_adjust_credit_limit 工具 — 调整客户授信额度（高危写操作，强制人工审核）
 *
 * 对应后端 API：PUT /api/admin/credits/:customerId/limit
 * 后端路由：credit.routes.ts（prefix: /api/admin/credits，creditAdjustController.adjustLimit）
 * 后端校验（credit-adjust.controller.ts adjustLimit zod schema）：
 * - creditLimit: number>=0 必填
 * - reason: string max255 默认 "调整授信额度"
 *
 * 风险分级 high + needsReview=true：授信额度涉及资金风险，
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

interface AdjustCreditArgs {
  customerId: number;
  customerName?: string;
  creditLimit: number;
  reason: string;
  confirm?: boolean;
}

@Injectable()
export class AdjustCreditLimitTool implements ITool {
  private readonly logger = new Logger(AdjustCreditLimitTool.name);

  readonly name = 'api_adjust_credit_limit';
  readonly description =
    '调整客户授信额度（高危写操作，需用户确认且强制人工审核）。' +
    '入参：customerId(客户ID)、creditLimit(新授信额度)、reason(调整原因,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 提交调整。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  readonly needsReview = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: {
        type: 'number',
        description: '客户ID（必填，从客户列表获取）',
      },
      customerName: {
        type: 'string',
        description: '客户名称（可选，预览展示用）',
      },
      creditLimit: {
        type: 'number',
        description: '新授信额度（必填，>=0）',
      },
      reason: {
        type: 'string',
        description: '调整原因（可选，最长255字）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=提交，默认 false）',
      },
    },
    required: ['customerId', 'creditLimit'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const a = parsed.data;

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '调整授信额度',
          summary:
            `将${a.customerName ?? `客户 #${a.customerId}`}的授信额度` +
            `调整为 ${a.creditLimit} 元${a.reason ? `（原因：${a.reason}）` : ''}`,
          details: {
            customerId: a.customerId,
            customerName: a.customerName ?? '',
            creditLimit: a.creditLimit,
            reason: a.reason,
          },
          reviewRequired: true,
        },
      };
    }

    try {
      const result = await this.serviceClient.put(
        `${API_ENDPOINTS.CREDITS}/${a.customerId}/limit`,
        { creditLimit: a.creditLimit, reason: a.reason },
        context,
      );
      this.logger.log(`客户 #${a.customerId} 授信额度调整为 ${a.creditLimit}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`调整授信额度失败：${msg}`);
      return {
        success: false,
        error: `调整授信额度失败：${msg}`,
        suggestion: '请确认客户ID与额度数值后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: AdjustCreditArgs }
    | { valid: false; error: string; suggestion?: string } {
    const customerId = Number(args.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return {
        valid: false,
        error: '参数 customerId 必须为正整数',
        suggestion: '请提供客户ID',
      };
    }
    const creditLimit = Number(args.creditLimit);
    if (!Number.isFinite(creditLimit) || creditLimit < 0) {
      return {
        valid: false,
        error: '参数 creditLimit 必须为不小于 0 的数字',
        suggestion: '请检查授信额度',
      };
    }
    const reason =
      typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason.trim().slice(0, 255)
        : '调整授信额度';
    return {
      valid: true,
      data: {
        customerId,
        customerName:
          typeof args.customerName === 'string' ? args.customerName : undefined,
        creditLimit,
        reason,
        confirm: args.confirm === true,
      },
    };
  }
}
