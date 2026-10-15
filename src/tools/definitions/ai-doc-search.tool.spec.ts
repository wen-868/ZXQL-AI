/**
 * aiDocSearch 工具测试（R101-AI-35 S2 · 读工具 · 结构化检索 + 必经 ACL）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① **必经 ACL**：桩 `listVisible` 返回 ACL 可见集合；若工具绕过 ACL 直查（诱饵返回更多文档）⇒ 结果变多 ⇒ 红
 *    （mutation：把 `listVisible` 换成直查/返回全量 ⇒ 本例红）
 * ② 关键词匹配：标题命中 / 目录命中（大小写不敏感）；`matchedIn` 如实标注
 * ③ 目录/状态筛选透传；非法状态忽略
 * ④ 空结果 ⇒ `note`（不是错误，success 仍 true）
 * ⑤ 入参校验：keyword 空 ⇒ 拒绝（不调 ACL）；ACL 抛错 ⇒ 不崩
 * ⑥ 读工具契约：isWriteOperation=false
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import {
  OfficeAclContext,
  OfficeAclService,
} from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiDocSearchTool } from './ai-doc-search.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function docOf(over: Partial<AiDocEntity>): AiDocEntity {
  return {
    id: '1',
    tenantId: 't1',
    title: '采购合同模板',
    category: 'contract',
    tags: null,
    ragStatus: 'pending',
    owner: 'u-1',
    sourceType: 'generated',
    contentHash: 'h1',
    storagePath: null,
    status: 'active',
    version: 1,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function createHarness(visible: AiDocEntity[]) {
  const listVisible = jest.fn((_c: OfficeAclContext, _f: unknown) =>
    Promise.resolve(visible),
  );
  const tool = new AiDocSearchTool({
    listVisible,
  } as unknown as OfficeAclService);
  return { tool, listVisible };
}

describe('AiDocSearchTool（R101-AI-35 S2 收官 · 结构化检索）', () => {
  it('① 必经 ACL：只在可见集合内检索（绕过 ACL 直查 ⇒ 结果变多 ⇒ 红）', async () => {
    // ACL 只放出 1 篇；若工具绕过 ACL 直查（"全量 3 篇"）⇒ total 会变 3
    const h = createHarness([docOf({ id: '1', title: '采购合同模板' })]);

    const result = await h.tool.execute({ keyword: '采购' }, CTX);

    const data = result.data as {
      total: number;
      hits: Array<{ docId: string }>;
    };
    expect(data.total).toBe(1);
    expect(data.hits[0].docId).toBe('1');
    expect(h.listVisible).toHaveBeenCalledTimes(1);
    expect(h.listVisible.mock.calls[0][0]).toEqual({
      tenantId: 't1',
      principal: { type: 'user', id: 'u-1' },
    });
  });

  it('② 关键词匹配：标题 / 目录命中（大小写不敏感），matchedIn 如实标注', async () => {
    const h = createHarness([
      docOf({ id: '1', title: '采购合同模板', category: 'contract' }),
      docOf({ id: '2', title: '年度总结', category: 'PURCHASE' }),
      docOf({ id: '3', title: '无关文档', category: 'misc' }),
    ]);

    const result = await h.tool.execute({ keyword: 'purchase' }, CTX);

    const data = result.data as {
      total: number;
      hits: Array<{ docId: string; matchedIn: string[] }>;
    };
    // '采购合同模板' 标题不含 purchase；'年度总结' 目录 PURCHASE 命中（大小写不敏感）
    expect(data.total).toBe(1);
    expect(data.hits[0].docId).toBe('2');
    expect(data.hits[0].matchedIn).toEqual(['category']);

    const zh = await h.tool.execute({ keyword: '采购' }, CTX);
    const zhData = zh.data as {
      hits: Array<{ docId: string; matchedIn: string[] }>;
    };
    expect(zhData.hits.map((x) => x.docId)).toEqual(['1']);
    expect(zhData.hits[0].matchedIn).toEqual(['title']);
  });

  it('③ 筛选透传：category / status 传给 ACL；非法 status 忽略', async () => {
    const h = createHarness([]);

    await h.tool.execute(
      { keyword: 'x', category: 'contract', status: 'archived' },
      CTX,
    );
    expect(h.listVisible.mock.calls[0][1]).toEqual({
      category: 'contract',
      status: 'archived',
    });

    await h.tool.execute({ keyword: 'x', status: 'nonsense' }, CTX);
    expect(h.listVisible.mock.calls[1][1]).toEqual({
      category: undefined,
      status: undefined,
    });
  });

  it('④ 空结果 ⇒ note（success 仍为 true，不是错误）', async () => {
    const h = createHarness([docOf({ id: '1', title: '无关' })]);

    const result = await h.tool.execute({ keyword: '不存在词' }, CTX);

    expect(result.success).toBe(true);
    const data = result.data as { total: number; note?: string };
    expect(data.total).toBe(0);
    expect(data.note).toBeTruthy();
  });

  it('⑤ 入参校验：keyword 空 ⇒ 拒绝（不调 ACL）；ACL 抛错 ⇒ 不崩', async () => {
    const h = createHarness([]);
    const empty = await h.tool.execute({ keyword: '   ' }, CTX);
    expect(empty.success).toBe(false);
    expect(empty.error).toContain('keyword');
    expect(h.listVisible).not.toHaveBeenCalled();

    const broken = new AiDocSearchTool({
      listVisible: jest.fn(() => Promise.reject(new Error('DB down'))),
    } as unknown as OfficeAclService);
    const failed = await broken.execute({ keyword: 'x' }, CTX);
    expect(failed.success).toBe(false);
    expect(failed.error).toContain('检索文档失败');
  });

  it('⑥ 读工具契约：isWriteOperation=false（读全自动）', () => {
    const h = createHarness([]);
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('aiDocSearch');
  });

  // ── R101-AI-35 tags 补齐 ──
  // 契约演进留痕：tags 从「不参与检索」变为「参与检索」（本用例为该演进的正向断言）
  it('⑦ 【契约演进·R101-AI-35 tags 补齐】search 按**单个标签**命中，matchedIn 含 tags', async () => {
    const h = createHarness([
      docOf({ id: '1', title: '无关标题', category: 'misc', tags: '酒,饮料' }),
      docOf({ id: '2', title: '无关标题2', category: 'misc', tags: null }),
    ]);

    // 命中单个标签（'酒'）⇒ 命中 doc 1（演进前：tags 不参与检索 ⇒ 恒不命中）
    const hit = await h.tool.execute({ keyword: '酒' }, CTX);
    const data = hit.data as {
      total: number;
      hits: Array<{ docId: string; matchedIn: string[] }>;
    };
    expect(data.total).toBe(1);
    expect(data.hits[0].docId).toBe('1');
    expect(data.hits[0].matchedIn).toContain('tags');
    // mutation 检验点：去掉 tags 匹配分支 ⇒ 本用例红（total 变 0）

    // 单个标签粒度：'饮' 命中 '饮料' 这个标签（仍是标签级匹配）
    const partial = await h.tool.execute({ keyword: '饮' }, CTX);
    expect((partial.data as { total: number }).total).toBe(1);

    // 未出现在任何标签里的字 ⇒ 不命中（证明不是"整串模糊"的副作用）
    const miss = await h.tool.execute({ keyword: '浆' }, CTX);
    expect((miss.data as { total: number }).total).toBe(0);
  });
});
