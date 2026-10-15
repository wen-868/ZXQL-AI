/**
 * DocRagService 测试（R101-AI-35 S3 · 文档 ↔ RAG 贯通）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① 成功路径：split → 逐块 embed → `addChunks(tenantId, **String(docId)**, inputs)` → **UPDATE 回填 doc_id** → 'ready'
 *    （mutation：doc_name 传标题 ⇒ ② 红；不执行 UPDATE ⇒ ② 红）
 * ② 🔴 **doc_id 关联**：断言 addChunks 的 docName === String(docId) 且 UPDATE 参数为 [docId, tenantId, docId]
 * ③ 🔴 **主次不倒置**：embedding 抛错 / addChunks 抛错 ⇒ 返回 'failed' **且不抛**
 *    （mutation：去掉 try/catch ⇒ 用例红）
 * ④ embedding 未启用 ⇒ 直接 'failed'（不打网络）
 * ⑤ 正文空 / 分块空 ⇒ 'failed'
 * ⑥ reindexPending：有 chunks ⇒ 从 chunk_text 重算并回写 rag_status；无 chunks ⇒ 跳过（retried 不计）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { DataSource } from 'typeorm';
import { EmbeddingService } from './embedding.service';
import { DocRagService } from './doc-rag.service';
import { TextSplitterService } from './text-splitter.service';
import { VectorStoreService } from './vector-store.service';

const DOC = { id: '42', tenantId: 't1' };

interface Harness {
  svc: DocRagService;
  split: jest.Mock;
  embed: jest.Mock;
  isEnabled: jest.Mock;
  addChunks: jest.Mock;
  query: jest.Mock;
}

function createHarness(
  over: {
    embed?: (t: string) => Promise<number[]>;
    addChunks?: () => Promise<number>;
    isEnabled?: () => boolean;
    chunks?: string[];
    query?: (sql: string, params?: unknown[]) => Promise<unknown>;
  } = {},
): Harness {
  const embed = jest.fn(over.embed ?? (() => Promise.resolve([0.1, 0.2])));
  const isEnabled = jest.fn(over.isEnabled ?? (() => true));
  const addChunks = jest.fn(over.addChunks ?? (() => Promise.resolve(1)));
  const split = jest.fn(() => over.chunks ?? ['块1', '块2']);
  const query = jest.fn(over.query ?? (() => Promise.resolve([] as unknown[])));

  const svc = new DocRagService(
    { split } as unknown as TextSplitterService,
    { embed, isEnabled } as unknown as EmbeddingService,
    { addChunks } as unknown as VectorStoreService,
    { query } as unknown as DataSource,
  );
  return { svc, split, embed, isEnabled, addChunks, query };
}

describe('DocRagService（R101-AI-35 S3 文档↔RAG）', () => {
  it('① 成功路径：分块→逐块向量化→addChunks→回填 doc_id→ready', async () => {
    const h = createHarness();

    const status = await h.svc.indexDoc(DOC, '正文内容');

    expect(status).toBe('ready');
    expect(h.split).toHaveBeenCalledWith('正文内容');
    expect(h.embed).toHaveBeenCalledTimes(2);
    expect(h.addChunks).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('② 🔴 doc_id 关联（方案 A）：docName === String(docId)，且 UPDATE 回填同一 doc_id', async () => {
    const h = createHarness();

    await h.svc.indexDoc(DOC, '正文内容');

    const call = h.addChunks.mock.calls[0] as unknown as [
      string,
      string,
      Array<{ text: string; embedding: number[] }>,
    ];
    expect(call[0]).toBe('t1');
    // mutation 检验点：doc_name 传标题/其他 ⇒ 本行红
    expect(call[1]).toBe('42');
    expect(call[2]).toEqual([
      { text: '块1', embedding: [0.1, 0.2] },
      { text: '块2', embedding: [0.1, 0.2] },
    ]);

    const upd = h.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(upd[0]).toContain('UPDATE t_ai_knowledge_chunks SET doc_id');
    // mutation 检验点：不回填 doc_id ⇒ 本行红
    expect(upd[1]).toEqual(['42', 't1', '42']);
  });

  it('③ 🔴 主次不倒置：embedding 抛错 ⇒ 返回 failed 且**不抛**', async () => {
    const h = createHarness({
      embed: () => Promise.reject(new Error('embedding 服务不可用')),
    });

    await expect(h.svc.indexDoc(DOC, '正文')).resolves.toBe('failed');
  });

  it('③b 🔴 主次不倒置：addChunks 抛错 ⇒ 返回 failed 且**不抛**（且无 UPDATE）', async () => {
    const h = createHarness({
      addChunks: () => Promise.reject(new Error('sqlite 落盘失败')),
    });

    await expect(h.svc.indexDoc(DOC, '正文')).resolves.toBe('failed');
    expect(h.query).not.toHaveBeenCalled();
  });

  it('④ embedding 未启用 ⇒ 直接 failed（不打网络）', async () => {
    const h = createHarness({ isEnabled: () => false });

    const status = await h.svc.indexDoc(DOC, '正文');

    expect(status).toBe('failed');
    expect(h.embed).not.toHaveBeenCalled();
    expect(h.addChunks).not.toHaveBeenCalled();
  });

  it('⑤ 正文空 / 分块空 ⇒ failed', async () => {
    const h1 = createHarness();
    expect(await h1.svc.indexDoc(DOC, '   ')).toBe('failed');
    expect(h1.embed).not.toHaveBeenCalled();

    const h2 = createHarness({ chunks: [] });
    expect(await h2.svc.indexDoc(DOC, '正文')).toBe('failed');
    expect(h2.addChunks).not.toHaveBeenCalled();
  });

  it('⑥ reindexPending：有 chunks ⇒ 从 chunk_text 重算并回写 rag_status', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const h = createHarness({
      query: (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('SELECT id FROM t_ai_doc')) {
          return Promise.resolve([{ id: '42' }]);
        }
        if (sql.includes('SELECT chunk_index, chunk_text')) {
          return Promise.resolve([
            { chunk_index: 0, chunk_text: '甲' },
            { chunk_index: 1, chunk_text: '乙' },
          ]);
        }
        return Promise.resolve([]);
      },
    });

    const out = await h.svc.reindexPending('t1');

    expect(out).toEqual({ retried: 1, ready: 1, failed: 0 });
    // 用已落库 chunk_text 重算（'甲\n乙'），无需原始正文
    expect(h.split).toHaveBeenCalledWith('甲\n乙');
    const statusUpdate = queries.find((q) =>
      q.sql.includes('UPDATE t_ai_doc SET rag_status'),
    );
    expect(statusUpdate?.params).toEqual(['ready', '42', 't1']);
  });

  it('⑥b reindexPending：无已落库分块 ⇒ 跳过（不误标 failed）', async () => {
    const h = createHarness({
      query: (sql) => {
        if (sql.includes('SELECT id FROM t_ai_doc')) {
          return Promise.resolve([{ id: '42' }]);
        }
        return Promise.resolve([]); // 无 chunks
      },
    });

    const out = await h.svc.reindexPending('t1');

    expect(out).toEqual({ retried: 0, ready: 0, failed: 0 });
    expect(h.addChunks).not.toHaveBeenCalled();
  });

  it('⑥c reindexPending：查询抛错 ⇒ 不抛，返回零值', async () => {
    const h = createHarness({
      query: () => Promise.reject(new Error('DB down')),
    });

    await expect(h.svc.reindexPending('t1')).resolves.toEqual({
      retried: 0,
      ready: 0,
      failed: 0,
    });
  });
});
