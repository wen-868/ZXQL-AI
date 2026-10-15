/**
 * aiDocUpdate 工具测试（R101-AI-35 S2 · 写工具）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① **preview 不落库**（`confirm` 缺省 ⇒ 不 save）
 * ② 🔴 **乐观锁**：`expectedVersion` 与库中 `version` 不一致 ⇒ **明确拒绝且不落库**
 *    （mutation：去掉 `doc.version !== expectedVersion` 判定 ⇒ 本例红 ⇒ 变成静默覆盖）
 * ③ **同内容更新 ⇒ version 不递增**（`contentHash` 未变 ⇒ `unchanged:true`、不 save）
 * ④ 无写权限（`canWrite=false`）⇒ 拒绝且不落库
 * ⑤ 正文变更 ⇒ 落库且 `version+1`、`contentHash` 重算
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { createHash } from 'crypto';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiDocUpdateTool } from './ai-doc-update.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };
const sha256 = (t: string) =>
  createHash('sha256').update(t, 'utf8').digest('hex');

function docOf(over: Partial<AiDocEntity> = {}): AiDocEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '原标题',
    category: 'contract',
    tags: null,
    ragStatus: 'pending',
    owner: 'u-1',
    sourceType: 'generated',
    contentHash: sha256('旧正文'),
    storagePath: null,
    status: 'active',
    version: 3,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function createHarness(doc: AiDocEntity | null, canWrite = true) {
  const findOne = jest.fn(() => Promise.resolve(doc));
  const save = jest.fn((entity: AiDocEntity) => Promise.resolve(entity));
  const canWriteFn = jest.fn(() => Promise.resolve(canWrite));
  const tool = new AiDocUpdateTool(
    { findOne, save } as never,
    { canWrite: canWriteFn } as unknown as OfficeAclService,
  );
  return { tool, findOne, save, canWriteFn };
}

describe('AiDocUpdateTool（R101-AI-35 S2 写工具 · 含乐观锁）', () => {
  it('① preview（confirm 缺省）⇒ 返回 preview 且**不落库**', async () => {
    const h = createHarness(docOf());

    const result = await h.tool.execute(
      { docId: '12', expectedVersion: 3, title: '新标题' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.preview?.operation).toBe('修改文档');
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.currentVersion).toBe(3);
    expect(details.expectedVersion).toBe(3);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('② 🔴 乐观锁：version 漂移 ⇒ 明确拒绝且不落库（不静默覆盖）', async () => {
    // 用户预览时看到 version=3，但库里已被他人改为 version=4
    const h = createHarness(docOf({ version: 4 }));

    const result = await h.tool.execute(
      { docId: '12', expectedVersion: 3, title: '我的标题', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('已被他人修改');
    expect(result.error).toContain('期望版本 3');
    expect(result.error).toContain('当前版本 4');
    expect(result.suggestion).toContain('刷新');
    // 承重断言：必须不落库
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：去掉 version 校验 ⇒ 会走到 save ⇒ 本例红
  });

  it('③ 同内容更新 ⇒ version 不递增（unchanged:true，且不 save）', async () => {
    const h = createHarness(
      docOf({ contentHash: sha256('旧正文'), version: 3 }),
    );

    const result = await h.tool.execute(
      { docId: '12', expectedVersion: 3, content: '旧正文', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    const data = result.data as { version: number; unchanged: boolean };
    expect(data.version).toBe(3);
    expect(data.unchanged).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('④ 无写权限 ⇒ 拒绝且不落库', async () => {
    const h = createHarness(docOf({ owner: 'u-other' }), false);

    const result = await h.tool.execute(
      { docId: '12', expectedVersion: 3, title: 'x', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权修改');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.canWriteFn).toHaveBeenCalled();
  });

  it('⑤ 正文变更 ⇒ 落库且 version+1、contentHash 重算', async () => {
    const h = createHarness(docOf({ version: 3 }));

    const result = await h.tool.execute(
      { docId: '12', expectedVersion: 3, content: '新正文', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = h.save.mock.calls[0][0];
    expect(saved.version).toBe(4);
    expect(saved.contentHash).toBe(sha256('新正文'));
    const data = result.data as { version: number; contentChanged: boolean };
    expect(data.version).toBe(4);
    expect(data.contentChanged).toBe(true);
  });

  it('⑥ 入参校验：docId / expectedVersion 必填（乐观锁不可省）', async () => {
    const h = createHarness(docOf());

    const noId = await h.tool.execute({ expectedVersion: 3 }, CTX);
    expect(noId.success).toBe(false);
    expect(noId.error).toContain('docId');

    const noVersion = await h.tool.execute({ docId: '12' }, CTX);
    expect(noVersion.success).toBe(false);
    expect(noVersion.error).toContain('expectedVersion');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('⑦ 文档不存在 ⇒ 明确提示（不崩）', async () => {
    const h = createHarness(null);

    const result = await h.tool.execute(
      { docId: '404', expectedVersion: 1, confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('文档不存在');
  });
});
