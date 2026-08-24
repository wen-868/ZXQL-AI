/**
 * createDelivery 工具 — 创建配送任务（写操作，含预览机制）
 *
 * 用途：为待配送的线上订单（即时零售订单）发起配送，将订单状态推进为"配送中"。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/store/orders/:orderNo/start-delivery
 * 后端路由：store-order.routes.ts（prefix: /api/store，startDelivery）
 * 后端服务：order.service.ts startDelivery（t_miniapp_order 状态 WAIT_DELIVERY → DELIVERING）
 *
 * 前置条件：订单状态必须为 WAIT_DELIVERY（待配送，已出库），否则后端返回 400。
 * 执行前建议先调用 queryDeliveryStatus 确认订单状态。
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/store/orders/:orderNo/start-delivery
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

/** 后端开始配送返回 */
interface StartDeliveryResult {
  orderNo: string;
  status: string;
  [key: string]: unknown;
}

@Injectable()
export class CreateDeliveryTool implements ITool {
  private readonly logger = new Logger(CreateDeliveryTool.name);

  readonly name = 'createDelivery';
  readonly description =
    '创建配送任务（写操作，需用户确认）：为待配送的线上订单发起配送，将订单状态从"待配送"推进为"配送中"。' +
    '必须先调用 queryDeliveryStatus 确认订单状态为 WAIT_DELIVERY（待配送），否则无法发起。' +
    '首次调用 confirm=false 生成预览（含订单号、当前状态、配送后状态），' +
    '用户确认后 confirm=true 正式发起配送。' +
    '注意：发起配送后订单状态变为 DELIVERING（配送中），送达后需人工标记完成。' +
    '示例参数：{"orderNo":"SO20260730001","confirm":false}';
  readonly category = 'delivery' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['queryDeliveryStatus'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: {
        type: 'string',
        description: '订单号（必填，如 SO20260730001，须为待配送状态）',
      },
      confirm: {
        type: 'boolean',
        description:
          '是否确认执行（false=生成预览，true=正式发起配送。默认false）',
      },
    },
    required: ['orderNo'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const orderNo = args.orderNo;
    if (typeof orderNo !== 'string' || orderNo.trim().length === 0) {
      return {
        success: false,
        error: '参数 orderNo 必须为非空字符串',
        suggestion: '请传入订单号（如 SO20260730001）',
      };
    }

    const trimmedOrderNo = orderNo.trim();
    const confirm = args.confirm === true;

    // ── 2. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        orderNo: trimmedOrderNo,
        action: '开始配送',
        fromStatus: 'WAIT_DELIVERY（待配送）',
        toStatus: 'DELIVERING（配送中）',
      };

      this.logger.log(`生成创建配送预览：orderNo=${trimmedOrderNo}`);

      return {
        success: true,
        preview: {
          operation: '创建配送任务',
          summary: `订单 ${trimmedOrderNo} 发起配送（待配送 → 配送中）`,
          details: previewDetails,
        },
      };
    }

    // ── 3. 执行阶段：调用后端开始配送 ──
    try {
      const result = await this.serviceClient.post<StartDeliveryResult>(
        `${API_ENDPOINTS.STORE_ORDERS}/${encodeURIComponent(trimmedOrderNo)}/start-delivery`,
        undefined,
        context,
      );

      this.logger.log(
        `配送任务创建成功：orderNo=${result.orderNo} 状态=${result.status}`,
      );

      return {
        success: true,
        data: {
          orderNo: result.orderNo,
          status: result.status,
          message: `订单 ${result.orderNo} 已开始配送，当前状态：配送中`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建配送任务失败：${errorMsg}`);
      return {
        success: false,
        error: `创建配送任务失败：${errorMsg}`,
        suggestion:
          '请确认订单号正确且订单状态为待配送（WAIT_DELIVERY），可先用 queryDeliveryStatus 查询状态',
      };
    }
  }
}
