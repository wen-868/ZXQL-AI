/**
 * api_convert_purchase_plan 工具 — 采购计划转采购单（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/purchase-plans/:planNo/convert
 * 后端路由：purchase-plan.routes.ts（prefix: /api/admin/purchase-plans）
 * 后端服务：purchase-plan.service.ts convertPurchasePlan（DRAFT → 采购单）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式转换。
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
export class ConvertPurchasePlanTool implements ITool {
  private readonly logger = new Logger(ConvertPurchasePlanTool.name);

  readonly name = 'api_convert_purchase_plan';
  readonly description =
    '将采购计划转换为采购单（写操作，需用户确认）。' +
    '入参：planNo(采购计划单号，必填)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式转换。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      planNo: {
        type: 'string',
        description: '采购计划单号（必填，如 JH202608160001）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=转换，默认 false）',
      },
    },
    required: ['planNo'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const planNo = args.planNo;
    if (typeof planNo !== 'string' || planNo.trim().length === 0) {
      return {
        success: false,
        error: '参数 planNo 必填',
        suggestion: '请提供采购计划单号（可先查询采购计划列表）',
      };
    }
    const confirm = args.confirm === true;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '采购计划转采购单',
          summary: `将采购计划 ${planNo.trim()} 转换为采购单`,
          details: { planNo: planNo.trim() },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.PURCHASE_PLANS}/${encodeURIComponent(planNo.trim())}/convert`,
        {},
        context,
      );
      this.logger.log(`采购计划 ${planNo.trim()} 已转为采购单`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`采购计划转采购单失败：${msg}`);
      return {
        success: false,
        error: `采购计划转采购单失败：${msg}`,
        suggestion: '请确认计划单号正确且计划状态为可转换（DRAFT）',
      };
    }
  }
}
