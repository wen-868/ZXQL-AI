/**
 * AnalyzePriceTrendTool — 价格走势分析（只读）· R101-AI-33
 *
 * 数据链路「统计 → 分析 → 建议」段：基于【商品价格历史序列】分析价格走势
 * （方向 / 涨跌幅 / 波动区间 / 调价次数），并给出自然语言结论与风险提示。
 *
 * ⚠️ 数据源（2026-10-15 起为**真实接口**，MS 冻结契约 S3-204）：
 *   - `GET /api/admin/products/:skuId/price-history`（priceLevel/start/end 可选，租户隔离）
 *   - 改价落库：`t_product_price_log`（MS 已存在；任何改价都落历史：旧值/新值/时间/操作人/来源）
 *   - **AI 改价必须传 `source:'ai'`**（见 updateProductPrice；否则历史记成 admin，"AI 可追溯"失效）
 *   - **不自建价格表**：价格业务真源在管理系统，AI 侧只消费接口（哪端数据归哪端）。
 *
 * 红线：
 *   1. 读工具（`isWriteOperation=false`）⇒ 读全自动：不进写全审核门、不耗幂等键
 *   2. **execute 禁抛异常** ⇒ 统一返回 ToolResult（success:false + 提示）
 *   3. 空序列 / 数据不足 ⇒ 明确提示（不硬给结论）
 *   4. 当前售价 < 进价 ⇒ 引用 AI-18 的亏损警告语义
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 价格等级（与 updateProductPrice 的口径对齐） */
const PRICE_LEVELS = [
  'retail',
  'wholesale',
  'store',
  'purchase',
  'miniapp',
] as const;
const PRICE_LEVEL_LABELS: Record<string, string> = {
  retail: '零售价',
  wholesale: '批发价',
  store: '门店价',
  purchase: '进价',
  miniapp: '小程序价',
};
/** 序列点数下限：< 2 点无法判断方向 */
const MIN_SERIES_POINTS = 2;

interface PricePoint {
  date: string;
  priceLevel: string;
  price: number;
}

@Injectable()
export class AnalyzePriceTrendTool implements ITool {
  private readonly logger = new Logger(AnalyzePriceTrendTool.name);

