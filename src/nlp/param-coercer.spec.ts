/**
 * LLM 参数自纠错单元测试
 *
 * 覆盖 coerceParam / toPositiveInt / toNonNegativeNumber。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import {
  coerceParam,
  toPositiveInt,
  toNonNegativeNumber,
} from './param-coercer';

describe('param-coercer（LLM 参数自纠错）', () => {
  it('数字字符串转 number', () => {
    expect(coerceParam<number>('10', 'number')).toBe(10);
    expect(coerceParam<number>('10.5', 'number')).toBe(10.5);
    expect(coerceParam<number>(' 3 ', 'number')).toBe(3);
  });

  it('中文数字转 number', () => {
    expect(coerceParam<number>('五', 'number')).toBe(5);
    expect(coerceParam<number>('十', 'number')).toBe(10);
  });

  it('布尔字符串转 boolean', () => {
    expect(coerceParam<boolean>('true', 'boolean')).toBe(true);
    expect(coerceParam<boolean>('是', 'boolean')).toBe(true);
    expect(coerceParam<boolean>('否', 'boolean')).toBe(false);
  });

  it('toPositiveInt 拒绝非正整数', () => {
    expect(toPositiveInt('5')).toBe(5);
    expect(toPositiveInt(0)).toBeUndefined();
    expect(toPositiveInt('-1')).toBeUndefined();
    expect(toPositiveInt('abc')).toBeUndefined();
  });

  it('toNonNegativeNumber 接受 0 与小数', () => {
    expect(toNonNegativeNumber('0')).toBe(0);
    expect(toNonNegativeNumber('12.5')).toBe(12.5);
    expect(toNonNegativeNumber(-1)).toBeUndefined();
  });
});
