/**
 * api_create_purchase_return 工具 — 创建采购退货单（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/purchase-returns
 * 后端服务：purchase-return.service.ts create（字段 snake_case）
 * 入参：supplierId、supplierName、storeId、orderNo(原采购单,可选)、
 *       items: [{ skuId, skuName, boxQty?, bottleQty?, unitPrice, taxRate?, reason? }]
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式创建。
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

interface ReturnItem {
  sku_id: number;
  sku_name: string;
  box_qty?: number;
  bottle_qty?: number;
  unit_price: number;
  tax_rate?: number;
  reason?: string;
}

interface CreateReturnArgs {
  order_no?: string;
  stock_no?: string;
  supplier_id: number;
  supplier_name: string;
  store_id: number;
  remark?: string;
  items: ReturnItem[];
  confirm?: boolean;
}

@Injectable()
export class CreatePurchaseReturnTool implements ITool {
  private readonly logger = new Logger(CreatePurchaseReturnTool.name);

  readonly name = 'api_create_purchase_return';
  readonly description =
    '创建采购退货单（写操作，需用户确认）：向供应商退回商品，支持箱/瓶数量。' +
    '入参：supplierId、supplierName、storeId、items([{skuId,skuName,boxQty,bottleQty,unitPrice}])、' +
    'orderNo(原采购单,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: { type: 'number', description: '供应商ID（必填）' },
      supplierName: { type: 'string', description: '供应商名称（必填）' },
      storeId: { type: 'number', description: '退货门店ID（必填）' },
      orderNo: { type: 'string', description: '原采购单号（可选）' },
      items: {
        type: 'array',
        description: '退货明细（必填）',
        items: {
          type: 'object',
          properties: {
            skuId: { type: 'number', description: 'SKU ID' },
            skuName: { type: 'string', description: 'SKU名称' },
            boxQty: { type: 'number', description: '箱数（可选）' },
            bottleQty: { type: 'number', description: '瓶数（可选）' },
            unitPrice: { type: 'number', description: '单价' },
            reason: { type: 'string', description: '退货原因（可选）' },
          },
          required: ['skuId', 'skuName', 'unitPrice'],
        },
      },
      remark: { type: 'string', description: '备注（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['supplierId', 'supplierName', 'storeId', 'items'],
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
    const itemCount = a.items.length;
    const totalQty = a.items.reduce(
      (sum, it) => sum + (it.box_qty ?? 0) + (it.bottle_qty ?? 0),
      0,
    );

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '创建采购退货单',
          summary:
            `向${a.supplier_name}退货 ${itemCount} 种商品（合计 ${totalQty} 件），` +
            `门店 #${a.store_id}`,
          details: {
            supplierId: a.supplier_id,
            supplierName: a.supplier_name,
            storeId: a.store_id,
            orderNo: a.order_no ?? '',
            items: a.items.map((it) => ({
              skuId: it.sku_id,
              skuName: it.sku_name,
              boxQty: it.box_qty ?? 0,
              bottleQty: it.bottle_qty ?? 0,
              unitPrice: it.unit_price,
              reason: it.reason ?? '',
            })),
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.PURCHASE_RETURNS,
        {
          order_no: a.order_no ?? null,
          stock_no: a.stock_no ?? null,
          supplier_id: a.supplier_id,
          supplier_name: a.supplier_name,
          store_id: a.store_id,
          remark: a.remark ?? null,
          items: a.items,
        },
        context,
      );
      this.logger.log(
        `创建采购退货单成功：${a.supplier_name} ${itemCount} 种商品`,
      );
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建采购退货单失败：${msg}`);
      return {
        success: false,
        error: `创建采购退货单失败：${msg}`,
        suggestion: '请确认供应商/商品明细后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateReturnArgs }
    | { valid: false; error: string; suggestion?: string } {
    const supplier_id = Number(args.supplierId);
    const store_id = Number(args.storeId);
    if (!Number.isInteger(supplier_id) || supplier_id <= 0)
      return {
        valid: false,
        error: '参数 supplierId 必须为正整数',
        suggestion: '请提供供应商ID',
      };
    if (!Number.isInteger(store_id) || store_id <= 0)
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请提供门店ID',
      };
    const supplier_name = args.supplierName;
    if (typeof supplier_name !== 'string' || supplier_name.trim().length === 0)
      return {
        valid: false,
        error: '参数 supplierName 必填',
        suggestion: '请提供供应商名称',
      };
    if (!Array.isArray(args.items) || args.items.length === 0)
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请提供退货明细',
      };
    const items: ReturnItem[] = [];
    for (const raw of args.items) {
      const it = (raw ?? {}) as Record<string, unknown>;
      const sku_id = Number(it.skuId);
      const unit_price = Number(it.unitPrice);
      if (!Number.isInteger(sku_id) || sku_id <= 0)
        return {
          valid: false,
          error: 'items[].skuId 必须为正整数',
          suggestion: '请检查退货明细',
        };
      if (!Number.isFinite(unit_price) || unit_price < 0)
        return {
          valid: false,
          error: 'items[].unitPrice 必须为不小于 0 的数字',
          suggestion: '请检查单价',
        };
      const box_qty = it.boxQty === undefined ? undefined : Number(it.boxQty);
      const bottle_qty =
        it.bottleQty === undefined ? undefined : Number(it.bottleQty);
      if (box_qty !== undefined && (!Number.isInteger(box_qty) || box_qty < 0))
        return {
          valid: false,
          error: 'items[].boxQty 必须为不小于 0 的整数',
          suggestion: '请检查箱数',
        };
      if (
        bottle_qty !== undefined &&
        (!Number.isInteger(bottle_qty) || bottle_qty < 0)
      )
        return {
          valid: false,
          error: 'items[].bottleQty 必须为不小于 0 的整数',
          suggestion: '请检查瓶数',
        };
      if ((box_qty ?? 0) + (bottle_qty ?? 0) <= 0)
        return {
          valid: false,
          error: 'items[].boxQty/bottleQty 至少一个大于 0',
          suggestion: '请检查退货数量',
        };
      items.push({
        sku_id,
        sku_name: typeof it.skuName === 'string' ? it.skuName : `SKU#${sku_id}`,
        box_qty,
        bottle_qty,
        unit_price,
        tax_rate: it.taxRate === undefined ? undefined : Number(it.taxRate),
        reason: typeof it.reason === 'string' ? it.reason : undefined,
      });
    }
    return {
      valid: true,
      data: {
        order_no:
          typeof args.orderNo === 'string' && args.orderNo
            ? args.orderNo
            : undefined,
        stock_no:
          typeof args.stockNo === 'string' && args.stockNo
            ? args.stockNo
            : undefined,
        supplier_id,
        supplier_name: supplier_name.trim(),
        store_id,
        remark:
          typeof args.remark === 'string' && args.remark
            ? args.remark
            : undefined,
        items,
        confirm: args.confirm === true,
      },
    };
  }
}
