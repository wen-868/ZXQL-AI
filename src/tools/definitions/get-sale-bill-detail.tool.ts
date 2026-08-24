/**
 * getSaleBillDetail 工具 — 查询销售单详情
 *
 * 用途：按单号查询销售单详情（含商品明细、收款信息）。
 * LLM 在用户询问"XX单的详情"、"XX单包含什么"时调用。
 *
 * 对应后端 API：
 * - GET /api/store/sale-bills/:billNo（门店销售单详情）
 * - GET /api/admin/orders/:orderNo（订单详情，含商品明细+操作日志）
 *
 * 后端路由：
 * - store-sale-bill.routes.ts（prefix: /api/store）
 * - admin-order.routes.ts（prefix: /api/admin）
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

@Injectable()
export class GetSaleBillDetailTool implements ITool {
  private readonly logger = new Logger(GetSaleBillDetailTool.name);

  readonly name = 'getSaleBillDetail';
  readonly description =
    '查询销售单详情（按单号）。' +
    '返回销售单完整信息，包含单号、客户信息、商品明细（SKU/数量/单价/小计）、收款状态、创建时间。' +
    '支持两种单号格式：销售单号（SB开头）和订单号（ORD开头），工具会自动识别。' +
    '示例：用户说"SB20260801001的详情"→ 调用此工具 → 返回完整单据信息。';
  readonly category = 'order' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      billNo: {
        type: 'string',
        description: '销售单号或订单号（必填）',
      },
    },
    required: ['billNo'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const billNo = args.billNo;
    if (typeof billNo !== 'string' || billNo.length === 0) {
      return {
        success: false,
        error: '参数 billNo 必须为非空字符串',
        suggestion: '请传入销售单号或订单号',
      };
    }

    try {
      // 根据单号前缀决定调用哪个接口
      const isOrderNo = billNo.toUpperCase().startsWith('ORD');
      const endpoint = isOrderNo
        ? `${API_ENDPOINTS.ORDERS}/${encodeURIComponent(billNo)}`
        : `${API_ENDPOINTS.STORE_SALE_BILLS}/${encodeURIComponent(billNo)}`;

      const result = await this.serviceClient.get<Record<string, unknown>>(
        endpoint,
        context,
      );

      if (!result) {
        return {
          success: false,
          error: `单号 ${billNo} 不存在`,
          suggestion:
            '请确认单号是否正确，可用 querySaleBills 工具查询单号列表',
        };
      }

      this.logger.debug(
        `查询单据详情：${billNo}（${isOrderNo ? '订单' : '销售单'}）`,
      );

      return {
        success: true,
        data: {
          billNo,
          type: isOrderNo ? 'order' : 'saleBill',
          ...result,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询单据详情失败：${errorMsg}`);
      return {
        success: false,
        error: `查询单据 ${billNo} 详情失败：${errorMsg}`,
        suggestion: '请确认单号是否正确，或用 querySaleBills 工具查询单号列表',
      };
    }
  }
}
