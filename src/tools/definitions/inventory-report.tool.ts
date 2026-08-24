/**
 * inventoryReport 工具 — 库存报表（只读）
 *
 * 用途：查询库存汇总报表，支持按商品/门店分组。
 * 适合"库存报表""哪些商品库存高/低"等场景。
 *
 * 对应后端 API：GET /api/admin/reports/inventory-summary?groupBy=product|store&storeId=
 * 后端路由：report.routes.ts（prefix: /api/admin/reports，inventory-summary）
 * 后端服务：product-report.service.ts getInventorySummary
 *
 * 返回：按商品或门店分组的库存汇总（SKU数量、库存量、成本金额等）
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

@Injectable()
export class InventoryReportTool implements ITool {
  private readonly logger = new Logger(InventoryReportTool.name);

  readonly name = 'inventoryReport';
  readonly description =
    '库存报表（只读）：查询库存汇总报表，按商品或门店分组，' +
    '返回库存量、成本金额、SKU 数量等汇总信息。' +
    '适合"库存报表""各门店库存情况"等场景。' +
    '示例参数：{"groupBy":"product"}、{"groupBy":"store","storeId":1}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      groupBy: {
        type: 'string',
        enum: ['product', 'store'],
        description: '分组维度：product=按商品（默认）、store=按门店',
      },
      storeId: {
        type: 'number',
        description: '门店ID（可选，按门店分组时可用）',
      },
    },
    required: [],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const groupBy = args.groupBy === 'store' ? 'store' : 'product';
    let storeId: number | undefined;
    if (args.storeId !== undefined) {
      if (typeof args.storeId !== 'number' || args.storeId <= 0) {
        return {
          success: false,
          error: '参数 storeId 必须为正整数',
          suggestion: '请确认门店ID',
        };
      }
      storeId = args.storeId;
    }

    try {
      const queryParams = [`groupBy=${groupBy}`];
      if (storeId !== undefined) queryParams.push(`storeId=${storeId}`);
      const queryString = queryParams.join('&');

      const result = await this.serviceClient.get<Record<string, unknown>>(
        `${API_ENDPOINTS.REPORTS}/inventory-summary?${queryString}`,
        context,
      );

      this.logger.debug(
        `查询库存报表成功：groupBy=${groupBy}${storeId !== undefined ? ` storeId=${storeId}` : ''}`,
      );

      return {
        success: true,
        data: { groupBy, storeId, ...result },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询库存报表失败：${errorMsg}`);
      return {
        success: false,
        error: `查询库存报表失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }
}
