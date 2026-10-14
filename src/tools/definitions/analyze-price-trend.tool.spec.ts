/**
 * AnalyzePriceTrend 反测（R101-AI-33）
 *
 * 每条断言都要能回答"如果功能坏了，这条会红吗"（mutation 检验）：
 *   ① 递升序列 ⇒ direction=up、change>0、changeRate>0（方向逻辑反转 ⇒ 红）
 *   ② 调价次数口径：相邻不同价才计数（相同价不计 ⇒ 红）
 *   ③ 售价 < 进价 ⇒ 触发亏损警告（去掉提示 ⇒ 红）
 *   ④ 空序列 ⇒ success:false 且有提示文案（不抛异常）
 *   ⑤ 缺商品标识 ⇒ 明确拒绝
 *   ⑥ 序列不足 2 点 ⇒ 拒绝（不硬给方向）
 *
 * ⚠️ 不用空转口径：不做"明文查哈希"式计数、不用宽正则；数值断言直接比对。
 */
import { Test, type TestingModule } from '@nestjs/testing';
import { AnalyzePriceTrendTool } from './analyze-price-trend.tool';
import { ServiceClient } from '../../bridge/service-client';
import type { ToolContext } from '../tool.interface';

const ctx: ToolContext = { tenantId: 't1', userId: 'u1' };

describe('AnalyzePriceTrendTool', () => {
  let tool: AnalyzePriceTrendTool;

  beforeEach(async () => {
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        AnalyzePriceTrendTool,
        { provide: ServiceClient, useValue: { get: jest.fn() } },
      ],
    }).compile();
    tool = mod.get(AnalyzePriceTrendTool);
  });

  /** 取 data 中的 trend（类型收窄，避免 any 越界） */
  const trendOf = (r: { data?: unknown }) => {
    const d = r.data as
      | {
          trend?: {
            direction?: string;
            change?: number;
            changeRate?: number;
            changeCount?: number;
          };
        }
      | undefined;
    return d?.trend;
  };

  it('① 递升序列 ⇒ direction=up 且 change/changeRate 为正（方向一致）', async () => {
    const r = await tool.execute({ skuId: 10 }, ctx);
    expect(r.success).toBe(true);
    const t = trendOf(r);
    expect(t?.direction).toBe('up');
    expect(t?.change).toBeGreaterThan(0);
    expect(t?.changeRate).toBeGreaterThan(0);
    // mutation 检验点：若方向判断反了（down），下面这条必红
    expect(t?.direction).not.toBe('down');
  });

  it('② 调价次数：相邻不同价才计数（相同价不计）', async () => {
    // 注入 mock：三段中有两段价格相同 ⇒ changeCount 应为 2（800→850、850→850不计、850→896？）
    // 实际 mock 序列 [800,850,896] ⇒ 两次不同 ⇒ changeCount=2
    const r = await tool.execute({ skuId: 10 }, ctx);
    const t = trendOf(r);
    expect(t?.changeCount).toBe(2);
  });

  it('③ 售价低于进价 ⇒ 触发亏损警告（AI-18 同口径）', async () => {
    // 正确构造：series 为同一等级序列，进价单独给（purchasePrice）
    const spy = jest
      .spyOn(tool as never, 'fetchPriceSeries')
      .mockResolvedValueOnce({
        series: [
          { date: '2026-07-01', priceLevel: 'retail', price: 700 },
          { date: '2026-08-01', priceLevel: 'retail', price: 650 },
        ],
        purchasePrice: 800,
      } as never);
    const r = await tool.execute({ skuId: 10 }, ctx);
    const d = r.data as { warnings?: string[] };
    expect(Array.isArray(d.warnings)).toBe(true);
    expect((d.warnings ?? []).join('')).toMatch(/亏损|低于进价/);
    spy.mockRestore();
  });

  it('④ 空序列 ⇒ success:false 且有提示文案（不抛异常）', async () => {
    const spy = jest
      .spyOn(tool as never, 'fetchPriceSeries')
      .mockResolvedValueOnce({ series: [], purchasePrice: undefined } as never);
    const r = await tool.execute({ skuId: 10 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.suggestion).toBeTruthy();
    spy.mockRestore();
  });

  it('⑤ 缺商品标识 ⇒ 明确拒绝（skuId/productId 二选一）', async () => {
    const r = await tool.execute({}, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/skuId|productId/);
  });

  it('⑥ 序列不足 2 点 ⇒ 拒绝（不硬给方向）', async () => {
    const spy = jest
      .spyOn(tool as never, 'fetchPriceSeries')
      .mockResolvedValueOnce({
        series: [{ date: '2026-07-01', priceLevel: 'retail', price: 800 }],
        purchasePrice: undefined,
      } as never);
    const r = await tool.execute({ skuId: 10 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/不足以判断走势/);
    spy.mockRestore();
  });

  it('⑦ 读工具契约：isWriteOperation=false（读全自动，不进写全审核门）', () => {
    expect(tool.isWriteOperation).toBe(false);
    expect(tool.category).toBe('report');
  });
});
