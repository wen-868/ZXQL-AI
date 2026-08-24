/**
 * createPaymentReconciliation 工具 — 对账确认（写操作，含预览机制）
 *
 * 用途：对指定客户的对账单进行确认，生成确认记录。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/reconciliation/customer/:customerId/confirm
 * 后端路由：reconciliation.routes.ts（prefix: /api/admin/reconciliation，confirmCustomerReconciliation）
 * 后端服务：reconciliation.service.ts confirmCustomerReconciliation
 *
 * 执行逻辑：确认客户对账单，返回确认结果（含对账明细、应收余额等）。
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/reconciliation/customer/:customerId/confirm
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 后端对账确认返回 */
interface ReconciliationResult {
  [key: string]: unknown;
}

@Injectable()
export class CreatePaymentReconciliationTool implements ITool {
  private readonly logger = new Logger(CreatePaymentReconciliationTool.name);

  readonly name = 'createPaymentReconciliation';
  readonly description =
    '对账确认（写操作，需用户确认）：确认指定客户的对账单，生成确认记录。' +
    '需提供客户ID（customerId，从 searchCustomer 获取）。' +
    '首次调用 confirm=false 生成预览（含客户ID、确认操作说明），' +
    '用户确认后 confirm=true 正式执行对账确认。' +
    '示例参数：{"customerId":5,"confirm":false}';
  readonly category = 'finance' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['searchCustomer'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: {
        type: 'number',
        description: '客户ID（必填，从 searchCustomer 获取）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式确认。默认false）',
      },
    },
    required: ['customerId'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const customerId = args.customerId;
    if (typeof customerId !== 'number' || customerId <= 0) {
      return {
        success: false,
        error: '参数 customerId 必须为正整数',
        suggestion: '请先调用 searchCustomer 获取客户的 ID',
      };
    }

    const confirm = args.confirm === true;

    // ── 2. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        customerId,
        action: '确认客户对账单',
      };

      this.logger.log(`生成对账确认预览：customerId=${customerId}`);

      return {
        success: true,
        preview: {
          operation: '对账确认',
          summary: `确认客户 ${customerId} 的对账单`,
          details: previewDetails,
        },
      };
    }

    // ── 3. 执行阶段：调用后端确认对账 ──
    try {
      const result = await this.serviceClient.post<ReconciliationResult>(
        `${API_ENDPOINTS.RECONCILIATION}/customer/${customerId}/confirm`,
        undefined,
        context,
      );

      this.logger.log(`对账确认成功：customerId=${customerId}`);

      return {
        success: true,
        data: {
          customerId,
          result,
          message: `客户 ${customerId} 对账单已确认`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`对账确认失败：${errorMsg}`);
      return {
        success: false,
        error: `对账确认失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，检查客户ID是否正确',
      };
    }
  }
}
