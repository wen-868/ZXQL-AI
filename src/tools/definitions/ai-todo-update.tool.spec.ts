/**
 * AiTodoUpdateTool 测试（R101-AI-37 步骤 3 · 修改待办）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① **preview 不落库**（confirm 缺省 ⇒ 不 save）；mutation：去掉早返回 ⇒ 红
 * ② 🔴 **不接受 status**：传 status ⇒ 明确拒绝 + 指向 aiTodoComplete
 *    （mutation：允许 status ⇒ 红）
 * ③ **权限用 canWriteResource（非 canRead）**：只读授权 ⇒ 拒绝
 *    （mutation：改用 canReadResource ⇒ 红）
 * ④ confirm ⇒ save 且字段按 changes 生效（status 不被改）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiTodoUpdateTool } from './ai-todo-update.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function todoOf(over: Partial<AiTodoEntity> = {}): AiTodoEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '原标题',
    description: null,
    assignee: 'user:u-1',
    status: 'pending',
    priority: 'normal',
    dueAt: null,
    source: 'ai',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function createHarness(
  opts: {
    todo?: AiTodoEntity | null;
    canWrite?: boolean;
    canRead?: boolean;
  } = {},
) {
  const findOne = jest.fn(() =>
    Promise.resolve(opts.todo === undefined ? todoOf() : opts.todo),
  );
  const save = jest.fn((e: AiTodoEntity) => Promise.resolve(e));
  const canWriteResource = jest.fn(() =>
    Promise.resolve(opts.canWrite ?? true),
  );
  const canReadResource = jest.fn(() => Promise.resolve(opts.canRead ?? true));
  const tool = new AiTodoUpdateTool(
    { findOne, save } as never,
    { canWriteResource, canReadResource } as unknown as OfficeAclService,
  );
  return { tool, findOne, save, canWriteResource, canReadResource };
}

describe('AiTodoUpdateTool（R101-AI-37 步骤 3 修改待办）', () => {
  it('① preview（confirm 缺省）⇒ 不落库', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      { todoId: '12', priority: 'high' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.preview?.operation).toBe('修改待办');
    const details = result.preview?.details as Record<string, unknown>;
    expect((details.changes as Record<string, unknown>).priority).toBe('high');
    expect(String(details.dispatchNote)).toContain('不会自动派单');
    expect(h.save).not.toHaveBeenCalled();
  });

  it('② 🔴 不接受 status：传 status ⇒ 明确拒绝并指向 aiTodoComplete', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      { todoId: '12', status: 'done', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('不接受 status');
    expect(result.suggestion).toContain('aiTodoComplete');
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：允许 status（删掉该拒绝分支）⇒ 本例红
  });

  it('③ 权限：canWriteResource=false（仅只读）⇒ 拒绝；不得用 canRead 判定', async () => {
    const h = createHarness({ canWrite: false, canRead: true });

    const result = await h.tool.execute(
      { todoId: '12', title: '改标题', confirm: true },
      CTX,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权修改');
    expect(h.save).not.toHaveBeenCalled();
    expect(h.canWriteResource).toHaveBeenCalledTimes(1);
    // mutation 检验点：把判定换成 canReadResource ⇒ 只读也放行 ⇒ 本例红
  });

  it('④ confirm ⇒ save 生效且 status 保持不变', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      {
        todoId: '12',
        title: '新标题',
        priority: 'low',
        dueAt: '2026-10-25',
        confirm: true,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = h.save.mock.calls[0][0];
    expect(saved.title).toBe('新标题');
    expect(saved.priority).toBe('low');
    expect(saved.status).toBe('pending');
    const data = result.data as { changed: string[]; status: string };
    expect(data.status).toBe('pending');
    expect(data.changed).toContain('title');
  });
});
