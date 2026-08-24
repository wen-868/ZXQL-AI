/**
 * 自然语言解析单元测试
 *
 * 覆盖 parseQuantity（口语数量）与 normalizeProductKeyword（搜索词清洗）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import { parseQuantity, normalizeProductKeyword } from './nl-parser';

describe('parseQuantity（口语数量解析）', () => {
  it('阿拉伯数字+单位', () => {
    expect(parseQuantity('10箱五粮液')).toEqual({
      qty: 10,
      unit: 'box',
      raw: '10箱',
    });
    expect(parseQuantity('5瓶')).toEqual({
      qty: 5,
      unit: 'bottle',
      raw: '5瓶',
    });
  });

  it('中文数字+单位', () => {
    expect(parseQuantity('一箱五粮液')).toEqual({
      qty: 1,
      unit: 'box',
      raw: '一箱',
    });
    expect(parseQuantity('两瓶')).toEqual({
      qty: 2,
      unit: 'bottle',
      raw: '两瓶',
    });
    expect(parseQuantity('十二箱')).toEqual({
      qty: 12,
      unit: 'box',
      raw: '十二箱',
    });
  });

  it('一箱半', () => {
    expect(parseQuantity('一箱半')).toEqual({
      qty: 1.5,
      unit: 'box',
      raw: '一箱半',
    });
  });

  it('模糊量词取大（两三瓶→3瓶）', () => {
    expect(parseQuantity('两三瓶')).toEqual({
      qty: 3,
      unit: 'bottle',
      raw: '两三瓶',
    });
  });

  it('无数量开头返回 null', () => {
    expect(parseQuantity('五粮液')).toBeNull();
  });
});

describe('normalizeProductKeyword（搜索词清洗）', () => {
  it('剥离数量前缀', () => {
    expect(normalizeProductKeyword('10箱五粮液')).toBe('五粮液');
    expect(normalizeProductKeyword('一箱半五粮液')).toBe('五粮液');
  });

  it('剥离动作/引导词前缀', () => {
    expect(normalizeProductKeyword('给我来10箱五粮液')).toBe('五粮液');
    expect(normalizeProductKeyword('查询一下五粮液52度的库存')).toBe(
      '五粮液52度',
    );
    expect(normalizeProductKeyword('有没有五粮液')).toBe('五粮液');
  });

  it('剥离结尾问句助词', () => {
    expect(normalizeProductKeyword('五粮液吗？')).toBe('五粮液');
  });
});
