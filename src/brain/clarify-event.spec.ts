/**
 * clarify-event 单元测试（前后端澄清契约）
 *
 * 背景（2026-09-26 苏然）：桌面端渲染澄清卡读 `questions`（每项取 question ?? message），
 * 而 Orchestrator 此前只下发 `issues` + `message`，导致澄清卡渲染为空白 —— 这是真实缺陷。
 * 本规格锁死"任一来源有值都要渲染出内容"的契约。
 *
 * 负责人: 苏然 | 创建日期: 2026-09-26
 */
import { CLARIFY_FALLBACK_MESSAGE, buildClarifyPayload } from './clarify-event';
import type { ExtractionIssue } from './extraction/structured-extractor';

const ISSUES: ExtractionIssue[] = [
  {
    field: 'customerName',
    reason: 'required',
    message: '客户名称必填',
    question: '请问客户名称是什么？',
  },
  {
    field: 'items[0].skuName',
    reason: 'items',
    message: '至少一个商品行',
    question: '要开哪些商品？',
  },
];

describe('buildClarifyPayload（澄清事件载荷）', () => {
  it('有 issues 时：questions 与 issues 同源，前端能逐条渲染', () => {
    const p = buildClarifyPayload({
      questions: ['请问客户名称是什么？', '要开哪些商品？'],
      issues: ISSUES,
    });

    expect(p.questions).toEqual(ISSUES);
    expect(p.issues).toEqual(ISSUES);
    // 桌面端 showClarify 的映射口径：question ?? message
    expect(p.questions.map((q) => q.question || q.message)).toEqual([
      '请问客户名称是什么？',
      '要开哪些商品？',
    ]);
  });

  it('message：优先用增强结果的问句拼接', () => {
    const p = buildClarifyPayload({
      questions: ['请问客户名称是什么？', '要开哪些商品？'],
      issues: ISSUES,
    });
    expect(p.message).toBe('请问客户名称是什么？；要开哪些商品？');
  });

  it('questions 缺失时：message 回退为 issues 的 question 拼接（不是兜底文案）', () => {
    const p = buildClarifyPayload({ issues: ISSUES });
    expect(p.message).toBe('请问客户名称是什么？；要开哪些商品？');
    expect(p.questions).toEqual(ISSUES);
  });

  it('issues 缺失时：questions 归一为空数组（前端不拿到 undefined）', () => {
    const p = buildClarifyPayload({
      questions: ['请补充客户名称'],
    });
    expect(p.questions).toEqual([]);
    expect(p.issues).toEqual([]);
    expect(p.message).toBe('请补充客户名称');
  });

  it('两者都缺失 → 兜底文案，且不抛错', () => {
    const p = buildClarifyPayload({});
    expect(p.message).toBe(CLARIFY_FALLBACK_MESSAGE);
    expect(p.questions).toEqual([]);
  });

  it('issues 只有 message 无 question 时，message 字段仍能产出文案', () => {
    const onlyMessage: ExtractionIssue[] = [
      { field: 'qty', reason: 'type', message: '数量需为数字', question: '' },
    ];
    const p = buildClarifyPayload({ issues: onlyMessage });
    expect(p.message).toBe('数量需为数字');
  });
});
