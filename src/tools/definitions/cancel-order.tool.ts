/**
 * cancelOrder 工具 — 取消订单（写操作）
 *
 * 用途：按订单号取消订单，需提供取消原因。
 * 这是写操作，返回取消结果。
 *
 * 对应后端 API：POST /api/admin/orders/:orderNo/cancel
 * 后端路由：admin-order.routes.ts（prefix: /api/admin）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 后端返回的取消结果 */
interface CancelResult {
  orderNo: string;
  status: string;
  [key: string]: unknown;
}

@Injectable()
export class CancelOrderTool implements ITool {
  private readonly logger = new Logger(CancelOrderTool.name);

  readonly name = 'cancelOrder';
  readonly description =
    '取消订单（写操作）。' +
    '按订单号取消指定订单，需提供取消原因。' +
    '仅待处理(PENDING)或已确认(CONFIRMED)状态的订单可取消，已配送(DELIVERED)或已完成(COMPLETED)的订单不可取消。' +
    '示例：用户说"取消ORD20260801001"→ 调用此工具 → 传入 orderNo 和 reason。';
  readonly category = 'order' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: {
        type: 'string',
        description: '订单号（必填，通常以ORD开头）',
      },
      reason: {
        type: 'string',
        description: '取消原因（可选，默认为空字符串）',
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
        suggestion: '请传入要取消的订单号',
      };
    }

    const reason = typeof args.reason === 'string' ? args.reason : '';

    try {
      const result = await this.serviceClient.post<CancelResult>(
        `${API_ENDPOINTS.ORDERS}/${encodeURIComponent(orderNo)}/cancel`,
        { reason },
        context,
      );

      this.logger.log(`订单取消成功：${orderNo}，原因：${reason || '未提供'}`);

      return {
        success: true,
        data: {
          orderNo: result?.orderNo ?? orderNo,
          status: result?.status ?? 'CANCELLED',
          message: `订单 ${orderNo} 已成功取消`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`取消订单失败：${errorMsg}`);
      return {
        success: false,
        error: `取消订单 ${orderNo} 失败：${errorMsg}`,
        suggestion:
          '请确认订单号是否正确，以及订单状态是否允许取消（仅PENDING/CONFIRMED状态可取消）',
      };
    }
  }
}
