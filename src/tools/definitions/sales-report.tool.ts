/**
 * salesReport 工具 — 销售报表（只读）
 *
 * 用途：查询销售日报/趋势报表，支持按日期范围、门店筛选。
 * 适合"本月销售报表""昨天的销售情况"等场景。
 *
 * 对应后端 API：
 * - GET /api/admin/reports/sales-daily?dateStart=&dateEnd=&storeId=（销售日报）
 * - GET /api/admin/reports/sales-trend?granularity=month|week|day（销售趋势）
 * 后端路由：report.routes.ts（prefix: /api/admin/reports）
 *
 * 销售日报返回：按日期分组的销售汇总（销售额、订单量、客单价等）
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

/** 销售日报单项（按日期分组） */
interface SalesDailyItem {
  date: string;
  salesAmount?: number;
  orderCount?: number;
  customerCount?: number;
  avgOrderValue?: number;
  [key: string]: unknown;
}

/** 销售日报返回 */
interface SalesDailyResult {
  list?: SalesDailyItem[];
  records?: SalesDailyItem[];
  totalSales?: number;
  totalOrders?: number;
  [key: string]: unknown;
}

@Injectable()
export class SalesReportTool implements ITool {
  private readonly logger = new Logger(SalesReportTool.name);

  readonly name = 'salesReport';
  readonly description =
    '销售报表（只读）：按日期范围查询销售日报（销售额、订单量、客单价等），' +
    '支持指定门店。也可用 granularity=day|week|month 查询销售趋势。' +
    '适合"本月销售报表""昨天的销售情况"等场景。' +
    '示例参数：{"reportType":"daily","dateStart":"2026-07-01","dateEnd":"2026-07-31"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      reportType: {
        type: 'string',
        enum: ['daily', 'trend'],
        description: '报表类型：daily=销售日报（默认）、trend=销售趋势',
      },
      dateStart: {
        type: 'string',
        description: '开始日期（可选，格式 YYYY-MM-DD，daily 报表使用）',
      },
      dateEnd: {
        type: 'string',
        description: '结束日期（可选，格式 YYYY-MM-DD，daily 报表使用）',
      },
      storeId: {
        type: 'number',
        description: '门店ID（可选，daily 报表使用）',
      },
      granularity: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description:
          '趋势粒度（可选，trend 报表使用）：day=按天、week=按周、month=按月（默认）',
      },
    },
    required: [],
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

    const { reportType, dateStart, dateEnd, storeId, granularity } =
      parsed.data;

    try {
      if (reportType === 'trend') {
        const url = `${API_ENDPOINTS.REPORTS}/sales-trend?granularity=${granularity}`;
        const result = await this.serviceClient.get<Record<string, unknown>>(
          url,
          context,
        );
        this.logger.debug(`查询销售趋势报表成功：granularity=${granularity}`);
        return { success: true, data: { reportType: 'trend', ...result } };
      }

      // 销售日报
      const queryParams: string[] = [];
      if (dateStart) queryParams.push(`dateStart=${dateStart}`);
      if (dateEnd) queryParams.push(`dateEnd=${dateEnd}`);
      if (storeId !== undefined) queryParams.push(`storeId=${storeId}`);
      const queryString =
        queryParams.length > 0 ? `?${queryParams.join('&')}` : '';

      const result = await this.serviceClient.get<SalesDailyResult>(
        `${API_ENDPOINTS.REPORTS}/sales-daily${queryString}`,
        context,
      );

      const items = result?.records ?? result?.list ?? [];
      const simplified = items.map((item) => ({
        date: item.date,
        salesAmount: item.salesAmount,
        orderCount: item.orderCount,
        customerCount: item.customerCount,
        avgOrderValue: item.avgOrderValue,
      }));

      this.logger.debug(`查询销售日报成功：返回 ${simplified.length} 条`);

      return {
        success: true,
        data: {
          reportType: 'daily',
          list: simplified,
          totalSales: result?.totalSales,
          totalOrders: result?.totalOrders,
          dateStart,
          dateEnd,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.warn(`查询销售报表失败：${errorMsg}`);
      return {
        success: false,
        error: `查询销售报表失败：${errorMsg}`,
        suggestion: '请确认后端服务是否正常运行，或稍后重试',
      };
    }
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: SalesReportArgs }
    | { valid: false; error: string; suggestion?: string } {
    const reportType = args.reportType === 'trend' ? 'trend' : 'daily';

    let dateStart: string | undefined;
    if (args.dateStart !== undefined) {
      if (
        typeof args.dateStart !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(args.dateStart)
      ) {
        return {
          valid: false,
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
          valid: false,
          error: '参数 dateEnd 格式必须为 YYYY-MM-DD',
          suggestion: '请按 YYYY-MM-DD 格式输入结束日期',
        };
      }
      dateEnd = args.dateEnd;
    }

    let storeId: number | undefined;
    if (args.storeId !== undefined) {
      if (typeof args.storeId !== 'number' || args.storeId <= 0) {
        return {
          valid: false,
          error: '参数 storeId 必须为正整数',
          suggestion: '请确认门店ID',
        };
      }
      storeId = args.storeId;
    }

    const granularity =
      args.granularity === 'day' || args.granularity === 'week'
        ? args.granularity
        : 'month';

    return {
      valid: true,
      data: { reportType, dateStart, dateEnd, storeId, granularity },
    };
  }
}

/** 销售报表参数（解析后） */
interface SalesReportArgs {
  reportType: 'daily' | 'trend';
  dateStart?: string;
  dateEnd?: string;
  storeId?: number;
  granularity: 'day' | 'week' | 'month';
}
