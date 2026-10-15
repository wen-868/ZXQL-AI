/**
 * aiDocCreate 工具测试（R101-AI-35 S2 · 写工具组 1/2）
 *
 * 反测（各含 mutation；判据是"目标用例是否变红"，不只看替换生效）：
 * ① **preview 不落库**：`confirm` 缺省/ false ⇒ 返回 preview 且 **不调用 save/create**
 *    （mutation：去掉 `if (!confirm)` 早返回 ⇒ 本例红）
 * ② confirm 才落库：断言落库字段（tenant/title/category/owner/source_type='generated'）
 * ③ **幂等回放**：同 (tenant, content_hash) 已存在 ⇒ `idempotent_replay:true` 且**不新增行**
 *    （mutation：去掉存在性判定 ⇒ 本例红，会走 save）
 * ④ 入参校验：title/content 空 ⇒ 拒绝且不落库
 *
 * 用轻量仓储桩直接构造（构造依赖只有 docRepo）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { createHash } from 'crypto';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { ToolContext } from '../tool.interface';
import { AiDocCreateTool } from './ai-doc-create.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function docOf(over: Partial<AiDocEntity> = {}): AiDocEntity {
  return {
    id: '10',
    tenantId: 't1',
    title: '既有文档',
    category: 'default',
    tags: null,
    owner: 'u-x',
    sourceType: 'generated',
    contentHash: sha256('same content'),
    storagePath: null,
    status: 'active',
    version: 1,
    createdBy: 'u-x',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

interface Harness {
  tool: AiDocCreateTool;
  findOne: jest.Mock;
  save: jest.Mock;
  create: jest.Mock;
}

function createHarness(existing: AiDocEntity | null = null): Harness {
  const findOne = jest.fn(() => Promise.resolve(existing));
  const save = jest.fn((entity: Partial<AiDocEntity>) =>
    Promise.resolve({ ...entity, id: '99' } as AiDocEntity),
  );
  const create = jest.fn((entity: Partial<AiDocEntity>) => entity);
  const tool = new AiDocCreateTool({
    findOne,
    save,
    create,
  } as never);
  return { tool, findOne, save, create };
}

describe('AiDocCreateTool（R101-AI-35 S2 写工具）', () => {
  it('① preview（confirm 缺省）⇒ 返回 preview 且**不落库**', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      { title: '合同要点', content: '正文内容' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.preview?.operation).toBe('新建文档');
    expect(result.preview?.summary).toContain('合同要点');
    // 承重断言：preview 阶段不得触库
    expect(h.save).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.findOne).not.toHaveBeenCalled();
    // mutation 检验点：去掉 `if (!confirm)` 早返回 ⇒ 会走 save ⇒ 本例红
    expect(result.idempotent_replay).toBeUndefined();
  });

  it('② confirm=true ⇒ 落库且字段正确（source_type=generated / owner=调用者）', async () => {
    const h = createHarness(null);

    const result = await h.tool.execute(
      {
        title: '合同要点',
        content: '正文内容',
        category: 'contract',
        confirm: true,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = (
      h.save.mock.calls[0] as unknown as [Partial<AiDocEntity>]
    )[0];
    expect(saved.tenantId).toBe('t1');
    expect(saved.title).toBe('合同要点');
    expect(saved.category).toBe('contract');
    expect(saved.owner).toBe('u-1');
    expect(saved.sourceType).toBe('generated');
    expect(saved.status).toBe('active');
    expect(saved.contentHash).toBe(sha256('正文内容'));
    const data = result.data as { docId: string };
    expect(data.docId).toBe('99');
  });

  it('③ 幂等回放：同 (tenant, content_hash) 已存在 ⇒ replay 且**不新增行**', async () => {
    const existing = docOf({ contentHash: sha256('重复内容') });
    const h = createHarness(existing);

    const result = await h.tool.execute(
      { title: '任意标题', content: '重复内容', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    const data = result.data as { docId: string; duplicate: boolean };
    expect(data.docId).toBe('10');
    expect(data.duplicate).toBe(true);
    // 承重断言：命中幂等 ⇒ 不得再 save
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：去掉 findOne 存在性判定 ⇒ 会 save 新行 ⇒ 本例红
  });

  it('④ 入参校验：title / content 为空 ⇒ 拒绝且不落库', async () => {
    const h = createHarness();

    const noTitle = await h.tool.execute({ content: 'x', confirm: true }, CTX);
    expect(noTitle.success).toBe(false);
    expect(noTitle.error).toContain('title');

    const noContent = await h.tool.execute({ title: 'x', confirm: true }, CTX);
    expect(noContent.success).toBe(false);
    expect(noContent.error).toContain('content');

    expect(h.save).not.toHaveBeenCalled();
  });

  it('⑤ 写工具契约：isWriteOperation=true（走写全审核）', () => {
    const h = createHarness();
    expect(h.tool.isWriteOperation).toBe(true);
    expect(h.tool.name).toBe('aiDocCreate');
  });

  // ── R101-AI-35 tags 补齐（契约演进：tags 从"被静默丢弃"变为"入库并可检索"）──
  it('⑥ tags：归一化（去空/去重/trim）后入库，preview 也带 tags', async () => {
    const h = createHarness(null);

    const preview = await h.tool.execute(
      { title: 'T', content: 'C', tags: ' 酒 , ,饮料,酒 ' },
      CTX,
    );
    const pDetails = preview.preview?.details as Record<string, unknown>;
    expect(pDetails.tags).toBe('酒,饮料');
    expect(h.save).not.toHaveBeenCalled();

    await h.tool.execute(
      { title: 'T', content: 'C', tags: ' 酒 , ,饮料,酒 ', confirm: true },
      CTX,
    );
    const saved = (
      h.save.mock.calls[0] as unknown as [Partial<AiDocEntity>]
    )[0];
    // mutation 检验点：save 不带 tags（即"解析了没写"的原缺陷）⇒ 本行红
    expect(saved.tags).toBe('酒,饮料');
  });

  it('⑦ tags：超长 ⇒ 截断到 500（截到最后完整标签）且 preview **如实展示已截断**', async () => {
    const h = createHarness(null);
    const longTags = Array.from(
      { length: 60 },
      (_, i) => `标签${i}${'x'.repeat(10)}`,
    );

    const result = await h.tool.execute(
      { title: 'T', content: 'C', tags: longTags.join(',') },
      CTX,
    );

    const details = result.preview?.details as Record<string, unknown>;
    const value = String(details.tags);
    expect(value.length).toBeLessThanOrEqual(500);
    expect(value.endsWith('x')).toBe(true); // 截到最后完整标签（未被切断）
    // 不静默：必须显式告知已截断
    expect(details.tagsTruncated).toBe(true);
    expect(String(details.tagsNote)).toContain('截断');
  });

  it('⑧ tags 为空 ⇒ 正常入库为 null（不报错）', async () => {
    const h = createHarness(null);

    const result = await h.tool.execute(
      { title: 'T', content: 'C', tags: '   ,  ', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    const saved = (
      h.save.mock.calls[0] as unknown as [Partial<AiDocEntity>]
    )[0];
    expect(saved.tags).toBeNull();
  });
});
