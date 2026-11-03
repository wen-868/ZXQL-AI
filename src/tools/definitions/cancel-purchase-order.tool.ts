/**
 * cancelPurchaseOrder 工具 — 取消采购单（写操作）
 *
 * 用途：按采购单号取消采购单，需提供取消原因。
 * 对应后端 API：POST /api/admin/purchase-orders/:orderNo/cancel
 * 后端路由：purchase.routes.ts（prefix: /api/admin/purchase-orders）
 *
 * 同时作为 AI 写操作撤销回滚的执行工具（RollbackExecutor 自动调用）。
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

interface CancelPurchaseResult {
  orderNo: string;
  status: string;
  [key: string]: unknown;
}

@Injectable()
export class CancelPurchaseOrderTool implements ITool {
  private readonly logger = new Logger(CancelPurchaseOrderTool.name);

  readonly name = 'cancelPurchaseOrder';
  readonly description =
    '取消采购单（**高危写操作**，需确认）。' +
    '按采购单号取消指定采购单，需提供取消原因。' +
    '示例：用户说"取消CG20260801001"→ 调用此工具 → 先返回预览与后果，用户确认后传入 confirm=true 执行。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  /** 幂等业务键（AI-P0-3-F1）：同一采购单重复取消 ⇒ 同一键 ⇒ 回放首次结果 */
  readonly idempotencyKeyFields = ['orderNo'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: {
        type: 'string',
        description: '采购单号（必填，通常以CG开头）',
      },
      reason: {
        type: 'string',
        description: '取消原因（可选，默认为空字符串）',
      },
      confirm: {
        type: 'boolean',
        description:
          '是否确认执行（缺省 false ⇒ 仅返回预览与后果说明，不执行取消）',
      },
    },
    required: ['orderNo'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const orderNo = args.orderNo;
    if (typeof orderNo !== 'string' || orderNo.length === 0) {
      return {
        success: false,
        error: '参数 orderNo 必须为非空字符串',
        suggestion: '请传入要取消的采购单号',
      };
    }

    const reason = typeof args.reason === 'string' ? args.reason : '';
    const confirm = args.confirm === true;

    // ── 预览阶段（AI-P0-3-F1）：不调后端、不改任何状态，零写 ──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '取消采购单',
          summary: `将取消采购单 ${orderNo}${reason ? `（原因：${reason}）` : ''}`,
          details: {
            orderNo,
            reason: reason || null,
            // 来源标记：AI 发起的改动必须可追溯（MS 缺省记 admin）
            source: 'ai',
            consequence: '取消后采购单状态将变为 CANCELLED',
            cancellableHint: '仅待处理/部分到货状态可取消',
          },
          reviewRequired: true,
        },
      };
    }

    try {
      const result = await this.serviceClient.post<CancelPurchaseResult>(
        `${API_ENDPOINTS.PURCHASE_ORDERS}/${encodeURIComponent(orderNo)}/cancel`,
        {
          reason,
          // 🔴 必传：不传则来源记 admin，"AI 改动可追溯"断链（P0-3-F1 审计要求）
          source: 'ai',
        },
        context,
      );

      this.logger.log(
        `采购单取消成功：${orderNo}，原因：${reason || '未提供'}`,
      );

      return {
        success: true,
        data: {
          orderNo: result?.orderNo ?? orderNo,
          status: result?.status ?? 'CANCELLED',
          message: `采购单 ${orderNo} 已成功取消`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`取消采购单失败：${errorMsg}`);
      return {
        success: false,
        error: `取消采购单 ${orderNo} 失败：${errorMsg}`,
        suggestion: '请检查采购单状态或稍后重试',
      };
    }
  }
}
