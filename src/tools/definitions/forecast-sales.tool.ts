/**
 * forecastSales 工具 — 销售预测（只读；R101-AI-32/33 ③）
 *
 * 用途：依据**历史销售趋势**预测未来 1~3 期（同环比外推 + 移动平均，**不上 ML**，可解释优先）。
 *
 * 对应后端 API：`GET /api/admin/reports/sales-trend?granularity=day|week|month`
 * （`API_ENDPOINTS.REPORTS` + `/sales-trend`；后端 report.routes.ts）
 *
 * 纪律（业主裁定：读全自动、写全审核；统计=AI 工具族走 ToolExecutor 治理链）：
 * 1. **读工具**：`isWriteOperation=false` ⇒ 不进写审核门、不耗幂等键、限流走读宽桶
 * 2. **不冒充真值**：返回必带 `disclaimer`（显式标注"预测"+"置信度"）
 * 3. **历史不足不硬给数字**：`historyUsed < 3` ⇒ 明确拒绝（`success:false` + 建议）
 * 4. `execute` **禁抛异常**：所有错误经 `ToolResult` 返回
 *
 * 本轮范围：`dimension` 固定 `overall`（真接口只有整体趋势）；MS 的按 SKU/分类/客户序列接口
 * 就位后再扩展分支——**不提前做半截**。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 历史期（归一后） */
interface HistoryPoint {
  period: string;
  value: number;
}

/** 被剔除的异常期（促销尖峰等） */
interface ExcludedOutlier {
  period: string;
  value: number;
  reason: string;
}

/** 预测点 */
interface ForecastPoint {
  period: string;
  lower: number;
  central: number;
  upper: number;
  confidence: number;
}

/** 维度（R101-AI-34 P0-1：MS 冻结契约 sales-series 的维度 + overall=整体） */
type ForecastDimension =
  'overall' | 'product' | 'sku' | 'category' | 'customer';

const DIMENSIONS: readonly ForecastDimension[] = [
  'overall',
  'product',
  'sku',
  'category',
  'customer',
];

/** 解析后的入参 */
interface ForecastArgs {
  dimension: ForecastDimension;
  /** dimension !== 'overall' 时必填（MS 契约） */
  targetId?: number;
  granularity: 'day' | 'week' | 'month';
  periods: number;
  historyPeriods: number;
}

const GRANULARITIES = ['day', 'week', 'month'] as const;
const DEFAULT_HISTORY_PERIODS = 12;
const MAX_PERIODS = 3;
/** 历史期下限：< 3 期无法估计趋势与波动（红线：不硬给数字） */
const MIN_HISTORY_USED = 3;

@Injectable()
export class ForecastSalesTool implements ITool {
  private readonly logger = new Logger(ForecastSalesTool.name);

