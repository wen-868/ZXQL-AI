/**
 * createSalesReturn 工具 — 创建销售退货单（写操作，含预览机制）
 *
 * 用途：客户退货，创建退货单（草稿/待审核状态），支持关联原销售单。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/sale-returns
 * 后端路由：sale-return.routes.ts（prefix: /api/admin/sale-returns，createSaleReturn）
 * 后端服务：sale-return.service.ts createReturn（生成 TH 开头退货单号）
 *
 * 后端接收字段（以 sale-return.controller.ts createSaleReturn 为准）：
 * - sourceBillNo?: string（可选，关联原销售单号）
 * - storeId: number（必填，门店ID）
 * - customerId?: number（可选，客户ID）
 * - customerName?: string（可选，客户名称）
 * - customerMobile?: string（可选，客户手机号）
 * - discountAmount: number（默认0，优惠金额）
 * - remark?: string（可选）
 * - items: [{ skuId, skuName, boxQty, bottleQty, unitPrice, reason? }]（必填）
 * 返回：{ returnNo }，状态待审核，后续人工审核+退款
 *
 * 单位换算（与后端 sale-return.service.ts 一致）：
 * totalBottleQty = boxQty × 12 + bottleQty（后端固定箱瓶比12，本工具按 productInfo.boxRatio 换算展示，
 * 但请求体仅传 boxQty/bottleQty，由后端按 12 换算——以实际后端为准）
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/sale-returns 创建退货单
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

/** 退货商品项输入 */
interface ReturnItemInput {
  skuId: number;
  skuName: string;
  boxQty?: number;
  bottleQty?: number;
  unitPrice: number;
  reason?: string;
}

/** 后端创建退货单返回 */
interface CreateReturnResult {
  returnNo: string;
  [key: string]: unknown;
}

@Injectable()
export class CreateSalesReturnTool implements ITool {
  private readonly logger = new Logger(CreateSalesReturnTool.name);

  readonly name = 'createSalesReturn';
  readonly description =
    '创建销售退货单（写操作，需用户确认）：客户退货时创建退货单，可关联原销售单。' +
    '需指定门店、退货商品（SKU+数量+单价）、可关联原销售单号。' +
    '首次调用 confirm=false 生成预览（含商品明细、退货数量、退款金额），' +
    '用户确认后 confirm=true 正式创建退货单（待审核状态，后续由人工审核和退款）。' +
    '示例参数：{"storeId":1,"customerName":"红星商行","items":[{"skuId":10,"skuName":"五粮液 500ml","boxQty":2,"unitPrice":850}],"confirm":false}';
  readonly category = 'finance' as const;
  readonly isWriteOperation = true;
  readonly requiredTools = ['searchProduct'];

  readonly parameters = {
    type: 'object' as const,
    properties: {
      sourceBillNo: {
        type: 'string',
        description: '关联原销售单号（可选）',
      },
      storeId: {
        type: 'number',
        description: '门店ID（必填，正整数）',
      },
      customerId: {
        type: 'number',
        description: '客户ID（可选）',
      },
      customerName: {
        type: 'string',
        description: '客户名称（可选）',
      },
      customerMobile: {
        type: 'string',
        description: '客户手机号（可选）',
      },
      discountAmount: {
        type: 'number',
        description: '优惠金额（可选，默认0）',
      },
      remark: {
        type: 'string',
        description: '备注（可选）',
      },
      items: {
        type: 'array',
        description: '退货商品明细列表（必填）',
        items: {
          type: 'object',
          properties: {
            skuId: {
              type: 'number',
              description: 'SKU ID（从 searchProduct 获取）',
            },
            skuName: { type: 'string', description: 'SKU名称（必填）' },
            boxQty: { type: 'number', description: '退货箱数（可选）' },
            bottleQty: { type: 'number', description: '退货瓶数（可选）' },
            unitPrice: {
              type: 'number',
              description: '退货单价（必填，大于0）',
            },
            reason: { type: 'string', description: '退货原因（可选）' },
          },
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['storeId', 'items'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }

    const returnArgs = parsed.data;
    const confirm = returnArgs.confirm === true;

    // ── 2. 计算商品合计 ──
    const processedItems = returnArgs.items.map((item) => {
      const totalBottleQty = (item.boxQty ?? 0) * 12 + (item.bottleQty ?? 0);
      const subtotal = totalBottleQty * item.unitPrice;
      return {
        skuId: item.skuId,
        skuName: item.skuName,
        boxQty: item.boxQty ?? 0,
        bottleQty: item.bottleQty ?? 0,
        totalBottleQty,
        unitPrice: item.unitPrice,
        reason: item.reason,
        subtotal,
      };
    });

    const goodsAmount = processedItems.reduce(
      (sum, item) => sum + item.subtotal,
      0,
    );
    const discountAmount = returnArgs.discountAmount ?? 0;
    const refundAmount = goodsAmount - discountAmount;

    // ── 3. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        sourceBillNo: returnArgs.sourceBillNo,
        storeId: returnArgs.storeId,
        customerName: returnArgs.customerName,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          totalBottleQty: item.totalBottleQty,
          unitPrice: item.unitPrice,
          subtotal: item.subtotal,
        })),
        goodsAmount,
        discountAmount,
        refundAmount,
      };

