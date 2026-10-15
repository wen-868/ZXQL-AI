/**
 * aiDocArchive 工具测试（R101-AI-35 S2 · 写工具 · 归档）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① **preview 不落库**（`confirm` 缺省 ⇒ 不 save）
 *    （mutation：去掉 `if (!confirm)` 早返回 ⇒ 本例红）
 * ② confirm ⇒ 落库且 `status='archived'`
 * ③ 🔴 **重复归档 ⇒ 回放**（已是 archived ⇒ `idempotent_replay:true` 且**不 save**）
 *    （mutation：去掉 `doc.status === 'archived'` 幂等判定 ⇒ 本例红）
 * ④ **无权（canAdmin=false）⇒ 拒绝且不落库**
 * ⑤ 契约：写工具 + `idempotencyKeyFields=['docId']`（与 update 的乐观锁口径区分）
 * ⑥ 入参校验：docId 空 / 文档不存在 ⇒ 明确提示
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiDocArchiveTool } from './ai-doc-archive.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function docOf(over: Partial<AiDocEntity> = {}): AiDocEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '采购合同',
    category: 'contract',
    tags: null,
    ragStatus: 'pending',
    owner: 'u-1',
    sourceType: 'generated',
    contentHash: 'h12',
    storagePath: null,
    status: 'active',
    version: 3,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function createHarness(doc: AiDocEntity | null, canAdmin = true) {
  const findOne = jest.fn(() => Promise.resolve(doc));
  const save = jest.fn((entity: AiDocEntity) => Promise.resolve(entity));
  const canAdminFn = jest.fn(() => Promise.resolve(canAdmin));
  const tool = new AiDocArchiveTool(
    { findOne, save } as never,
    { canAdmin: canAdminFn } as unknown as OfficeAclService,
  );
  return { tool, findOne, save, canAdminFn };
}

describe('AiDocArchiveTool（R101-AI-35 S2 写工具 · 归档）', () => {
  it('① preview（confirm 缺省）⇒ 返回 preview 且**不落库**', async () => {
    const h = createHarness(docOf());

    const result = await h.tool.execute({ docId: '12' }, CTX);

    expect(result.success).toBe(true);
    expect(result.preview?.operation).toBe('归档文档');
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.currentStatus).toBe('active');
    expect(details.nextStatus).toBe('archived');
    expect(String(details.consequence)).toContain('只读');
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：去掉早返回 ⇒ 会 save ⇒ 本例红
  });

  it('② confirm=true ⇒ 落库且 status=archived', async () => {
    const h = createHarness(docOf());

    const result = await h.tool.execute({ docId: '12', confirm: true }, CTX);

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = h.save.mock.calls[0][0];
    expect(saved.status).toBe('archived');
    const data = result.data as { status: string };
    expect(data.status).toBe('archived');
  });

  it('③ 🔴 重复归档 ⇒ 回放（已是 archived ⇒ replay 且不 save）', async () => {
    const h = createHarness(docOf({ status: 'archived' }));

    const result = await h.tool.execute({ docId: '12', confirm: true }, CTX);

    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    const data = result.data as { duplicate: boolean; status: string };
    expect(data.duplicate).toBe(true);
    expect(data.status).toBe('archived');
    // 承重断言：不得重复改状态
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：去掉 `doc.status === 'archived'` 判定 ⇒ 会 save ⇒ 本例红
  });

  it('④ 无权（canAdmin=false）⇒ 拒绝且不落库', async () => {
    const h = createHarness(docOf({ owner: 'u-other' }), false);

    const result = await h.tool.execute({ docId: '12', confirm: true }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权归档');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.canAdminFn).toHaveBeenCalled();
  });

  it('⑤ 契约：写工具 + 幂等键=[docId]（归档=重复操作口径，区别于 update 的乐观锁）', () => {
    const h = createHarness(docOf());
    expect(h.tool.isWriteOperation).toBe(true);
    expect(h.tool.risk).toBe('medium');
    expect(h.tool.idempotencyKeyFields).toEqual(['docId']);
    expect(h.tool.name).toBe('aiDocArchive');
  });

  it('⑥ 入参校验：docId 空 / 文档不存在 ⇒ 明确提示且不落库', async () => {
    const h1 = createHarness(docOf());
    const noId = await h1.tool.execute({ confirm: true }, CTX);
    expect(noId.success).toBe(false);
    expect(noId.error).toContain('docId');
    expect(h1.save).not.toHaveBeenCalled();

    const h2 = createHarness(null);
    const missing = await h2.tool.execute({ docId: '404', confirm: true }, CTX);
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('文档不存在');
  });
});
