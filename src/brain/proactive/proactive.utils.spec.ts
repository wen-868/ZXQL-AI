/**
 * 主动能力工具函数单元测试
 *
 * 覆盖 toNumber / toText / toDateText / toMoneyText 全部分支
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { toDateText, toMoneyText, toNumber, toText } from './proactive.utils';

describe('proactive.utils', () => {
  describe('toNumber', () => {
    it('number 原样返回', () => {
      expect(toNumber(42)).toBe(42);
      expect(toNumber(0)).toBe(0);
      expect(toNumber(-3.14)).toBe(-3.14);
    });

    it('非有限 number 返回兜底值', () => {
      expect(toNumber(Number.NaN)).toBe(0);
      expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
      expect(toNumber(Number.NaN, 9)).toBe(9);
    });

    it('字符串数字可解析时返回数值', () => {
      expect(toNumber('42')).toBe(42);
      expect(toNumber('3.14')).toBe(3.14);
    });

    it('非数字字符串返回兜底值', () => {
      expect(toNumber('abc')).toBe(0);
      expect(toNumber('abc', 7)).toBe(7);
    });

    it('null / undefined 返回兜底值', () => {
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
      expect(toNumber(undefined, 5)).toBe(5);
    });
  });

  describe('toText', () => {
    it('字符串原样返回', () => {
      expect(toText('hello')).toBe('hello');
      expect(toText('', 'fallback')).toBe('');
    });

    it('null / undefined 返回兜底值', () => {
      expect(toText(null)).toBe('');
      expect(toText(undefined)).toBe('');
      expect(toText(null, 'fb')).toBe('fb');
    });

    it('非字符串值转为字符串', () => {
      expect(toText(123)).toBe('123');
      expect(toText(0)).toBe('0');
    });

    it('boolean / bigint 转为字符串', () => {
      expect(toText(true)).toBe('true');
      expect(toText(false)).toBe('false');
      expect(toText(10n)).toBe('10');
    });

    it('Date 对象使用 toString 输出', () => {
      const d = new Date('2026-07-15T00:00:00.000Z');
      expect(toText(d)).toBe(d.toString());
    });

    it('普通对象 / symbol 返回兜底值', () => {
      expect(toText({ a: 1 })).toBe('');
      expect(toText({ a: 1 }, 'fb')).toBe('fb');
      expect(toText(Symbol('x'))).toBe('');
    });
  });

  describe('toDateText', () => {
    it('Date 对象转 YYYY-MM-DD', () => {
      expect(toDateText(new Date('2026-07-15T00:00:00.000Z'))).toBe(
        '2026-07-15',
      );
    });

    it('带时间的字符串取日期部分', () => {
      expect(toDateText('2026-07-15 09:30:00')).toBe('2026-07-15');
      expect(toDateText('2026-07-15T00:00:00.000Z')).toBe('2026-07-15');
    });

    it('空值 / 无法解析返回兜底值', () => {
      expect(toDateText(null)).toBe('');
      expect(toDateText(undefined, '--')).toBe('--');
      expect(toDateText('not-a-date', 'fb')).toBe('fb');
    });

    it('无效 Date 对象返回兜底值', () => {
      expect(toDateText(new Date('invalid'), '--')).toBe('--');
    });
  });

  describe('toMoneyText', () => {
    it('千分位格式化正数', () => {
      expect(toMoneyText(18500)).toBe('18,500');
      expect(toMoneyText(1234567)).toBe('1,234,567');
      expect(toMoneyText(999)).toBe('999');
    });

    it('负数保留负号', () => {
      expect(toMoneyText(-18500)).toBe('-18,500');
    });

    it('零返回 0', () => {
      expect(toMoneyText(0)).toBe('0');
    });

    it('小数四舍五入', () => {
      expect(toMoneyText(18500.6)).toBe('18,501');
    });
  });
});
