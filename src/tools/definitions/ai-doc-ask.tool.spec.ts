/**
 * aiDocAsk 工具测试（AI-P1-3 · 读工具 · ACL 先行 + chunks 唯一正文源 + 无编造）
 *
 * 反测设计（每条"改坏会红"；mutation 见回传卡）：
 * ① ACL 先行：无权/不存在 ⇒ 统一口径失败，**runner 零调用**（不消耗、不泄漏存在性）
 *    （mutation：ACL 检查挪到 LLM 之后/删掉 ⇒ 本例红）
 * ② 无分块 ⇒ not_indexed 如实分支（success:true + 建议），**不编造答案**
 * ③ 正常问答 ⇒ answer 来自 runner；citations 由**工具侧**按 chunkIndex 组装
 *    （断到关键内容：citations 数量/编号/chunkIndex 对齐，非仅"调用过"）
 * ④ 只喂本 docId 分块 ⇒ 查询参数断言（tenant+doc_name 双条件；防跨文档串料）
 * ⑤ LLM 失败（runner 抛错）⇒ success:false，无 answer 字段，商户文案无内部术语
 * ⑥ 读工具契约：isWriteOperation=false、name、topK 边界（非法回落默认、超上限截断）
 * ⑦ runner 收到的 payload 完整（docTitle/question/passages 带文本）——
 *    这是"模型只见授权内容"的链路铁证
 *
 * 负责人: 阿澈 | 创建日期: 2026-10-24
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { DocAskRunner } from '../doc-ask-runner';
import { ToolContext } from '../tool.interface';
import { AiDocAskTool } from './ai-doc-ask.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function docOf(over: Partial<AiDocEntity>): AiDocEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '采购合同-A-2026',
    category: 'contract',
    tags: null,
    ragStatus: 'ready',
    owner: 'u-1',
    sourceType: 'upload',
    contentHash: 'h1',
    storagePath: '/files/a.docx',
    status: 'active',
    version: 1,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** 行形态照 VectorStoreService 的 SELECT 列（chunk_index/chunk_text） */
function rowOf(index: number, text: string) {
  return { chunk_index: index, chunk_text: text };
}

function createHarness(opts: {
  doc?: AiDocEntity | null;
  rows?: ReturnType<typeof rowOf>[];
  /** runner 行为：默认回写固定答案；传 'throw' 模拟 LLM 全链失败 */
  ask?:
    'ok' | 'throw' | ((input: unknown) => Promise<never> | Promise<unknown>);
}) {
  const doc = 'doc' in opts ? opts.doc : docOf({});
  const getVisible = jest.fn(() =>
    Promise.resolve({
      doc: doc ?? null,
      access: doc ? 'read' : 'none',
    }),
  );
  const query = jest.fn(() => Promise.resolve(opts.rows ?? []));
  const runner = new DocAskRunner();
  const askCalls: unknown[] = [];
  if (opts.ask === 'throw') {
    runner.setRunner((input) => {
      askCalls.push(input);
      return Promise.reject(new Error('所有 AI 服务商均不可用'));
    });
  } else if (typeof opts.ask === 'function') {
    const custom = opts.ask;
    runner.setRunner((input) => custom(input) as Promise<never>);
  } else {
    runner.setRunner((input) => {
      askCalls.push(input);
      return Promise.resolve({
        answer: '付款条款：货到30天内付 [1]',
        provider: 'glm',
        fallbackUsed: false,
      });
    });
  }
  const tool = new AiDocAskTool(
    { getVisible } as unknown as OfficeAclService,
    runner,
    { query } as never,
  );
  return { tool, getVisible, query, askCalls };
}

