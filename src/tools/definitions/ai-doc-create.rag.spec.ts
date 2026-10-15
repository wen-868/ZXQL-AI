/**
 * aiDocCreate ↔ RAG 贯通测试（R101-AI-35 S3）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① create ⇒ **喂 RAG**（indexDoc 被调用，内容一致）且成功 ⇒ `ragStatus='ready'`
 *    （mutation：不调 indexDoc ⇒ ① 红）
 * ② 🔴 **主次不倒置**：indexDoc 返回 'failed' ⇒ **文档仍然入库成功**（save 已发生、success=true）
 *    仅 `ragStatus='failed'` + 明确文案
 *    （mutation：让 RAG 失败导致 create 失败/回滚 ⇒ 本例红）
 * ③ 🔴 indexDoc **抛异常**（极端：服务自身 bug）⇒ create 仍须成功、标记 failed
 *    （mutation：去掉 try 或无 docRag 兜底 ⇒ 红）
 * ④ 未注入 docRag（@Optional）⇒ 不喂 RAG、不崩、`ragStatus='pending'`
 *
 * 说明：本文件是**新增** spec，不改动既有 `ai-doc-create.tool.spec.ts` 的任何断言
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { DocRagService } from '../../rag/doc-rag.service';
import { ToolContext } from '../tool.interface';
import { AiDocCreateTool } from './ai-doc-create.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function createHarness(
  ragImpl?: (doc: { id: string; tenantId: string }, content: string) => unknown,
) {
  const findOne = jest.fn(() => Promise.resolve(null));
  const save = jest.fn((e: Partial<AiDocEntity>) =>
    Promise.resolve({ ...e, id: '77' } as AiDocEntity),
  );
  const create = jest.fn((e: Partial<AiDocEntity>) => e);
  const update = jest.fn(() => Promise.resolve({}));
  const indexDoc = jest.fn(ragImpl ?? (() => Promise.resolve('ready')));

  const tool = new AiDocCreateTool(
    { findOne, save, create, update } as never,
    ragImpl ? ({ indexDoc } as unknown as DocRagService) : undefined,
  );
  return { tool, findOne, save, create, update, indexDoc };
}

function createHarnessWithRag(
  ragImpl: (doc: { id: string; tenantId: string }, content: string) => unknown,
) {
  return createHarness(ragImpl);
}

describe('AiDocCreateTool ↔ RAG（R101-AI-35 S3 贯通）', () => {
  it('① create ⇒ 喂 RAG（内容一致）且成功 ⇒ ragStatus=ready', async () => {
    const h = createHarnessWithRag(() => Promise.resolve('ready'));

    const result = await h.tool.execute(
      { title: 'T', content: '正文A', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    // 喂给了 RAG，且文档引用与正文正确
    expect(h.indexDoc).toHaveBeenCalledWith(
      { id: '77', tenantId: 't1' },
      '正文A',
    );
    // mutation 检验点：不调 indexDoc ⇒ 上一行红
    const data = result.data as { ragStatus: string };
    expect(data.ragStatus).toBe('ready');
    expect(h.update).toHaveBeenCalledWith({ id: '77' }, { ragStatus: 'ready' });
  });

  it('② 🔴 主次不倒置：RAG 失败 ⇒ 文档**仍然入库成功**，仅标记 failed', async () => {
    const h = createHarnessWithRag(() => Promise.resolve('failed'));

    const result = await h.tool.execute(
      { title: 'T', content: '正文B', confirm: true },
      CTX,
    );

    // 文档入库未被 RAG 失败拖垮
    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const data = result.data as {
      ragStatus: string;
      docId: string;
      message: string;
    };
    expect(data.docId).toBe('77');
    expect(data.ragStatus).toBe('failed');
    expect(data.message).toContain('向量索引失败');
    expect(h.update).toHaveBeenCalledWith(
      { id: '77' },
      { ragStatus: 'failed' },
    );
    // mutation 检验点：让 RAG 失败导致 create 失败（success=false 或 save 回滚）⇒ 本用例红
  });

  it('③ 🔴 RAG 服务自身抛异常 ⇒ create 仍成功并标 failed（不崩）', async () => {
    const h = createHarnessWithRag(() => {
      throw new Error('RAG 服务内部 bug');
    });

    const result = await h.tool.execute(
      { title: 'T', content: '正文C', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    const data = result.data as { ragStatus: string };
    expect(data.ragStatus).toBe('failed');
  });

  it('④ 未注入 docRag（@Optional）⇒ 不喂 RAG、不崩、ragStatus=pending', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      { title: 'T', content: '正文D', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    const data = result.data as { ragStatus: string };
    expect(data.ragStatus).toBe('pending');
  });
});
