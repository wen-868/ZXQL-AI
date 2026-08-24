/**
 * 库存数量「箱/基础单位」换算单元测试
 *
 * 覆盖 formatInventoryQty：
 * - 有规格（boxRatio>1）→ 「N箱M基础单位」
 * - 整除 → 仅「N箱」
 * - 不足一箱 → 仅「M基础单位」
 * - 无规格/换算比为 1 → 数量+基础单位
 * - 缺省单位、非法数值、负数等边界
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { formatInventoryQty } from './inventory-format';

describe('inventory-format 箱/基础单位换算', () => {
  it('有规格时应换算为「N箱M基础单位」', () => {
    // 314 瓶 = 52 箱（312 瓶）+ 2 瓶
    expect(
      formatInventoryQty(314, {
        boxRatio: 6,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('52箱2瓶');
  });

  it('数量能整除时应仅展示箱数', () => {
    expect(
      formatInventoryQty(60, {
        boxRatio: 6,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('10箱');
  });

  it('不足一箱时应仅展示基础单位数量', () => {
    expect(
      formatInventoryQty(5, {
        boxRatio: 6,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('5瓶');
  });

  it('数字字符串数量应正确换算', () => {
    expect(
      formatInventoryQty('52', {
        boxRatio: 12,
        boxUnit: '件',
        baseUnit: '支',
      }),
    ).toBe('4件4支');
  });

  it('无规格信息时应输出数量+基础单位', () => {
    expect(formatInventoryQty(314, undefined)).toBe('314');
    expect(formatInventoryQty(314, { baseUnit: '瓶' })).toBe('314瓶');
  });

  it('换算比为 1 或小于 1 时不应按箱拆分', () => {
    expect(
      formatInventoryQty(314, {
        boxRatio: 1,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('314瓶');
    expect(
      formatInventoryQty(314, {
        boxRatio: 0,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('314瓶');
  });

  it('缺省单位名时按默认「箱/空」兜底', () => {
    // boxUnit 缺省时默认「箱」；baseUnit 缺省时余数不带单位
    expect(
      formatInventoryQty(8, { boxRatio: 6, boxUnit: '', baseUnit: '' }),
    ).toBe('1箱2');
  });

  it('非法数值应原样返回，空值返回空串', () => {
    expect(formatInventoryQty(Number.NaN, { baseUnit: '瓶' })).toBe('NaN');
    expect(formatInventoryQty(null, { baseUnit: '瓶' })).toBe('');
    expect(formatInventoryQty(undefined, { baseUnit: '瓶' })).toBe('');
  });

  it('负库存按基础单位原样展示（防御性兜底）', () => {
    expect(
      formatInventoryQty(-3, {
        boxRatio: 6,
        boxUnit: '箱',
        baseUnit: '瓶',
      }),
    ).toBe('-3瓶');
  });
});