describe('AiDocAskTool（AI-P1-3 · 文档问答）', () => {
  it('① ACL 先行：无权/不存在 ⇒ 统一口径失败且 runner 零调用（存在性不泄漏）', async () => {
    const h = createHarness({ doc: null });
    const r = await h.tool.execute({ docId: '999', question: '条款？' }, CTX);
    expect(r.success).toBe(false);
    // 无权与不存在同一口径（不暴露"其实存在只是你不能看"）
    expect(r.error).toContain('不存在或无权访问');
    // 🔴 承重断言：LLM 一次都没被调用（mutation：把 ACL 挪到 LLM 后 ⇒ 此断言红）
    expect(h.askCalls).toHaveLength(0);
  });

  it('② 无分块 ⇒ not_indexed 如实分支：不编造、有可执行建议', async () => {
    const h = createHarness({ rows: [] });
    const r = await h.tool.execute({ docId: '12', question: '条款？' }, CTX);
    expect(r.success).toBe(true);
    const data = r.data as { status: string; answer: unknown; note?: string };
    expect(data.status).toBe('not_indexed');
    expect(data.answer).toBeNull();
    expect(data.note).toContain('索引');
    expect(h.askCalls).toHaveLength(0); // 无正文不进 LLM，无从编造
  });

  it('③ 正常问答：answer 来自模型，citations 由工具按 chunkIndex 组装（断到关键内容）', async () => {
    const h = createHarness({
      rows: [
        rowOf(0, '第一条：货到30天内付款。'),
        rowOf(1, '第二条：违约金每日0.1%。'),
      ],
    });
    const r = await h.tool.execute(
      { docId: '12', question: '付款条款？' },
      CTX,
    );
    expect(r.success).toBe(true);
    const data = r.data as {
      status: string;
      answer: string;
      citations: Array<{ index: number; chunkIndex: number; snippet: string }>;
      passagesUsed: number;
    };
    expect(data.status).toBe('answered');
    expect(data.answer).toContain('货到30天内付');
    // citations 是**工具侧**组装的（chunkIndex 对齐原文分块），非模型自报
    expect(data.citations).toHaveLength(2);
    expect(data.citations[0].index).toBe(1);
    expect(data.citations[0].chunkIndex).toBe(0);
    expect(data.citations[0].snippet).toContain('第一条');
    expect(data.citations[1].chunkIndex).toBe(1);
    expect(data.passagesUsed).toBe(2);
  });

  it('④ 只喂本 docId + 本租户的分块（tenant+doc_name 双条件，防串料/串租户）', async () => {
    const h = createHarness({ rows: [rowOf(0, 'x')] });
    await h.tool.execute({ docId: '12', question: 'q' }, CTX);
    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(sql).toContain('t_ai_knowledge_chunks');
    // 🔴 双条件都在（mutation：删 tenant_id 条件 ⇒ 跨租户串料被本断言抓红）
    expect(sql).toContain('tenant_id = ?');
    expect(sql).toContain('doc_name = ?');
    expect(params).toEqual(['t1', '12']);
  });

  it('⑤ LLM 失败 ⇒ success:false 无 answer；商户文案不含内部术语', async () => {
    const h = createHarness({
      rows: [rowOf(0, '内容')],
      ask: 'throw',
    });
    const r = await h.tool.execute({ docId: '12', question: 'q' }, CTX);
    expect(r.success).toBe(false);
    const json = JSON.stringify(r);
    expect(json).not.toContain('付款'); // 无编造内容
    // 内部术语不外泄（provider/服务商/未注册等实现细节只进日志）
    expect(r.error).not.toMatch(/服务商|provider|Runner|DocAsk/i);
    expect(r.suggestion).toContain('重试');
  });

  it('⑥ 读工具契约 + topK 边界：非法回落默认、超上限截断', async () => {
    const h = createHarness({
      rows: Array.from({ length: 10 }, (_, i) => rowOf(i, `段落${i}`)),
    });
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('aiDocAsk');

    // 非法 topK ⇒ 默认 6
    await h.tool.execute({ docId: '12', question: 'q', topK: -3 }, CTX);
    let input = h.askCalls[0] as { passages: unknown[] };
    expect(input.passages).toHaveLength(6);

    // 超上限 ⇒ 截到 20（本例 10 块全收）
    await h.tool.execute({ docId: '12', question: 'q', topK: 999 }, CTX);
    input = h.askCalls[1] as { passages: unknown[] };
    expect(input.passages).toHaveLength(10);

    // 显式合法值生效
    await h.tool.execute({ docId: '12', question: 'q', topK: 2 }, CTX);
    input = h.askCalls[2] as { passages: unknown[] };
    expect(input.passages).toHaveLength(2);
  });

  it('⑦ runner 收到完整授权载荷（docTitle/question/passages 有文本；入参校验先行）', async () => {
    const h = createHarness({ rows: [rowOf(0, '原文A')] });
    const bad = await h.tool.execute({ docId: '  ', question: 'q' }, CTX);
    expect(bad.success).toBe(false);
    const bad2 = await h.tool.execute({ docId: '12', question: '' }, CTX);
    expect(bad2.success).toBe(false);

    const r = await h.tool.execute(
      { docId: '12', question: '关键条款？' },
      CTX,
    );
    expect(r.success).toBe(true);
    const input = h.askCalls[0] as {
      tenantId: string;
      docId: string;
      docTitle: string;
      question: string;
      passages: Array<{ index: number; chunkIndex: number; text: string }>;
    };
    expect(input.tenantId).toBe('t1');
    expect(input.docId).toBe('12');
    expect(input.docTitle).toBe('采购合同-A-2026');
    expect(input.question).toBe('关键条款？');
    expect(input.passages[0].text).toContain('原文A');
    expect(input.passages[0].index).toBe(1);
  });

  it('⑧ DB 查询失败 ⇒ 不崩，失败透明（error 收敛 + 建议）', async () => {
    const getVisible = jest.fn(() =>
      Promise.resolve({ doc: docOf({}), access: 'read' as const }),
    );
    const runner = new DocAskRunner();
    const askSpy = jest.fn();
    runner.setRunner(askSpy);
    const tool = new AiDocAskTool(
      { getVisible } as unknown as OfficeAclService,
      runner,
      { query: jest.fn(() => Promise.reject(new Error('DB down'))) } as never,
    );
    const r = await tool.execute({ docId: '12', question: 'q' }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('文档问答失败');
    expect(askSpy).not.toHaveBeenCalled();
  });
});
