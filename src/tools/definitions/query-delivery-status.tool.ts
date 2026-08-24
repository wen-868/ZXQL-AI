/**
 * queryDeliveryStatus 工具 — 查询配送状态（只读）
 *
 * 用途：按订单号查询配送状态，返回订单的配送进度、收货人信息。
 *
 * 对应后端 API：GET /api/store/orders/:orderNo
 * 后端路由：store-order.routes.ts（prefix: /api/store，getOrderDetail）
 * 后端服务：order.service.ts getOrderDetail（查询 t_miniapp_order + t_miniapp_order_item）
 *
 * 返回结构（以 order.service.ts getOrderDetail 为准）：
 * { orderNo, storeId, customerType, fulfillmentType, orderStatus, payStatus,
 *   payableAmount, receiverName, receiverMobile, receiverAddress, createdAt, items: [...] }
 *
 * 订单状态（orderStatus）→ 配送状态映射：
 * - WAIT_ACCEPT：待接单
 * - ACCEPTED：已接单（待出库）
 * - WAIT_DELIVERY：待配送（已出库）
 * - DELIVERING：配送中
 * - COMPLETED：已送达（完成）
 * - REJECTED：已拒收
 * - CANCELLED：已取消
 *
 * 注意：订单为即时零售线上订单（t_miniapp_order），不是销售单（sale_bill）。
 * 查询销售单用 querySaleBills/getSaleBillDetail，查询配送状态用本工具。
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

/** 后端返回的订单详情（getOrderDetail） */
interface OrderDetail {
  orderNo: string;
  storeId: number;
  customerType: string;
  fulfillmentType: string;
  orderStatus: string;
  payStatus: string;
  payableAmount: number;
  receiverName: string | null;
  receiverMobile: string | null;
  receiverAddress: string | null;
  createdAt: string;
  items?: Array<{
    skuId: number;
    skuName: string;
    quantity: number;
    unitPrice: number;
    subtotalAmount: number;
  }>;
}

/** 订单状态中文标签 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  WAIT_ACCEPT: '待接单',
  ACCEPTED: '已接单（待出库）',
  WAIT_DELIVERY: '待配送（已出库）',
  DELIVERING: '配送中',
  COMPLETED: '已送达（完成）',
  REJECTED: '已拒收',
  CANCELLED: '已取消',
};

@Injectable()
export class QueryDeliveryStatusTool implements ITool {
  private readonly logger = new Logger(QueryDeliveryStatusTool.name);

  readonly name = 'queryDeliveryStatus';
  readonly description =
    '查询配送状态：按订单号查询线上订单（即时零售订单）的配送进度，' +
    '返回配送状态（WAIT_ACCEPT=待接单/ACCEPTED=已接单/WAIT_DELIVERY=待配送/DELIVERING=配送中/COMPLETED=已送达/REJECTED=已拒收/CANCELLED=已取消）、' +
    '订单金额、收货人姓名/电话/地址、下单时间、商品明细。' +
    '适合"SO20260730001送到了吗""这个订单配送状态如何"等场景。' +
    '注意：查询的是线上订单配送状态；查询销售单请用 querySaleBills。' +
    '示例参数：{"orderNo":"SO20260730001"}';
  readonly category = 'delivery' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: {
        type: 'string',
        description: '订单号（必填，如 SO20260730001）',
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
    if (typeof orderNo !== 'string' || orderNo.trim().length === 0) {
      return {
        success: false,
        error: '参数 orderNo 必须为非空字符串',
        suggestion: '请传入订单号（如 SO20260730001）',
      };
    }

    try {
      const detail = await this.serviceClient.get<OrderDetail>(
        `${API_ENDPOINTS.STORE_ORDERS}/${encodeURIComponent(orderNo.trim())}`,
        context,
      );

      if (!detail || typeof detail !== 'object') {
        return {
          success: false,
          error: `查询配送状态失败：订单 ${orderNo} 不存在或后端返回空数据`,
          suggestion: '请确认订单号是否正确',
        };
      }

      const statusLabel =
        ORDER_STATUS_LABELS[detail.orderStatus] ?? detail.orderStatus;

      // 精简返回
      const simplified = {
        orderNo: detail.orderNo,
        orderStatus: detail.orderStatus,
        orderStatusLabel: statusLabel,
        fulfillmentType: detail.fulfillmentType,
        customerType: detail.customerType,
        payStatus: detail.payStatus,
        payableAmount: detail.payableAmount,
        receiverName: detail.receiverName,
        receiverMobile: detail.receiverMobile,
        receiverAddress: detail.receiverAddress,
        createdAt: detail.createdAt,
        items: (detail.items ?? []).map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          subtotalAmount: item.subtotalAmount,
        })),
      };

      this.logger.debug(
        `查询配送状态：orderNo=${detail.orderNo} 状态=${statusLabel}`,
      );

      return {
        success: true,
        data: simplified,
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询配送状态失败：${errorMsg}`);
      return {
        success: false,
        error: `查询配送状态失败：${errorMsg}`,
        suggestion: '请确认订单号是否正确，或后端服务是否正常运行',
      };
    }
  }
}
