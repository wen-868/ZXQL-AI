/**
 * forecastSales 工具测试（R101-AI-32/33 ③）
 *
 * 反测设计原则（凌舟入册口径：**每条都要能回答"功能坏了会红吗"**，不用空转口径）：
 * ① 历史 2 期 ⇒ **明确拒绝**（mutation：去掉 `MIN_HISTORY_USED` 校验 ⇒ 本例会红，因为它会返回 success:true）
 * ② `disclaimer` **必带**且含"预测"与置信度（mutation：去掉 disclaimer ⇒ 本例红）
 * ③ 递升序列 ⇒ 预测中心值递增、`basis.growthRate > 0`（方向一致性）
 * ④ 真接口取数失败 ⇒ `success:false` + 明确提示、**不抛异常**
 * ⑤ 促销尖峰被剔除并记录在 `excludedOutliers`（可解释性）
 * ⑥ `periods` 上限 3（4 ⇒ 参数错误）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { BridgeError, ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { ForecastSalesTool } from './forecast-sales.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

/** 造一个返回固定趋势序列的服务桩 */
function createHarness(series: Array<Record<string, unknown>>) {
  const get = jest.fn(() => Promise.resolve({ list: series }));
  const tool = new ForecastSalesTool({
    get,
  } as unknown as ServiceClient);
  return { tool, get };
}

/** 取 data 的窄视图（ToolResult.data 是 unknown） */
interface ForecastData {
  forecast: Array<{
    period: string;
    lower: number;
    central: number;
    upper: number;
    confidence: number;
  }>;
  basis: {
    historyUsed: number;
    growthRate: number;
    excludedOutliers: Array<{ period: string; value: number }>;
  };
  disclaimer: string;
}

function dataOf(result: { success: boolean; data?: unknown }): ForecastData {
  return result.data as ForecastData;
}

/** 生成 N 期平滑上升序列（无异常期） */
function risingSeries(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    period: `2026-${String(i + 1).padStart(2, '0')}`,
    salesAmount: 1000 + i * 100,
  }));
}

describe('ForecastSalesTool（R101-AI-32/33 ③ 销售预测）', () => {
  it('① 历史不足 3 期 ⇒ 明确拒绝（不硬给数字）', async () => {
    const h = createHarness([
      { period: '2026-01', salesAmount: 1000 },
      { period: '2026-02', salesAmount: 1100 },
    ]);

    const result = await h.tool.execute({ granularity: 'month' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('历史数据不足');
    expect(result.error).toContain('至少需 3 期');
    expect(result.data).toBeUndefined();
  });

  it('② 返回必带 disclaimer（含"预测"与置信度百分比）', async () => {
    const h = createHarness(risingSeries(6));

    const result = await h.tool.execute({ granularity: 'month' }, CTX);

    expect(result.success).toBe(true);
    const disclaimer = dataOf(result).disclaimer;
    expect(disclaimer).toContain('预测');
    expect(disclaimer).toContain('非实际发生值');
    expect(disclaimer).toMatch(/置信度\s*\d+%/);
  });

  it('③ 递升序列 ⇒ 预测中心值递增且 growthRate > 0（方向一致）', async () => {
    const h = createHarness(risingSeries(6));

    const result = await h.tool.execute(
      { granularity: 'month', periods: 3 },
      CTX,
    );

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.basis.growthRate).toBeGreaterThan(0);
    expect(data.forecast).toHaveLength(3);
    expect(data.forecast[0].central).toBeGreaterThan(0);
    expect(data.forecast[1].central).toBeGreaterThan(data.forecast[0].central);
    expect(data.forecast[2].central).toBeGreaterThan(data.forecast[1].central);
    // 区间自洽：lower ≤ central ≤ upper
    for (const point of data.forecast) {
      expect(point.lower).toBeLessThanOrEqual(point.central);
      expect(point.upper).toBeGreaterThanOrEqual(point.central);
      expect(point.confidence).toBeGreaterThan(0);
      expect(point.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('④ 接口失败 ⇒ success:false 明确提示且不抛异常', async () => {
    const get = jest.fn(() =>
      Promise.reject(
        new BridgeError('后端 HTTP 500：报表服务异常', 500, '500'),
      ),
    );
    const tool = new ForecastSalesTool({ get } as unknown as ServiceClient);

    const result = await tool.execute({ granularity: 'month' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('销售预测取数失败');
    expect(result.suggestion).toBeTruthy();
  });

  it('⑤ 促销尖峰被剔除并记录在 excludedOutliers（可解释性）', async () => {
    const series = [
      ...risingSeries(5),
      { period: '2026-06', salesAmount: 999999 }, // 促销尖峰
    ];
    const h = createHarness(series);

    const result = await h.tool.execute({ granularity: 'month' }, CTX);

    expect(result.success).toBe(true);
    const data = dataOf(result);
    expect(data.basis.excludedOutliers).toHaveLength(1);
    expect(data.basis.excludedOutliers[0].period).toBe('2026-06');
    expect(data.basis.excludedOutliers[0].value).toBe(999999);
    // 尖峰未被计入历史
    expect(data.basis.historyUsed).toBe(5);
  });

  it('⑥ periods 上限 3：请求 4 期 ⇒ 参数错误（不硬截断）', async () => {
    const h = createHarness(risingSeries(6));

    const result = await h.tool.execute({ periods: 4 }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('periods 非法');
    expect(h.get).not.toHaveBeenCalled(); // 参数非法时不应发起取数
  });
});
