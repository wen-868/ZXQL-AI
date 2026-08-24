/**
 * profitReport 工具 — 利润报表（只读）
 *
 * 用途：查询利润报表，支持按日期范围筛选。
 * 适合"本月利润""这个季度赚了多少"等场景。
 *
 * 对应后端 API：GET /api/admin/reports/profit?dateStart=&dateEnd=
 * 后端路由：report.routes.ts（prefix: /api/admin/reports，profit）
 * 后端服务：finance-report.service.ts getProfit
 *
 * 返回：利润汇总（销售收入、成本、毛利、毛利率等）
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
export class ProfitReportTool implements ITool {
  private readonly logger = new Logger(ProfitReportTool.name);

  readonly name = 'profitReport';
  readonly description =
    '利润报表（只读）：按日期范围查询经营利润（销售收入、销售成本、毛利、毛利率等）。' +
    '适合"本月利润""这个季度赚了多少"等场景。' +
    '示例参数：{"dateStart":"2026-07-01","dateEnd":"2026-07-31"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      dateStart: {
        type: 'string',
        description: '开始日期（可选，格式 YYYY-MM-DD）',
      },
      dateEnd: {
        type: 'string',
        description: '结束日期（可选，格式 YYYY-MM-DD）',
      },
    },
    required: [],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // 参数校验
    let dateStart: string | undefined;
    if (args.dateStart !== undefined) {
      if (
        typeof args.dateStart !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.dateStart)
      ) {
        return {
          success: false,
          error: '参数 dateStart 格式必须为 YYYY-MM-DD',
          suggestion: '请按 YYYY-MM-DD 格式输入开始日期',
        };
      }
      dateStart = args.dateStart;
    }

    let dateEnd: string | undefined;
    if (args.dateEnd !== undefined) {
      if (
        typeof args.dateEnd !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.dateEnd)
      ) {
        return {
          success: false,
          error: '参数 dateEnd 格式必须为 YYYY-MM-DD',
          suggestion: '请按 YYYY-MM-DD 格式输入结束日期',
        };
      }
      dateEnd = args.dateEnd;
    }

    try {
      const queryParams: string[] = [];
      if (dateStart) queryParams.push(`dateStart=${dateStart}`);
      if (dateEnd) queryParams.push(`dateEnd=${dateEnd}`);
      const queryString =
        queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

      const result = await this.serviceClient.get<Record<string, unknown>>(
        `${API_ENDPOINTS.REPORTS}/profit${queryString}`,
        context,
      );

      this.logger.debug(
        `查询利润报表成功：${dateStart ?? '不限'} 至 ${dateEnd ?? '不限'}`,
      );

      return {
        success: true,
        data: { dateStart, dateEnd, ...result },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询利润报表失败：${errorMsg}`);
      return {
        success: false,
        error: `查询利润报表失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }
}
