/**
 * 多轮指代消解单元测试
 *
 * 覆盖 resolveReference：
 * - "上一单"从历史提取单号
 * - "那个客户"提取客户名
 * - "它/这个商品"提取商品名
 * - 无指代不注入
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */
import { resolveReference } from './reference-resolver';
import type { ChatMessage } from '../providers/provider.interface';

function msg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

const HISTORY: ChatMessage[] = [
  msg('user', '给红星商行送10箱五粮液'),
  msg(
    'assistant',
    '销售单 XS2026081649378 创建成功：客户 红星商行，10箱五粮液52度500ml，总金额 ¥11490.00。',
  ),
  msg('user', '那他的货款结了吗'),
  msg('assistant', '红星商行的应收余额为 ¥0，已结清。'),
];

describe('resolveReference（多轮指代消解）', () => {
  it('上一单 → 提取最近单号', () => {
    const res = resolveReference('上一单的金额是多少', HISTORY);
    expect(res.hasReference).toBe(true);
    expect(res.context).toContain('XS2026081649378');
  });

  it('那个客户 → 提取客户名', () => {
    const res = resolveReference('那个客户还欠多少', HISTORY);
    expect(res.hasReference).toBe(true);
    expect(res.context).toContain('红星商行');
  });

  it('它/这个商品 → 提取商品名', () => {
    const res = resolveReference('它还有多少库存', HISTORY);
    expect(res.hasReference).toBe(true);
    expect(res.context).toContain('五粮液');
  });

  it('无指代词不注入上下文', () => {
    const res = resolveReference('查询一下茅台的价格', HISTORY);
    expect(res.hasReference).toBe(false);
    expect(res.context).toBeUndefined();
  });

  it('历史为空时不消解', () => {
    const res = resolveReference('上一单多少钱', []);
    expect(res.hasReference).toBe(false);
  });
});
