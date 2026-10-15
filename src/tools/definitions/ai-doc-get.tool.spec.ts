/**
 * aiDocGet 工具测试（R101-AI-35 S2 · 读工具 · 不泄露存在性）
 *
 * 反测（各含 mutation）：
 * ① **无权 ⇒ "文档不存在"口径**：`getVisible` 返回 `{doc:null, access:'none'}` ⇒ 统一按不存在回复
 *    （mutation：改成"存在但无权"这类可区分文案 ⇒ 本例红 ⇒ 存在性泄漏）
 * ② 有权 ⇒ 返回完整元数据 + `access`（read/write/admin 如实透出）
 * ③ **必经 ACL**：断言 `getVisible` 被调用且传参（tenant + principal）
 * ④ 入参校验：docId 空 ⇒ 拒绝；ACL 抛错 ⇒ 不崩
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import {
  DocAclContext,
  DocAccess,
  DocAclService,
} from '../../rag/doc-acl.service';
import { ToolContext } from '../tool.interface';
import { AiDocGetTool } from './ai-doc-get.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function docOf(): AiDocEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '采购合同',
    category: 'contract',
    owner: 'u-owner',
    sourceType: 'generated',
    contentHash: 'h12',
    storagePath: null,
    status: 'active',
    version: 3,
    createdBy: 'u-owner',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  };
}

function createHarness(result: { doc: AiDocEntity | null; access: DocAccess }) {
  const getVisible = jest.fn((_id: string, _ctx: DocAclContext) =>
    Promise.resolve(result),
  );
  const tool = new AiDocGetTool({ getVisible } as unknown as DocAclService);
  return { tool, getVisible };
}

describe('AiDocGetTool（R101-AI-35 S2 读工具 · 存在性不泄露）', () => {
  it('① 无权 ⇒ 返回"文档不存在"（与真不存在同一口径，不泄露存在性）', async () => {
    const h = createHarness({ doc: null, access: 'none' });

    const result = await h.tool.execute({ docId: '12' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toBe('文档不存在：12');
    // 反测关键：文案里**不得**出现"无权/没有权限/存在"等可区分信息
    // mutation 检验点：改成"存在但无权访问" ⇒ 本行红（存在性泄漏）
    expect(result.error).not.toMatch(/无权|权限|存在但/);
    // 且必须经 ACL 判定（未被架空）
    expect(h.getVisible).toHaveBeenCalledTimes(1);
  });

  it('② 有权（read）⇒ 返回完整元数据 + access=read', async () => {
    const h = createHarness({ doc: docOf(), access: 'read' });

    const result = await h.tool.execute({ docId: '12' }, CTX);

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.docId).toBe('12');
    expect(data.title).toBe('采购合同');
    expect(data.version).toBe(3);
    expect(data.access).toBe('read');
  });

  it('③ 必经 ACL 且传参正确（tenant + principal 身份）', async () => {
    const h = createHarness({ doc: docOf(), access: 'admin' });

    await h.tool.execute({ docId: '12' }, CTX);

    const call = h.getVisible.mock.calls[0];
    expect(call[0]).toBe('12');
    expect(call[1]).toEqual({
      tenantId: 't1',
      principal: { type: 'user', id: 'u-1' },
    });
  });

  it('④ 入参校验：docId 空 ⇒ 拒绝（不调 ACL）', async () => {
    const h = createHarness({ doc: null, access: 'none' });

    const result = await h.tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('docId');
    expect(h.getVisible).not.toHaveBeenCalled();
  });

  it('⑤ ACL 抛错 ⇒ 不崩，返回 success=false + 建议', async () => {
    const tool = new AiDocGetTool({
      getVisible: jest.fn(() => Promise.reject(new Error('DB down'))),
    } as unknown as DocAclService);

    const result = await tool.execute({ docId: '12' }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('取文档详情失败');
    expect(result.suggestion).toBeTruthy();
  });

  it('⑥ 读工具契约：isWriteOperation=false', () => {
    const h = createHarness({ doc: null, access: 'none' });
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('aiDocGet');
  });
});
