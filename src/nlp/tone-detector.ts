/**
 * tone-detector — 用户语气启发式识别（S4 语气适配，2026-09-05）
 *
 * 纯函数零依赖：从消息文本识别急迫/轻松/正式/中性四档，
 * 供系统提示词注入"语气适配指令"（先结论、口语化、敬语书面等）。
 * 规则保守：宁返回 neutral 也不错判。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */

export type ToneType =
  'dissatisfied' | 'urgent' | 'casual' | 'formal' | 'neutral';

const DISSATISFIED_RE =
  /(怎么这么|又错了|还是不对|太慢了|不满|投诉|糊弄|靠谱吗|能不能行|搞什么)/;
const URGENT_RE = /(马上|立刻|尽快|急死|很急|着急|等着用|现在就要|赶紧)/;
const CASUAL_RE = /(呗|哈哈|行吧|随便|没事儿|搞快点还行)/;
const FORMAL_RE = /(您好|请问|麻烦|谢谢|烦请|贵公司|恳请)/;

/** 从消息文本识别用户语气（保守启发式；不满最优先——致歉+解决优先于一切） */
export function detectTone(message: string): ToneType {
  const t = (message ?? '').trim();
  if (!t) return 'neutral';
  if (DISSATISFIED_RE.test(t)) return 'dissatisfied';
  // 连续感叹/问号视为情绪强烈 → 急迫
  if (URGENT_RE.test(t) || /[!！]{2,}/.test(t)) return 'urgent';
  if (CASUAL_RE.test(t) || (t.length <= 6 && /[哈嘿呦]/.test(t)))
    return 'casual';
  if (FORMAL_RE.test(t)) return 'formal';
  return 'neutral';
}

/** 语气 → 系统提示词指令块（neutral 返回空串，不占提示词） */
export function toneDirective(tone: ToneType): string {
  switch (tone) {
    case 'dissatisfied':
      return '\n\n## 语气适配（强制）\n用户带有不满情绪：先用一句话诚恳认错或致歉（不推诿、不辩解），随后立即给出可执行的解决办法或更正后的正确数据；禁止寒暄与废话。';
    case 'urgent':
      return '\n\n## 语气适配（强制）\n用户当前语气急迫：第一句话直接给结论/答案，再给最多 3 条关键要点，整体不超过 5 行，省略一切铺垫与寒暄。';
    case 'casual':
      return '\n\n## 语气适配（强制）\n用户语气轻松随意：回复口语化、简短为主（3 行以内），不要堆砌术语与长表格。';
    case 'formal':
      return '\n\n## 语气适配（强制）\n用户语气正式：使用敬语与书面表达，结构化分点输出，措辞严谨、不使用口语词。';
    default:
      return '';
  }
}
