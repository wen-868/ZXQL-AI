/**
 * stockCheck 工具 — 库存盘点（写操作，含预览机制）
 *
 * 用途：按门店（仓库）创建盘点单（草稿），用于核对系统账面库存与实际库存的差异。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/stock-checks
 * 后端路由：stock-check.routes.ts（prefix: /api/admin/stock-checks）
 * 后端服务：stock-check.service.ts createCheck（写入 t_stock_check，状态 DRAFT）
 *
 * 后端接收字段（以 stock-check.controller.ts adminStockCheck.create 为准）：
 * - storeId: number（必填，正整数）
 * - remark: string（可选，默认 ""）
 * 返回：{ checkId, checkNo }，状态 DRAFT（草稿）
 *
 * 注意：创建盘点单时后端不接收商品明细（items）。创建后需人工调用
 * POST /api/admin/stock-checks/:id/start 开始盘点，此时系统按 t_inventory_batch
 * 自动生成盘点明细（含各批次系统账面数量），再人工录入实际数量并完成。
 * 本工具的 items 参数（商品+账面数量）仅作为预览参考展示，不传给后端。
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/stock-checks 创建盘点单
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

/** 盘点预期商品项输入（仅用于预览参考，不传给后端） */
interface StockCheckItemInput {
  skuId: number;
  skuName?: string;
  /** 账面数量（预期盘点数量，仅参考） */
  bookQty?: number;
}

/** 后端创建盘点单返回 */
interface CreateCheckResult {
  checkId: number;
  checkNo: string;
  [key: string]: unknown;
}

@Injectable()
export class StockCheckTool implements ITool {
  private readonly logger = new Logger(StockCheckTool.name);

  readonly name = 'stockCheck';
  readonly description =
    '库存盘点（写操作，需用户确认）：按门店（仓库）创建盘点单，用于核对账面库存与实际库存差异。' +
    '首次调用 confirm=false 生成预览（含盘点门店、备注、预期商品清单），' +
    '用户确认后 confirm=true 正式创建盘点单（草稿状态）。' +
    '创建后由人工开始盘点（系统按库存批次自动生成明细）、录入实际数量并完成，' +
    '差异部分可选择调整库存。' +
    '示例参数：{"storeId":1,"remark":"月度盘点","items":[{"skuId":101,"skuName":"五粮液 500ml","bookQty":200}],"confirm":false}';
  readonly category = 'inventory' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      storeId: {
        type: 'number',
        description: '盘点门店ID（必填，正整数）',
      },
      remark: {
        type: 'string',
        description: '盘点备注（可选，如"月度盘点"）',
      },
      items: {
        type: 'array',
        description:
          '预期盘点商品清单（可选，仅用于预览展示；创建后明细由系统按库存批次自动生成）',
        items: {
          type: 'object',
          properties: {
            skuId: { type: 'number', description: 'SKU ID' },
            skuName: { type: 'string', description: 'SKU名称' },
            bookQty: { type: 'number', description: '账面数量' },
          },
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['storeId'],
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

    const checkArgs = parsed.data;
    const confirm = checkArgs.confirm === true;

    // ── 2. 预览阶段 ──
    if (!confirm) {
      const previewDetails: Record<string, unknown> = {
        storeId: checkArgs.storeId,
        remark: checkArgs.remark ?? '',
        items:
          checkArgs.items.length > 0
            ? checkArgs.items.map((item) => ({
                skuId: item.skuId,
                skuName: item.skuName ?? `SKU-${item.skuId}`,
                bookQty: item.bookQty,
              }))
            : undefined,
        itemCount: checkArgs.items.length,
      };

      this.logger.log(
        `生成盘点单预览：storeId=${checkArgs.storeId} ` +
          `${checkArgs.items.length} 种预期商品`,
      );

      return {
        success: true,
        preview: {
          operation: '创建盘点单',
          summary:
            `对门店 ${checkArgs.storeId} 创建盘点单` +
            (checkArgs.items.length > 0
              ? `（预期 ${checkArgs.items.length} 种商品）`
              : '') +
            '，创建后明细由系统按库存批次自动生成',
          details: previewDetails,
        },
      };
    }

    // ── 3. 执行阶段：调用后端创建盘点单 ──
    try {
      const requestBody = {
        storeId: checkArgs.storeId,
        remark: checkArgs.remark ?? '',
      };

      const result = await this.serviceClient.post<CreateCheckResult>(
        API_ENDPOINTS.STOCK_CHECKS,
        requestBody,
        context,
      );

      this.logger.log(
        `盘点单创建成功：checkNo=${result.checkNo} checkId=${result.checkId}`,
      );

      return {
        success: true,
        data: {
          checkId: result.checkId,
          checkNo: result.checkNo,
          storeId: checkArgs.storeId,
          status: 'DRAFT',
          message: `盘点单 ${result.checkNo} 创建成功（草稿状态，请开始盘点后按实际数量录入并完成）`,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建盘点单失败：${errorMsg}`);
      return {
        success: false,
        error: `创建盘点单失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，检查门店ID是否正确',
      };
    }
  }

  // ── 私有方法 ──

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: StockCheckArgs }
    | { valid: false; error: string; suggestion?: string } {
    const storeId = args.storeId;
    if (typeof storeId !== 'number' || storeId <= 0) {
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请确认要盘点的门店ID',
      };
    }

    // 校验 items（可选）
    let items: StockCheckItemInput[] = [];
    if (args.items !== undefined) {
      if (!Array.isArray(args.items)) {
        return {
          valid: false,
          error: '参数 items 必须为数组',
          suggestion: '请传入预期盘点商品清单，或省略该参数',
        };
      }
      for (let i = 0; i < args.items.length; i++) {
        const item = args.items[i] as Record<string, unknown>;
        if (typeof item.skuId !== 'number' || item.skuId <= 0) {
          return {
            valid: false,
            error: `第 ${i + 1} 个商品的 skuId 必须为正整数`,
            suggestion: '请确认预期盘点商品的 skuId',
          };
        }
      }
      items = args.items as StockCheckItemInput[];
    }

    return {
      valid: true,
      data: {
        storeId,
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        items,
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }
}

/** 盘点参数（解析后） */
interface StockCheckArgs {
  storeId: number;
  remark?: string;
  items: StockCheckItemInput[];
  confirm: boolean;
}
