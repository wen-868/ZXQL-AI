/**
 * aiDocList 工具测试（R101-AI-35 S2 · 反测第 3 组：读工具必须经 ACL）
 *
 * 关键反测（防"ACL 服务被架空"）：
 * - 桩：`OfficeAclService.listVisible` 返回 **[]**（无权），而 `docRepo.find` 若被直查会返回 **2 篇**
 *   ⇒ 只要工具绕过 ACL 直查，`total` 就会变成 2 ⇒ **用例红**
 *   （mutation：把 `this.docAcl.listVisible(...)` 换成 `this.docRepo.find(...)` ⇒ 本例必红）
 * - 同时断言 `listVisible` **被调用**且 tenant/principal 传参正确
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import {
  OfficeAclContext,
  OfficeAclService,
} from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiDocListTool, principalOf } from './ai-doc-list.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1', role: 'staff' };

function docOf(id: string): AiDocEntity {
  return {
    id,
    tenantId: 't1',
    title: `文档${id}`,
    category: 'contract',
    tags: null,
    ragStatus: 'pending',
    owner: 'u-owner',
    sourceType: 'upload',
    contentHash: `h${id}`,
    storagePath: null,
    status: 'active',
    version: 1,
    createdBy: 'u-owner',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createHarness(visible: AiDocEntity[]) {
  const listVisible = jest.fn((_ctx: OfficeAclContext, _f: unknown) =>
    Promise.resolve(visible),
  );
  // 「ACL 被架空」的诱饵：直查仓储会拿到 2 篇（≠ ACL 结果）
  const docRepoFind = jest.fn(() =>
    Promise.resolve([docOf('x1'), docOf('x2')]),
  );
  const tool = new AiDocListTool({
    listVisible,
  } as unknown as OfficeAclService);
  return { tool, listVisible, docRepoFind };
}

describe('AiDocListTool（R101-AI-35 S2 读工具 · 必经 ACL）', () => {
  it('① 无权限（ACL 返回空）⇒ 列表为空，且**确实调用了 ACL**（未被架空）', async () => {
    const h = createHarness([]);

    const result = await h.tool.execute({}, CTX);

    expect(result.success).toBe(true);
    const data = result.data as { total: number; list: unknown[] };
    expect(data.total).toBe(0);
    expect(data.list).toEqual([]);
    // 承重断言：必须经 ACL；若改为直查 docRepo（诱饵返回 2 篇）⇒ total=2 ⇒ 本行与上一行同时红
    expect(h.listVisible).toHaveBeenCalledTimes(1);
    expect(h.listVisible.mock.calls[0][0]).toEqual({
      tenantId: 't1',
      principal: { type: 'user', id: 'u-1', roles: ['staff'] },
    });
  });

  it('② 有权限 ⇒ 只返回 ACL 给出的文档（含摘要字段）', async () => {
    const h = createHarness([docOf('1'), docOf('2')]);

    const result = await h.tool.execute({ category: 'contract' }, CTX);

    const data = result.data as {
      total: number;
      list: Array<{ docId: string; title: string; category: string }>;
    };
    expect(data.total).toBe(2);
    expect(data.list.map((d) => d.docId)).toEqual(['1', '2']);
    expect(data.list[0].title).toBe('文档1');
    // 筛选条件透传给 ACL
    expect(h.listVisible.mock.calls[0][1]).toEqual({
      category: 'contract',
      status: undefined,
    });
  });

  it('③ 目录/状态筛选与非法状态处理（非法状态 ⇒ 不传）', async () => {
    const h = createHarness([]);

    await h.tool.execute({ category: 'policy', status: 'archived' }, CTX);
    expect(h.listVisible.mock.calls[0][1]).toEqual({
      category: 'policy',
      status: 'archived',
    });

    await h.tool.execute({ status: 'nonsense' }, CTX);
    expect(h.listVisible.mock.calls[1][1]).toEqual({
      category: undefined,
      status: undefined,
    });
  });

  it('④ 身份推导：数字员工优先（employeeId 存在 ⇒ employee 类型）', () => {
    const employeeCtx = {
      tenantId: 't1',
      userId: 'u-1',
      employeeId: 'emp-7',
    } as ToolContext & { employeeId: string };
    expect(principalOf(employeeCtx)).toEqual({ type: 'employee', id: 'emp-7' });
    expect(principalOf(CTX)).toEqual({
      type: 'user',
      id: 'u-1',
      roles: ['staff'],
    });
  });

  it('⑤ 读工具契约：isWriteOperation=false（读全自动，不耗幂等键）', () => {
    const h = createHarness([]);
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('aiDocList');
  });

  it('⑥ ACL 抛错 ⇒ 不崩，返回 success=false + 提示', async () => {
    const tool = new AiDocListTool({
      listVisible: jest.fn(() => Promise.reject(new Error('DB down'))),
    } as unknown as OfficeAclService);

    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('列文档失败');
    expect(result.suggestion).toBeTruthy();
  });
});