  readonly name = 'analyzePriceTrend';
  readonly description =
    '价格走势分析（只读）：按 SKU/商品分析指定价格等级在一段时间内的价格走势，' +
    '返回序列、走势方向（涨/跌/平）、涨跌幅、波动区间、调价次数，' +
    '并给出自然语言结论（如"近 90 天零售价 3 次上调，累计 +12%"）。' +
    '若当前售价低于进价，会给出亏损风险提示。' +
    '适合"五粮液最近价格走势""这个商品调过几次价"等场景。' +
    '示例参数：{"skuId":10,"priceLevel":"retail","start":"2026-07-01","end":"2026-09-30"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      skuId: { type: 'number', description: 'SKU ID（与 productId 二选一）' },
      productId: {
        type: 'number',
        description: '商品 SPU ID（与 skuId 二选一）',
      },
      priceLevel: {
        type: 'string',
        enum: [...PRICE_LEVELS],
        description:
          '价格等级（可选，不传=全部）：retail零售 / wholesale批发 / store门店 / purchase进价 / miniapp小程序',
      },
      start: { type: 'string', description: '开始日期（可选，YYYY-MM-DD）' },
      end: { type: 'string', description: '结束日期（可选，YYYY-MM-DD）' },
    },
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── ① 入参校验：必须指定商品 ──
    const skuId = this.toNumber(args.skuId);
    const productId = this.toNumber(args.productId);
    if (skuId === null && productId === null) {
      return {
        success: false,
        error: '缺少商品标识：请提供 skuId 或 productId',
        suggestion: '先用 searchProduct 查到商品，再传入其 skuId 或 productId',
      };
    }

    const rawLevel = args.priceLevel;
    const priceLevel =
      typeof rawLevel === 'string' && PRICE_LEVELS.includes(rawLevel as never)
        ? rawLevel
        : null;

    // ── ② 取序列（真源：MS 价格历史接口；异常由 catch 统一转 success:false） ──
    // ⚠️ series 恒为【同一价格等级】的序列；进价单独取（purchasePrice）用于亏损比较，
    //    不混入序列（否则 last 会被取成进价本身，方向/风险判断都会错）
    let fetched: { series: PricePoint[]; purchasePrice?: number };
    try {
      fetched = await this.fetchPriceSeries(
        {
          skuId,
          productId,
          priceLevel,
          start: typeof args.start === 'string' ? args.start : undefined,
          end: typeof args.end === 'string' ? args.end : undefined,
        },
        context,
      );
    } catch (err) {
      // 红线：execute 禁抛异常 ⇒ 真源失败统一转 success:false（含字段级细节见 BridgeError）
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.error(`价格历史取数失败：${errorMsg}`);
      return {
        success: false,
        error: `价格走势取数失败：${errorMsg}`,
        suggestion: '请确认后端价格历史接口可用，或稍后重试',
      };
    }
    const { series, purchasePrice } = fetched;

    if (series.length === 0) {
      return {
        success: false,
        error: '未获取到该商品的价格历史序列',
        suggestion:
          '可能原因：①管理系统尚未提供价格历史接口（需求已提交，由业主中转排期）；' +
          '②该时间段内无调价记录。请稍后重试或换一个时间范围',
      };
    }

    if (series.length < MIN_SERIES_POINTS) {
      return {
        success: false,
        error: `价格序列仅 ${series.length} 个点，不足以判断走势方向（至少需要 ${MIN_SERIES_POINTS} 个）`,
        suggestion: '请扩大时间范围后重试',
        data: { series },
      };
    }

    // ── ③ 走势计算（按价格等级分组，取第一个/指定等级） ──
    const level = series[0].priceLevel;
    const prices = series.map((p) => p.price);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const change = this.round2(last - first);
    const changeRate =
      first !== 0 ? this.round2(((last - first) / first) * 100) : 0;

    let direction: 'up' | 'down' | 'flat' = 'flat';
    if (change > 0) direction = 'up';
    else if (change < 0) direction = 'down';

    // 调价次数：相邻不同价才计数
    let changeCount = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] !== prices[i - 1]) changeCount++;
    }

    // ── ④ 自然语言结论 ──
    const levelLabel = PRICE_LEVEL_LABELS[level] ?? level;
    const dirText =
      direction === 'up' ? '上调' : direction === 'down' ? '下调' : '持平';
    const insight =
      `近 ${series.length} 个记录${levelLabel}${dirText}，` +
      (direction === 'flat'
        ? '价格未发生变化'
        : `从 ${first} 到 ${last}（${change > 0 ? '+' : ''}${change}，` +
          `${changeRate > 0 ? '+' : ''}${changeRate}%），期间共调价 ${changeCount} 次`);

    // ── ⑤ 亏损风险提示（AI-18 同口径）：当前售价 < 进价 ──
    const warnings: string[] = [];
    if (
      purchasePrice !== undefined &&
      level !== 'purchase' &&
      last < purchasePrice
    ) {
      warnings.push(
        `⚠️ 当前${levelLabel}（${last}）低于进价（${purchasePrice}），` +
          '按此价格销售将产生亏损，请确认是否为促销或录入错误',
      );
    }

    return {
      success: true,
      data: {
        series,
        trend: {
          direction,
          from: first,
          to: last,
          change,
          changeRate,
          min,
          max,
          volatilityRange: this.round2(max - min),
          changeCount,
        },
        insight,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };
  }

  /**
   * 取价格历史序列 + 进价
   *
   * ⚠️ series 恒为【同一价格等级】的序列；进价单独取（purchasePrice）用于亏损比较，
   *    不混入序列（否则 last 会被取成进价本身，方向/风险判断都会错）。
   */
  private async fetchPriceSeries(
    params: {
      skuId: number | null;
      productId: number | null;
      priceLevel: string | null;
      start?: string;
      end?: string;
    },
    context: ToolContext,
  ): Promise<{ series: PricePoint[]; purchasePrice?: number }> {
    // R101-AI-34 P0-2：**切真源**（S3-204 交付的 MS 端点）
    //   GET /api/admin/products/:skuId/price-history?priceLevel=&start=&end=
    // mock 分支已删除；不可用时由 execute 的 catch 统一转 success:false（execute 禁抛）。
    const skuId = params.skuId ?? params.productId;
    if (skuId === null) {
      return { series: [] };
    }
    const query = buildQueryString({
      priceLevel: params.priceLevel,
      start: params.start,
      end: params.end,
    });
    const payload = await this.serviceClient.get<Record<string, unknown>>(
      `${API_ENDPOINTS.PRODUCTS}/${skuId}/price-history${query}`,
      context,
    );

    const allPoints = normalizePricePoints(payload);
    // ⚠️ series 恒为【同一价格等级】；进价**单独取**（不混入序列，否则 last 会变成进价本身）
    const series = params.priceLevel
      ? allPoints.filter((p) => p.priceLevel === params.priceLevel)
      : allPoints.filter((p) => p.priceLevel === 'retail');

    return { series, purchasePrice: resolvePurchasePrice(payload, allPoints) };
  }

  /** 安全取数字 */
  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim().length > 0) {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }
}