  readonly name = 'forecastSales';
  readonly description =
    '销售预测（只读）：基于**历史销售趋势**预测未来 1~3 期销售额（同环比外推 + 移动平均，' +
    '会先剔除促销尖峰等异常期）。返回预测区间（lower/central/upper）与置信度，' +
    '并**必带**"历史依据"与"非实际发生值"声明。' +
    '适合"预测下个月销量/销售额""下个季度大概能卖多少"等场景。' +
    '注意：历史数据少于 3 期时会明确拒绝（不给不可靠数字）。' +
    '示例参数：{"granularity":"month","periods":2,"historyPeriods":12}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      dimension: {
        type: 'string',
        enum: [...DIMENSIONS],
        description:
          '预测维度（可选，默认 overall）：overall=整体销售额、product=按商品、sku=按SKU、category=按分类、customer=按客户',
      },
      targetId: {
        type: 'integer',
        description:
          '维度目标 ID（dimension 非 overall 时**必填**；如 product/sku/category/customer 的对应 ID）',
      },
      granularity: {
        type: 'string',
        enum: [...GRANULARITIES],
        description:
          '预测粒度（可选，默认 month）：day=按日、week=按周、month=按月',
      },
      periods: {
        type: 'integer',
        description: '预测期数（可选，默认 1，**上限 3**）',
      },
      historyPeriods: {
        type: 'integer',
        description: '使用的历史期数（可选，默认 12）',
      },
    },
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
    const { dimension, targetId, granularity, periods, historyPeriods } =
      parsed.data;

    let history: HistoryPoint[];
    try {
      history = await this.fetchHistory(
        dimension,
        targetId,
        granularity,
        context,
      );
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(`销售序列取数失败：${errorMsg}`);
      return {
        success: false,
        error: `销售预测取数失败：${errorMsg}`,
        suggestion:
          '请确认后端 /api/admin/sale-bills/sales-series 可用，或稍后重试',
      };
    }

    const used = history.slice(-historyPeriods);
    if (used.length < MIN_HISTORY_USED) {
      // 红线：历史不足 ⇒ 明确拒绝，不硬给数字
      return {
        success: false,
        error: `历史数据不足：仅 ${used.length} 期可用（至少需 ${MIN_HISTORY_USED} 期）`,
        suggestion:
          '请先积累至少 3 期销售数据后再预测，或改用 salesReport 查看已有报表',
      };
    }

    const { cleaned, excludedOutliers } = excludeOutliers(used);
    if (cleaned.length < MIN_HISTORY_USED) {
      return {
        success: false,
        error: `剔除异常期后有效历史不足：仅 ${cleaned.length} 期`,
        suggestion: '异常期占比过高，暂无法给出可靠预测',
      };
    }

    const growthRate = avgGrowth(cleaned);
    const lastValue = movingAverage(cleaned, 3);
    const residuals = cleaned
      .slice(1)
      .map((p, i) => p.value - cleaned[i].value);
    const volatility = std(residuals);
    const forecast: ForecastPoint[] = [];
    for (let k = 1; k <= periods; k += 1) {
      const central = round2(lastValue * Math.pow(1 + growthRate, k));
      const spread = volatility * Math.sqrt(k) * 1.28; // ≈80% 区间
      const confidence = round2(
        Math.min(
          0.95,
          Math.max(
            0.3,
            0.9 - 0.15 * (k - 1) - (lastValue > 0 ? volatility / lastValue : 0),
          ),
        ),
      );
      forecast.push({
        period: nextPeriodLabel(
          cleaned[cleaned.length - 1].period,
          granularity,
          k,
        ),
        lower: round2(Math.max(0, central - spread)),
        central,
        upper: round2(central + spread),
        confidence,
      });
    }

    const topConfidence = Math.round(forecast[0].confidence * 100);
    return {
      success: true,
      data: {
        granularity,
        forecast,
        basis: {
          historyUsed: cleaned.length,
          growthRate: round4(growthRate),
          excludedOutliers,
        },
        // 纪律：必须标注"预测"不冒充真值（同 S3-98）
        disclaimer: `本结果为基于历史数据的预测，非实际发生值（置信度 ${topConfidence}%）`,
      },
    };
  }

  /**
   * 取**按维度销售序列**（R101-AI-34 P0-1 真源）
   *
   * `GET /api/admin/sale-bills/sales-series?dimension=&targetId=&granularity=`
   * 出参按期序列 `[{ period, qty, amount, orderCount }]`；本工具预测**销售额**口径 ⇒ 取 `amount`。
   * ⚠️ **不得**用 `qty`（销量）冒充 `amount`（销售额）：口径混淆会给出无提示的错误预测。
   */
  private async fetchHistory(
    dimension: ForecastDimension,
    targetId: number | undefined,
    granularity: ForecastArgs['granularity'],
    context: ToolContext,
  ): Promise<HistoryPoint[]> {
    const query: string[] = [
      `dimension=${encodeURIComponent(dimension)}`,
      `granularity=${encodeURIComponent(granularity)}`,
    ];
    // overall = 整体，不传 targetId（MS 契约）
    if (dimension !== 'overall' && targetId !== undefined) {
      query.push(`targetId=${targetId}`);
    }
    const result = await this.serviceClient.get<Record<string, unknown>>(
      `${API_ENDPOINTS.SALE_BILLS}/sales-series?${query.join('&')}`,
      context,
    );
    const rawList = pickArray(result);
    return rawList
      .map((item, index) => {
        const record = item as Record<string, unknown>;
        const period = this.toStringValue(
          record.period ?? record.date ?? record.month ?? record.label,
          `#${index + 1}`,
        );
        // 销售额口径：amount 优先，兼容旧字段名；**不含 qty**（销量≠销售额）
        const value = Number(
          record.amount ??
            record.salesAmount ??
            record.totalSales ??
            record.total ??
            record.value ??
            0,
        );
        return { period, value: Number.isFinite(value) ? value : 0 };
      })
      .filter((p) => p.value > 0);
  }

  /**
   * 安全取字符串：仅 string / number 直接转，其余（对象、undefined、null）回落
   *
   * 为什么不能直接 `String(unknown)`：lint 的 no-base-to-string 会报"对象将被格式化为
   * [object Object]"——后端返回的 period/date 字段形态不固定（可能是对象），
   * 显式收窄既过 lint 也避免真出现 `[object Object]` 标签。
   */
  private toStringValue(value: unknown, fallback: string): string {
    if (typeof value === 'string') {
      return value.trim().length > 0 ? value : fallback;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
    return fallback;
  }

  /** 入参解析（缺省值 + 上限校验） */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: ForecastArgs }
    | { valid: false; error: string; suggestion: string } {
    // 维度（R101-AI-34 P0-1）：overall 之外**必须**带 targetId（MS 契约）
    const dimension = this.toStringValue(
      args.dimension,
      'overall',
    ) as ForecastDimension;
    if (!DIMENSIONS.includes(dimension)) {
      return {
        valid: false,
        error: `dimension 非法：${this.toStringValue(args.dimension, 'undefined')}`,
        suggestion: `dimension 仅支持 ${DIMENSIONS.join(' / ')}`,
      };
    }
    let targetId: number | undefined;
    if (dimension !== 'overall') {
      const rawTarget = args.targetId;
      const parsedTarget = Number(rawTarget);
      if (
        rawTarget === undefined ||
        !Number.isInteger(parsedTarget) ||
        parsedTarget <= 0
      ) {
        return {
          valid: false,
          error: `dimension=${dimension} 时必须提供 targetId（正整数），当前：${this.toStringValue(rawTarget, '未提供')}`,
          suggestion:
            '请先查询目标对象 ID（如 searchProduct 取 skuId/productId）后再预测',
        };
      }
      targetId = parsedTarget;
    }

    const rawGranularity = args.granularity;
    const granularity = this.toStringValue(
      rawGranularity,
      'month',
    ) as ForecastArgs['granularity'];
    if (!GRANULARITIES.includes(granularity)) {
      return {
        valid: false,
        error: `granularity 非法：${String(rawGranularity)}`,
        suggestion: `granularity 仅支持 ${GRANULARITIES.join(' / ')}`,
      };
    }

    const periods = args.periods === undefined ? 1 : Number(args.periods);
    if (!Number.isInteger(periods) || periods < 1 || periods > MAX_PERIODS) {
      return {
        valid: false,
        error: `periods 非法：${String(args.periods)}（须为 1~${MAX_PERIODS} 的整数）`,
        suggestion: `预测期数上限为 ${MAX_PERIODS}`,
      };
    }

    const historyPeriods =
      args.historyPeriods === undefined
        ? DEFAULT_HISTORY_PERIODS
        : Number(args.historyPeriods);
    if (!Number.isInteger(historyPeriods) || historyPeriods < 1) {
      return {
        valid: false,
        error: `historyPeriods 非法：${String(args.historyPeriods)}（须为正整数）`,
        suggestion: `historyPeriods 建议使用缺省 ${DEFAULT_HISTORY_PERIODS}`,
      };
    }

    return {
      valid: true,
      data: { dimension, targetId, granularity, periods, historyPeriods },
    };
  }
}

