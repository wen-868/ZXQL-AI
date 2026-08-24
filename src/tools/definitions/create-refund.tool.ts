/**
 * createRefund 工具 — 退货退款（写操作，含预览机制）
 *
 * 用途：对已审核通过的退货单执行退款操作，指定退款方式。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/sale-returns/:returnNo/refund
 * 后端路由：sale-return.routes.ts（prefix: /api/admin/sale-returns，refundSaleReturn）
 * 后端服务：sale-return.service.ts refund
 *
 * 后端接收字段（以 sale-return.controller.ts refundSaleReturn 为准）：
 * - refundMethod: 'CASH' | 'WECHAT' | 'BANK'（必填，退款方式：现金/微信/银行）
 * 返回：{ returnNo, status, ... }
 *
 * 前置条件：退货单状态必须为已审核（APPROVED），否则后端返回 404/400。
 * 执行前建议先调用 getSaleReturnDetail 确认退货单状态。
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/sale-returns/:returnNo/refund
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

/** 后端退款返回 */
interface RefundResult {
  returnNo: string;
  status: string;
  [key: string]: unknown;
}

/** 退款方式中文标签 */
const REFUND_METHOD_LABELS: Record<string, string> = {
  CASH: '现金',
  WECHAT: '微信',
  BANK: '银行转账',
};

@Injectable()
export class CreateRefundTool implements ITool {
  private readonly logger = new Logger(CreateRefundTool.name);

  readonly name = 'createRefund';
  readonly description =
    '退货退款（写操作，需用户确认）：对已审核通过的退货单执行退款，指定退款方式（CASH=现金/WECHAT=微信/BANK=银行转账）。' +
    '必须先确认退货单已审核通过（状态为 APPROVED），否则无法退款。' +
    '首次调用 confirm=false 生成预览（含退货单号、退款方式），' +
    '用户确认后 confirm=true 正式执行退款。' +
    '示例参数：{"returnNo":"TH202608010001","refundMethod":"WECHAT","confirm":false}';
  readonly category = 'finance' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      returnNo: {
        type: 'string',
        description: '退货单号（必填，如 TH202608010001）',
      },
      refundMethod: {
        type: 'string',
        enum: ['CASH', 'WECHAT', 'BANK'],
        description: '退款方式（必填）：CASH=现金、WECHAT=微信、BANK=银行转账',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式退款。默认false）',
      },
    },
    required: ['returnNo', 'refundMethod'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const returnNo = args.returnNo;
    if (typeof returnNo !== 'string' || returnNo.trim().length === 0) {
      return {
        success: false,
        error: '参数 returnNo 必须为非空字符串',
        suggestion: '请传入退货单号（如 TH202608010001）',
      };
    }

    const refundMethod = args.refundMethod;
    if (
      typeof refundMethod !== 'string' ||
      !['CASH', 'WECHAT', 'BANK'].includes(refundMethod)
    ) {
      return {
        success: false,
        error: '参数 refundMethod 必须是 CASH / WECHAT / BANK 之一',
        suggestion: '请指定退款方式（现金/微信/银行转账）',
      };
    }

    const trimmedReturnNo = returnNo.trim();
    const confirm = args.confirm === true;
    const methodLabel = REFUND_METHOD_LABELS[refundMethod] ?? refundMethod;

    // ── 2. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        returnNo: trimmedReturnNo,
        refundMethod,
        refundMethodLabel: methodLabel,
      };

      this.logger.log(
        `生成退货退款预览：returnNo=${trimmedReturnNo} 方式=${methodLabel}`,
      );

      return {
        success: true,
        preview: {
          operation: '退货退款',
          summary: `退货单 ${trimmedReturnNo} 以${methodLabel}方式退款`,
          details: previewDetails,
        },
      };
    }

    // ── 3. 执行阶段：调用后端退款 ──
    try {
      const result = await this.serviceClient.post<RefundResult>(
        `${API_ENDPOINTS.SALE_RETURNS}/${encodeURIComponent(trimmedReturnNo)}/refund`,
        { refundMethod },
        context,
      );

      this.logger.log(
        `退款成功：returnNo=${result.returnNo} 状态=${result.status}`,
      );

      return {
        success: true,
        data: {
          returnNo: result.returnNo,
          status: result.status,
          refundMethod,
          message: `退货单 ${result.returnNo} 已通过${methodLabel}退款`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`退款失败：${errorMsg}`);
      return {
        success: false,
        error: `退款失败：${errorMsg}`,
        suggestion:
          '请确认退货单号正确且退货单已审核通过，可先查询退货单详情确认状态',
      };
    }
  }
}
