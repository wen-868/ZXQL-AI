/**
 * api_create_purchase_plan 工具 — 创建采购计划（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/purchase-plans
 * 后端路由：purchase-plan.routes.ts（prefix: /api/admin/purchase-plans）
 * 后端服务：purchase-plan.service.ts createPurchasePlan（生成 DRAFT 计划单）
 * 入参：supplierId、storeId、items: [{ skuId, suggestQty }]（建议采购量）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式创建。
 * 建议与 api_suggest_purchase_plan（智能补货建议）配合使用。
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

interface PlanItem {
  skuId: number;
  skuName?: string;
  suggestQty: number;
}

interface CreatePlanArgs {
  supplierId: number;
  storeId: number;
  items: PlanItem[];
  confirm?: boolean;
}

@Injectable()
export class CreatePurchasePlanTool implements ITool {
  private readonly logger = new Logger(CreatePurchasePlanTool.name);

  readonly name = 'api_create_purchase_plan';
  readonly description =
    '创建采购计划（写操作，需用户确认）：按商品建议采购量生成采购计划草稿。' +
    '入参：supplierId(供应商ID)、storeId(门店ID)、items([{skuId, suggestQty}])。' +
    '可先调用 api_suggest_purchase_plan 获取补货建议。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: { type: 'number', description: '供应商ID（必填）' },
      storeId: { type: 'number', description: '入库门店ID（必填）' },
      items: {
        type: 'array',
        description: '采购明细（必填）',
        items: {
          type: 'object',
          properties: {
            skuId: { type: 'number', description: 'SKU ID' },
            skuName: { type: 'string', description: 'SKU名称（预览展示用）' },
            suggestQty: { type: 'number', description: '建议采购量' },
          },
          required: ['skuId', 'suggestQty'],
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['supplierId', 'storeId', 'items'],
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
    const totalQty = a.items.reduce((sum, it) => sum + it.suggestQty, 0);

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '创建采购计划',
          summary:
            `向供应商 #${a.supplierId} 制定采购计划：` +
            `${a.items.length} 种商品，合计建议采购 ${totalQty} 件`,
          details: {
            supplierId: a.supplierId,
            storeId: a.storeId,
            items: a.items.map((it) => ({
              skuId: it.skuId,
              skuName: it.skuName ?? `SKU#${it.skuId}`,
              suggestQty: it.suggestQty,
            })),
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.PURCHASE_PLANS,
        {
          supplierId: a.supplierId,
          storeId: a.storeId,
          items: a.items.map((it) => ({
            skuId: it.skuId,
            suggestQty: it.suggestQty,
          })),
        },
        context,
      );
      this.logger.log(
        `创建采购计划成功：供应商#${a.supplierId} ${a.items.length} 种商品`,
      );
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建采购计划失败：${msg}`);
      return {
        success: false,
        error: `创建采购计划失败：${msg}`,
        suggestion: '请确认供应商/门店ID与商品明细后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreatePlanArgs }
    | { valid: false; error: string; suggestion?: string } {
    const supplierId = Number(args.supplierId);
    const storeId = Number(args.storeId);
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      return {
        valid: false,
        error: '参数 supplierId 必须为正整数',
        suggestion: '请提供供应商ID',
      };
    }
    if (!Number.isInteger(storeId) || storeId <= 0) {
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请提供门店ID',
      };
    }
    if (!Array.isArray(args.items) || args.items.length === 0) {
      return {
        valid: false,
        error: '参数 items 必须为非空数组',
        suggestion: '请提供采购明细',
      };
    }
    const items: PlanItem[] = [];
    for (const raw of args.items) {
      const it = (raw ?? {}) as Record<string, unknown>;
      const skuId = Number(it.skuId);
      const suggestQty = Number(it.suggestQty);
      if (!Number.isInteger(skuId) || skuId <= 0) {
        return {
          valid: false,
          error: 'items[].skuId 必须为正整数',
          suggestion: '请检查采购明细',
        };
      }
      if (!Number.isInteger(suggestQty) || suggestQty <= 0) {
        return {
          valid: false,
          error: 'items[].suggestQty 必须为正整数',
          suggestion: '请检查建议采购量',
        };
      }
      items.push({
        skuId,
        skuName: typeof it.skuName === 'string' ? it.skuName : undefined,
        suggestQty,
      });
    }
    return {
      valid: true,
      data: { supplierId, storeId, items, confirm: args.confirm === true },
    };
  }
}