/** 从后端返回里提取序列数组（兼容 list/records/data/trend 多种形态） */
function pickArray(result: Record<string, unknown>): unknown[] {
  for (const key of ['list', 'records', 'data', 'trend', 'items']) {
    const value = result[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * 剔除异常期（促销尖峰）：|值 − 中位数| > 2 × MAD
 *
 * MAD = 各期与中位数之差的绝对值的中位数；MAD 为 0（序列极稳）时不做剔除。
 */
function excludeOutliers(points: HistoryPoint[]): {
  cleaned: HistoryPoint[];
  excludedOutliers: ExcludedOutlier[];
} {
  const values = points.map((p) => p.value);
  const median = medianOf(values);
  const deviation = values.map((v) => Math.abs(v - median));
  const mad = medianOf(deviation);
  if (mad === 0) {
    return { cleaned: points, excludedOutliers: [] };
  }
  const cleaned: HistoryPoint[] = [];
  const excludedOutliers: ExcludedOutlier[] = [];
  for (const point of points) {
    if (Math.abs(point.value - median) > 2 * mad) {
      excludedOutliers.push({
        period: point.period,
        value: point.value,
        reason: '偏离中位数超过 2×MAD（疑似促销尖峰等异常期）',
      });
    } else {
      cleaned.push(point);
    }
  }
  return { cleaned, excludedOutliers };
}

/** 平均环比增速（在**已清洗**序列上计算） */
function avgGrowth(points: HistoryPoint[]): number {
  const rates: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1].value;
    if (prev > 0) {
      rates.push((points[i].value - prev) / prev);
    }
  }
  if (rates.length === 0) return 0;
  const total = rates.reduce((sum, r) => sum + r, 0);
  const avg = total / rates.length;
  // 增速收敛：避免极端值把预测放大到离谱（可解释优先）
  return Math.max(-0.5, Math.min(0.5, avg));
}

/** 末段移动平均（window 默认 3；不足则取全部） */
function movingAverage(points: HistoryPoint[], window: number): number {
  const slice = points.slice(Math.max(0, points.length - window));
  return slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function std(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

/** 下一期标签（月/周/日；解析失败则回退为 `<上期>+k`） */
function nextPeriodLabel(
  lastPeriod: string,
  granularity: ForecastArgs['granularity'],
  k: number,
): string {
  const monthMatch = /^(\d{4})-(\d{2})$/.exec(lastPeriod);
  if (monthMatch) {
    const base = new Date(
      Number(monthMatch[1]),
      Number(monthMatch[2]) - 1 + k,
      1,
    );
    return `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`;
  }
  const dayMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(lastPeriod);
  if (dayMatch) {
    const base = new Date(
      Number(dayMatch[1]),
      Number(dayMatch[2]) - 1,
      Number(dayMatch[3]),
    );
    base.setDate(base.getDate() + (granularity === 'week' ? 7 * k : k));
    return base.toISOString().slice(0, 10);
  }
  return `${lastPeriod}+${k}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
