/**
 * S4 tone-detector 单元测试
 *
 * 覆盖：急迫/轻松/正式/中性四档识别 + 指令块生成。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { detectTone, toneDirective } from './tone-detector';

describe('S4 detectTone（语气识别）', () => {
  it('急迫词 → urgent', () => {
    expect(detectTone('马上给我查一下库存')).toBe('urgent');
    expect(detectTone('等着用！！')).toBe('urgent');
  });

  it('轻松语气 → casual', () => {
    expect(detectTone('行吧')).toBe('casual');
    expect(detectTone('哈哈')).toBe('casual');
  });

  it('正式用语 → formal', () => {
    expect(detectTone('您好，麻烦帮我查询一下本月账单，谢谢')).toBe('formal');
  });

  it('普通陈述 → neutral', () => {
    expect(detectTone('查一下五粮液的库存')).toBe('neutral');
    expect(detectTone('')).toBe('neutral');
  });
});

describe('S4 toneDirective（语气指令块）', () => {
  it('urgent 指令要求先结论不超 5 行', () => {
    const d = toneDirective('urgent');
    expect(d).toContain('语气适配');
    expect(d).toContain('直接给结论');
  });

  it('neutral 返回空串（不占提示词）', () => {
    expect(toneDirective('neutral')).toBe('');
  });
});
