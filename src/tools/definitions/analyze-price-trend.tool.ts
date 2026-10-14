/**
 * AnalyzePriceTrendTool — 价格走势分析（只读）· R101-AI-33
 *
 * 数据链路「统计 → 分析 → 建议」段：基于【商品价格历史序列】分析价格走势
 * （方向 / 涨跌幅 / 波动区间 / 调价次数），并给出自然语言结论与风险提示。
 *
 * ⚠️ 数据源现状（2026-10-15）：
 *   - 管理系统**尚无价格历史接口**（价格能力只有写：`updateProductPrice` 改价），
 *     已由业主中转向 MS 线提需求（见 MS 仓
 *     `docs/tasks/cards/跨线协作-MS侧数据接口需求-销售序列与价格历史.md`）。
 *   - 本工具本轮按**契约 mock 序列**实现，真实接口就位后在
 *     `fetchPriceSeries()` 内切真源（替换 mock 分支即可，其余逻辑不变）。
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
import { ServiceClient } from '../../bridge/service-client';

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
    _context: ToolContext,
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

    // ── ② 取序列（真源异步；本轮 mock 同步值经 Promise.resolve 返回，保持链路一致） ──
    // ⚠️ series 恒为【同一价格等级】的序列；进价单独取（purchasePrice）用于亏损比较，
    //    不混入序列（否则 last 会被取成进价本身，方向/风险判断都会错）
    const { series, purchasePrice } = await this.fetchPriceSeries({
      skuId,
      productId,
      priceLevel,
      start: typeof args.start === 'string' ? args.start : undefined,
      end: typeof args.end === 'string' ? args.end : undefined,
    });

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
   * ⚠️ 真实接口未就位 ⇒ 本轮 **同步返回契约 mock**（仅打通链路 + 反测）。
   *    接口就位后：改回 `async` + `await`（调用方同步改），函数体替换为
   *      `await this.serviceClient.get(API_ENDPOINTS.PRICE_HISTORY, {...}, ctx)`
   *    其余（校验 / 走势 / 结论 / 风险提示）逻辑完全复用。
   */
  private async fetchPriceSeries(params: {
    skuId: number | null;
    productId: number | null;
    priceLevel: string | null;
    start?: string;
    end?: string;
  }): Promise<{ series: PricePoint[]; purchasePrice?: number }> {
    // MS 价格历史接口就位前：**契约 mock**（仅打通链路 + 反测）。
    // 真源切换点：见文件头 ⚠️ 数据源现状段（替换本函数体即可，其余逻辑复用）。
    this.logger.warn(
      '价格历史接口（MS 侧）尚未就位：本轮按契约 mock 返回；接口就位后切换真源' +
        `（sku=${params.skuId} spu=${params.productId} level=${params.priceLevel ?? 'all'}）`,
    );
    // TODO(real-api): MS 价格历史接口就位后走这里（见文件头说明）
    // 真源将经 this.serviceClient 调管理系统（与 salesReport 等 59 处调用同范式）：
    //   await this.serviceClient.get(
    //     `${API_ENDPOINTS.PRICE_HISTORY}?skuId=${params.skuId}&level=${params.priceLevel}`,
    //     undefined, ctx);
    // 说明：此刻未调 serviceClient 是因为接口未就位（契约 mock），保留引用以固化切换点。
    void this.serviceClient;

    // ── 契约 mock：同为 retail 的递增序列（用于验证方向/涨跌幅/调价次数） ──
    // 经 Promise.resolve 返回：真源是异步 HTTP，mock 保持同一异步形态（接口切换零改调用方）
    const level = params.priceLevel ?? 'retail';
    return Promise.resolve({
      series: [
        { date: '2026-07-01', priceLevel: level, price: 800 },
        { date: '2026-08-01', priceLevel: level, price: 850 },
        { date: '2026-09-01', priceLevel: level, price: 896 },
      ],
      // 进价（亏损比较基准）：高于当前售价 ⇒ 不触发亏损提示
      purchasePrice: 700,
    });
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
