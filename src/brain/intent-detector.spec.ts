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
import { detectIntentCategories } from './intent-detector';

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
