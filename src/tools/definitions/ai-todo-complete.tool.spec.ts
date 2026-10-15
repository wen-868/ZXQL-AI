/**
 * AiTodoCompleteTool 测试（R101-AI-37 步骤 3 · 完成待办）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① preview（confirm 缺省）⇒ 不调 update；mutation：去掉早返回 ⇒ 红
 * ② 🔴 **原子条件**：`update` 的 criteria 必须含 `status: Not('done')`（并发下只有一个请求真正改）
 *    mutation：去掉 `Not('done')` ⇒ ② 红
 * ③ 🔴 **affected=0 ⇒ 回放（不先读后写）**：桩模拟"并发已被别人完成"（affected=0、再读为 done）
 *    ⇒ 必须 `idempotent_replay:true`；mutation：改成"信任已读取的 status 决定" ⇒ ③ 红
 * ④ 权限：canWriteResource=false ⇒ 拒绝
 * ⑤ affected=0 且再读为空（已被删）⇒ 明确失败（不谎报成功）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiTodoCompleteTool } from './ai-todo-complete.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function todoOf(over: Partial<AiTodoEntity> = {}): AiTodoEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '待办',
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
    loaded?: AiTodoEntity | null;
    affected?: number;
    after?: AiTodoEntity | null;
    canWrite?: boolean;
  } = {},
) {
  let findCalls = 0;
  const findOne = jest.fn(() => {
    findCalls += 1;
    return Promise.resolve(
      findCalls === 1
        ? opts.loaded === undefined
          ? todoOf()
          : opts.loaded
        : (opts.after ?? null),
    );
  });
  const update = jest.fn(() =>
    Promise.resolve({ affected: opts.affected ?? 1 }),
  );
  const canWriteResource = jest.fn(() =>
    Promise.resolve(opts.canWrite ?? true),
  );
  const tool = new AiTodoCompleteTool(
    { findOne, update } as never,
    { canWriteResource } as unknown as OfficeAclService,
  );
  return { tool, findOne, update, canWriteResource };
}

describe('AiTodoCompleteTool（R101-AI-37 步骤 3 完成待办）', () => {
  it('① preview（confirm 缺省）⇒ 不调 update，含 nextStatus=done', async () => {
    const h = createHarness();

    const result = await h.tool.execute({ todoId: '12' }, CTX);

    expect(result.success).toBe(true);
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.nextStatus).toBe('done');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('② 🔴 原子条件：criteria 含 status: Not(done)', async () => {
    const h = createHarness();

    const result = await h.tool.execute({ todoId: '12', confirm: true }, CTX);

    expect(result.success).toBe(true);
    expect(h.update).toHaveBeenCalledTimes(1);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].id).toBe('12');
    expect(call[0].tenantId).toBe('t1');
    const statusCond = call[0].status as {
      type?: string;
      _type?: string;
      value?: unknown;
    };
    // TypeORM Not() 的 type 为 'not'（保留两种可能写法，避免"反向假红"）
    expect([statusCond.type, statusCond._type]).toContain('not');
    expect(call[1].status).toBe('done');
    // mutation 检验点：criteria 去掉 status 条件 ⇒ 本断言红
  });

  it('③ 🔴 affected=0（并发已被人完成）⇒ 回放，不谎报、不重复改', async () => {
    const h = createHarness({ affected: 0, after: todoOf({ status: 'done' }) });

    const result = await h.tool.execute({ todoId: '12', confirm: true }, CTX);

    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    const data = result.data as { duplicate: boolean; status: string };
    expect(data.duplicate).toBe(true);
    expect(data.status).toBe('done');
    // mutation 检验点：改成"先读后写"（信任 loaded.status=pending 就报成功、不看 affected）⇒ 本例红
  });

  it('④ 权限：canWriteResource=false ⇒ 拒绝且不 update', async () => {
    const h = createHarness({ canWrite: false });

    const result = await h.tool.execute({ todoId: '12', confirm: true }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('无权完成');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑤ affected=0 且再读为空（已删）⇒ 明确失败（不谎报成功）', async () => {
    const h = createHarness({ affected: 0, after: null });

    const result = await h.tool.execute({ todoId: '12', confirm: true }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('未能更新');
  });
});
