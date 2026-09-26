/**
 * 意图识别 → 工具分类单元测试
 *
 * 覆盖 detectIntentCategories：
 * - 库存意图 → inventory/product
 * - 销售意图 → order/customer/product/inventory/delivery
 * - 营销意图 → marketing/product
 * - 综合/无命中 → undefined（回退全量）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import {
  buildLlmClassifierPrompt,
  detectIntentCategories,
  resolveIntentCategories,
} from './intent-detector';
import type { ToolCategory } from '../tools/tool.interface';

describe('detectIntentCategories（意图驱动工具减负）', () => {
  it('库存查询意图命中 inventory+product', () => {
    const cats = detectIntentCategories('查询一下五粮液的库存');
    expect(cats).toContain('inventory');
    expect(cats).toContain('product');
    expect(cats).not.toContain('order');
  });

  it('销售开单意图命中 order 域组', () => {
    const cats = detectIntentCategories('给红星商行送10箱五粮液');
    expect(cats).toContain('order');
    expect(cats).toContain('customer');
  });

  it('营销意图命中 marketing+product', () => {
    const cats = detectIntentCategories('创建一个满100减10的优惠券活动');
    expect(cats).toContain('marketing');
    expect(cats).toContain('product');
  });

  it('采购意图命中 purchase', () => {
    const cats = detectIntentCategories('给五粮液补货，找供应商进货');
    expect(cats).toContain('purchase');
  });

  it('无命中（日常寒暄）回退 undefined 走全量工具', () => {
    expect(detectIntentCategories('你好，今天天气不错')).toBeUndefined();
  });

  it('空消息回退 undefined', () => {
    expect(detectIntentCategories('  ')).toBeUndefined();
  });

  it('口语化库存说法（有没有货/还剩）命中 inventory', () => {
    expect(detectIntentCategories('五粮液还有没有货')).toContain('inventory');
    expect(detectIntentCategories('仓库里还剩多少五粮液')).toContain(
      'inventory',
    );
  });

  it('口语化开单（来点/拿几）命中 order', () => {
    expect(detectIntentCategories('来点五粮液')).toContain('order');
    expect(detectIntentCategories('拿几箱茅台')).toContain('order');
  });

  it('业绩口语（这月卖了）命中 report', () => {
    expect(detectIntentCategories('这月卖了多少钱')).toContain('report');
  });
});

describe('resolveIntentCategories（意图分诊双通道）', () => {
  it('规则命中 → 快车道返回且不调 LLM', async () => {
    const classifier = jest.fn();
    const result = await resolveIntentCategories(
      '查询一下五粮液的库存',
      classifier,
    );
    expect(result.lane).toBe('rules');
    expect(result.categories).toContain('inventory');
    expect(classifier).not.toHaveBeenCalled();
  });

  it('规则未命中 + LLM 返回合法域 → LLM 通道采纳（并做枚举过滤）', async () => {
    const classifier = jest
      .fn()
      .mockResolvedValue(['inventory', 'bogus_domain', 'report']);
    const result = await resolveIntentCategories(
      '那个酒最近表现咋样啊',
      classifier,
    );
    expect(result.lane).toBe('llm');
    expect(result.categories).toEqual(['inventory', 'report']);
  });

  it('LLM 超时/异常 → 回退全量（fallback）', async () => {
    const classifier = jest.fn().mockRejectedValue(new Error('llm down'));
    const result = await resolveIntentCategories(
      '这个月整体做得好不好啊',
      classifier,
    );
    expect(result.lane).toBe('fallback');
    expect(result.categories).toBeUndefined();
  });

  it('LLM 返回空数组 → 回退全量（保守兜底）', async () => {
    const classifier = jest.fn().mockResolvedValue([]);
    const result = await resolveIntentCategories(
      '帮我想想该怎么办',
      classifier,
    );
    expect(result.lane).toBe('fallback');
    expect(result.categories).toBeUndefined();
  });

  it('LLM 返回 none（纯寒暄）→ chat 车道（零工具直答）', async () => {
    const classifier = jest.fn().mockResolvedValue(['none']);
    const result = await resolveIntentCategories('给我讲个笑话吧', classifier);
    expect(result.lane).toBe('chat');
    expect(result.categories).toEqual([]);
  });

  it('缓存：同消息第二次直接命中（不重复调 LLM，lane 一并命中）', async () => {
    const classifier = jest.fn().mockResolvedValue(['none']);
    const msg = '今天天气真不错啊';
    const first = await resolveIntentCategories(msg, classifier);
    const second = await resolveIntentCategories(msg, classifier);
    expect(first.lane).toBe('chat');
    expect(second.lane).toBe('chat');
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it('buildLlmClassifierPrompt：包含 none 指引与全部业务域', () => {
    const prompt = buildLlmClassifierPrompt('查五粮液库存');
    expect(prompt).toContain('"none"');
    expect(prompt).toContain('纯寒暄');
    (['order', 'inventory', 'finance', '查五粮液库存'] as const).forEach(
      (frag) => expect(prompt).toContain(frag),
    );
  });

  it('缓存：同消息第二次直接命中（不重复调 LLM）', async () => {
    const classifier = jest.fn().mockResolvedValue(['finance']);
    const msg = '外头没收上来的款项大概什么状况啊';
    const first = await resolveIntentCategories(msg, classifier);
    const second = await resolveIntentCategories(msg, classifier);
    expect(first.lane).toBe('llm');
    expect(second.categories).toEqual(first.categories);
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it('缓存：fallback（全量回退）消息同样命中缓存（回归：undefined 值曾被误判未命中）', async () => {
    const classifier = jest.fn().mockResolvedValue([]);
    // 注意：分诊缓存是模块级共享，每条测试消息必须全局唯一（否则命中前测缓存）
    const msg = '帮我把这段话润色一下再发出去';
    const first = await resolveIntentCategories(msg, classifier);
    // 前提：该消息确实走 fallback 车道（若关键词表扩充命中需换测试短语）
    expect(first.lane).toBe('fallback');
    await resolveIntentCategories(msg, classifier);
    expect(classifier).toHaveBeenCalledTimes(1); // 修复前：每次都重调
    const second = await resolveIntentCategories(msg, classifier);
    expect(second.lane).toBe('fallback');
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it('buildLlmClassifierPrompt：包含全部业务域与用户消息', () => {
    const prompt = buildLlmClassifierPrompt('查五粮液库存');
    (
      ['order', 'inventory', 'finance', 'report', '查五粮液库存'] as const
    ).forEach((frag) => expect(prompt).toContain(frag));
    expect(prompt).toContain('JSON');
  });

  it('分类结果均为合法 ToolCategory', async () => {
    const all: ToolCategory[] = [
      'order',
      'inventory',
      'product',
      'customer',
      'purchase',
      'delivery',
      'finance',
      'report',
      'marketing',
      'platform',
      'system',
      'utility',
    ];
    const valid = new Set(all);
    // 末尾混入非法值 'x'，验证分诊器只保留合法 ToolCategory
    const classifier = jest.fn().mockResolvedValue([...all, 'x']);
    const result = await resolveIntentCategories(
      '帮我全面看看生意',
      classifier,
    );
    expect(result.categories!.every((c) => valid.has(c))).toBe(true);
    expect(result.categories!.length).toBeLessThanOrEqual(4);
  });
});
