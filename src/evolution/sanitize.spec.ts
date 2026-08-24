/**
 * P1-1 脱敏工具单元测试
 *
 * 覆盖：手机遮蔽、金额量级化、标识字段遮蔽、输入指纹、轨迹脱敏。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  maskPhone,
  maskAmount,
  sanitizeJson,
  hashInput,
  toTrajectory,
} from './sanitize';

describe('P1-1 sanitize（脱敏工具）', () => {
  it('手机号遮蔽：11 位数字保留首 3 尾 4', () => {
    expect(maskPhone('13812345678')).toBe('138****5678');
    expect(maskPhone('123')).toBe('***');
  });

  it('金额量级化：>10000 千位取整，>100 百位取整', () => {
    expect(maskAmount(9800)).toBe(9800);
    expect(maskAmount(128000)).toBe(128000);
    expect(maskAmount(12345)).toBe(12000);
    expect(maskAmount(980)).toBe(1000);
    expect(maskAmount(58)).toBe(58);
  });

  it('递归脱敏：标识/手机/金额字段按规则处理，嵌套对象同样处理', () => {
    const input = {
      customerName: '红星商行',
      phone: '13812345678',
      totalAmount: 12345,
      items: [{ skuName: '五粮液', unitPrice: 980 }],
    };
    const out = sanitizeJson(input) as Record<string, unknown>;
    expect(out.customerName).toBe('***');
    expect(out.phone).toBe('138****5678');
    expect(out.totalAmount).toBe(12000);
    const items = out.items as Array<Record<string, unknown>>;
    expect(items[0].skuName).toBe('***');
    expect(items[0].unitPrice).toBe(1000);
  });

  it('输入指纹：MD5 32 位十六进制且确定性', () => {
    const h1 = hashInput('给红星商行开5箱五粮液');
    const h2 = hashInput('给红星商行开5箱五粮液');
    const h3 = hashInput('不同输入');
    expect(h1).toMatch(/^[a-f0-9]{32}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('轨迹脱敏：工具调用链路序列化并脱敏', () => {
    const trajectory = toTrajectory([
      { tool_name: 'searchProduct', args: { skuName: '五粮液' } },
    ]);
    expect(trajectory).toContain('searchProduct');
    expect(trajectory).toContain('***');
    expect(toTrajectory(undefined)).toBeNull();
  });
});