/** 构造查询串（只含显式提供的参数） */
function buildQueryString(params: {
  priceLevel?: string | null;
  start?: string;
  end?: string;
}): string {
  const parts: string[] = [];
  if (params.priceLevel) {
    parts.push(`priceLevel=${encodeURIComponent(params.priceLevel)}`);
  }
  if (params.start) parts.push(`start=${encodeURIComponent(params.start)}`);
  if (params.end) parts.push(`end=${encodeURIComponent(params.end)}`);
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * 归一后端价格历史序列（R101-AI-34 P0-2 真源）
 *
 * 兼容 `list/records/data/history/items` 多种包裹形态与常见字段名；
 * 仅保留可解析出正数价格的记录（其余丢弃，避免污染走势）。
 */
function normalizePricePoints(payload: Record<string, unknown>): PricePoint[] {
  let raw: unknown[] = [];
  for (const key of ['list', 'records', 'data', 'history', 'items']) {
    const value = payload[key];
    if (Array.isArray(value)) {
      raw = value;
      break;
    }
  }

  const points: PricePoint[] = [];
  raw.forEach((item, index) => {
    const record = item as Record<string, unknown>;
    const dateCandidate =
      record.date ??
      record.effectiveFrom ??
      record.effectiveDate ??
      record.createdAt ??
      record.time;
    const date =
      typeof dateCandidate === 'string'
        ? dateCandidate.slice(0, 10)
        : `#${index + 1}`;
    const levelCandidate = record.priceLevel ?? record.level ?? record.type;
    const priceLevel =
      typeof levelCandidate === 'string' ? levelCandidate : 'retail';
    const price = Number(record.price ?? record.value ?? record.amount);
    if (Number.isFinite(price) && price > 0) {
      points.push({ date, priceLevel, price });
    }
  });
  return points;
}

/**
 * 进价**单独取**（不混入分析序列）
 *
 * 优先 `payload.purchasePrice`；否则取 priceLevel=purchase 序列的最新一条。
 */
function resolvePurchasePrice(
  payload: Record<string, unknown>,
  allPoints: PricePoint[],
): number | undefined {
  const direct = Number(payload.purchasePrice);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const purchasePoints = allPoints
    .filter((p) => p.priceLevel === 'purchase')
    .sort((a, b) => a.date.localeCompare(b.date));
  return purchasePoints.length > 0
    ? purchasePoints[purchasePoints.length - 1].price
    : undefined;
}