      this.logger.log(
        `生成销售退货预览：${processedItems.length} 种商品 退款 ${refundAmount.toFixed(2)} 元`,
      );

      return {
        success: true,
        preview: {
          operation: '创建销售退货单',
          summary:
            `退货 ${processedItems.length} 种商品，退款 ${refundAmount.toFixed(2)} 元` +
            (returnArgs.sourceBillNo
              ? `（关联销售单 ${returnArgs.sourceBillNo}）`
              : ''),
          details: previewDetails,
        },
      };
    }

    // ── 4. 执行阶段：调用后端创建退货单 ──
    try {
      const requestBody = {
        sourceBillNo: returnArgs.sourceBillNo,
        storeId: returnArgs.storeId,
        customerId: returnArgs.customerId,
        customerName: returnArgs.customerName,
        customerMobile: returnArgs.customerMobile,
        discountAmount: returnArgs.discountAmount ?? 0,
        remark: returnArgs.remark,
        items: processedItems.map((item) => ({
          skuId: item.skuId,
          skuName: item.skuName,
          boxQty: item.boxQty,
          bottleQty: item.bottleQty,
          unitPrice: item.unitPrice,
          reason: item.reason,
        })),
      };

      const result = await this.serviceClient.post<CreateReturnResult>(
        API_ENDPOINTS.SALE_RETURNS,
        requestBody,
        context,
      );

      this.logger.log(`销售退货单创建成功：returnNo=${result.returnNo}`);

      return {
        success: true,
        data: {
          returnNo: result.returnNo,
          itemCount: processedItems.length,
          goodsAmount,
          discountAmount,
          refundAmount,
          message: `退货单 ${result.returnNo} 创建成功（待审核），退款 ${refundAmount.toFixed(2)} 元`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建销售退货单失败：${errorMsg}`);
      return {
        success: false,
        error: `创建销售退货单失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，检查门店ID和商品信息是否正确',
      };
    }
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateSalesReturnArgs }
    | { valid: false; error: string; suggestion?: string } {
    const storeId = args.storeId;
    if (typeof storeId !== 'number' || storeId <= 0) {
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请确认门店ID',
      };
    }

    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) {
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请至少传入一个退货商品项',
      };
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i] as Record<string, unknown>;
      if (typeof item.skuId !== 'number' || item.skuId <= 0) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 skuId 必须为正整数`,
          suggestion: '请先调用 searchProduct 获取商品的 skuId',
        };
      }
      if (typeof item.skuName !== 'string' || item.skuName.length === 0) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 skuName 必须为非空字符串`,
          suggestion: '请传入商品名称',
        };
      }
      if (
        (typeof item.boxQty !== 'number' || item.boxQty <= 0) &&
        (typeof item.bottleQty !== 'number' || item.bottleQty <= 0)
      ) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品必须指定 boxQty 或 bottleQty（至少一个大于0）`,
          suggestion: '请传入退货箱数(boxQty)或瓶数(bottleQty)',
        };
      }
      if (typeof item.unitPrice !== 'number' || item.unitPrice <= 0) {
        return {
          valid: false,
          error: `第 ${i + 1} 个商品的 unitPrice 必须为大于 0 的数字`,
          suggestion: '请传入退货单价',
        };
      }
    }

    return {
      valid: true,
      data: {
        sourceBillNo:
          typeof args.sourceBillNo === 'string' ? args.sourceBillNo : undefined,
        storeId,
        customerId:
          typeof args.customerId === 'number' ? args.customerId : undefined,
        customerName:
          typeof args.customerName === 'string' ? args.customerName : undefined,
        customerMobile:
          typeof args.customerMobile === 'string'
            ? args.customerMobile
            : undefined,
        discountAmount:
          typeof args.discountAmount === 'number' ? args.discountAmount : 0,
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        items: items as ReturnItemInput[],
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }
}

/** 创建销售退货单参数（解析后） */
interface CreateSalesReturnArgs {
  sourceBillNo?: string;
  storeId: number;
  customerId?: number;
  customerName?: string;
  customerMobile?: string;
  discountAmount?: number;
  remark?: string;
  items: ReturnItemInput[];
  confirm: boolean;
}
