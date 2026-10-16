/**
 * AI-41 两工具测试（aiTodoCancel / aiApprovalDraftDiscard）—— R101-AI-41
 *
 * 反测（各含 mutation；判据=目标用例变红；检查清单 ①total非0 ②目标红 ③残留0）：
 * ① Cancel preview 不落库（mutation：去早返回 ⇒ 红）
 * ② Cancel **原子条件 `status IN ('pending','in_progress')`**（mutation：去 status ⇒ 红）
 * ③ 🔴 Cancel **跨终态**：已 done ⇒ 明确失败（mutation：让 done 继续/回放 ⇒ 红）
 * ④ Cancel 已 cancelled ⇒ **回放**（无歧义终态）
 * ⑤ Cancel 权限 false ⇒ 拒绝
 * ⑥ Discard preview 不落库
 * ⑦ 🔴 Discard **仅 draft**：pending ⇒ 明确拒绝并指向 aiApprovalCancel（mutation：去 draft 判定 ⇒ 红）
 * ⑧ Discard 幂等：已弃 ⇒ 回放（mutation：去幂等 ⇒ 红）
 * ⑨ Discard **原子条件含 `status='draft'` 与 `deleted_at IS NULL`**（mutation：去任一条 ⇒ 红）
 * ⑩ Discard 权限：非申请人且无 ACL write ⇒ 拒绝（mutation：去权限 ⇒ 红）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiApprovalDraftDiscardTool } from './ai-approval-draft-discard.tool';
import { AiTodoCancelTool } from './ai-todo-cancel.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function todoOf(over: Partial<AiTodoEntity> = {}): AiTodoEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '准备季度汇报',
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

function approvalOf(over: Partial<AiApprovalEntity> = {}): AiApprovalEntity {
  return {
    id: '33',
    tenantId: 't1',
    title: '差旅报销草稿',
    type: 'expense',
    applicant: 'user:u-1',
    approver: 'user:u-9',
    status: 'draft',
    payload: null,
    decisionReason: null,
    relatedBiz: null,
    deletedAt: null,
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function aclStub(o: { write?: boolean } = {}) {
  return {
    canWriteResource: jest.fn(() => Promise.resolve(o.write ?? true)),
  } as unknown as OfficeAclService;
}

describe('AiTodoCancelTool（R101-AI-41 S1 取消待办）', () => {
  function harness(
    o: {
      todo?: AiTodoEntity | null;
      affected?: number;
      after?: AiTodoEntity | null;
      write?: boolean;
    } = {},
  ) {
    let finds = 0;
    const findOne = jest.fn(() => {
      finds += 1;
      return Promise.resolve(
        finds === 1
          ? o.todo === undefined
            ? todoOf()
            : o.todo
          : (o.after ?? null),
      );
    });
    const update = jest.fn(() =>
      Promise.resolve({ affected: o.affected ?? 1 }),
    );
    const tool = new AiTodoCancelTool(
      { findOne, update } as never,
      aclStub({ write: o.write }),
    );
    return { tool, findOne, update };
  }

  it('① preview（confirm 缺省）⇒ 不落库', async () => {
    const h = harness();
    const r = await h.tool.execute({ todoId: '12' }, CTX);
    expect(r.success).toBe(true);
    const d = r.preview?.details as Record<string, unknown>;
    expect(d.nextStatus).toBe('cancelled');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('② 原子条件 = status IN (pending,in_progress)', async () => {
    const h = harness();
    const r = await h.tool.execute({ todoId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].id).toBe('12');
    expect(call[0].status).toBeDefined(); // In([...]) 算子
    const op = call[0].status as {
      type?: string;
      value?: unknown;
      _value?: unknown;
    };
    const vals = (op.value ?? op._value) as unknown[];
    expect(op.type).toBe('in');
    expect(vals).toEqual(['pending', 'in_progress']);
    expect(call[1].status).toBe('cancelled');
  });

  it('③ 🔴 跨终态：已 done ⇒ 明确失败、不 update', async () => {
    const h = harness({ todo: todoOf({ status: 'done' }) });
    const r = await h.tool.execute({ todoId: '12', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('已完成');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('④ 已 cancelled ⇒ 回放（无歧义终态）', async () => {
    const h = harness({ todo: todoOf({ status: 'cancelled' }) });
    const r = await h.tool.execute({ todoId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    expect(r.idempotent_replay).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑤ 无写权限 ⇒ 拒绝', async () => {
    const h = harness({ write: false });
    const r = await h.tool.execute({ todoId: '12', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('无权取消');
    expect(h.update).not.toHaveBeenCalled();
  });
});

describe('AiApprovalDraftDiscardTool（R101-AI-41 S2 丢弃草稿·软删）', () => {
  function harness(
    o: {
      approval?: AiApprovalEntity | null;
      affected?: number;
      after?: AiApprovalEntity | null;
      write?: boolean;
    } = {},
  ) {
    let finds = 0;
    const findOne = jest.fn(() => {
      finds += 1;
      return Promise.resolve(
        finds === 1
          ? o.approval === undefined
            ? approvalOf()
            : o.approval
          : (o.after ?? null),
      );
    });
    const update = jest.fn(() =>
      Promise.resolve({ affected: o.affected ?? 1 }),
    );
    const tool = new AiApprovalDraftDiscardTool(
      { findOne, update } as never,
      aclStub({ write: o.write }),
    );
    return { tool, findOne, update };
  }

  it('⑥ preview ⇒ 不落库，且注明"软删"', async () => {
    const h = harness();
    const r = await h.tool.execute({ approvalId: '33' }, CTX);
    expect(r.success).toBe(true);
    const d = r.preview?.details as Record<string, unknown>;
    expect(d.softDelete).toBe(true);
    expect(String(d.note)).toContain('回溯');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑦ 🔴 仅 draft 可弃：pending ⇒ 明确拒绝并指向 aiApprovalCancel', async () => {
    const h = harness({ approval: approvalOf({ status: 'pending' }) });
    const r = await h.tool.execute({ approvalId: '33', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('仅草稿');
    expect(r.suggestion).toContain('aiApprovalCancel');
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑧ 幂等：已弃（deletedAt 非空）⇒ 回放', async () => {
    const h = harness({ approval: approvalOf({ deletedAt: new Date() }) });
    const r = await h.tool.execute({ approvalId: '33', confirm: true }, CTX);
    expect(r.success).toBe(true);
    expect(r.idempotent_replay).toBe(true);
    expect(h.update).not.toHaveBeenCalled();
  });

  it('⑨ 原子条件含 status=draft 与 deletedAt IS NULL；竞态 affected=0 且已弃 ⇒ 回放', async () => {
    const h = harness();
    const r = await h.tool.execute({ approvalId: '33', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].id).toBe('33');
    expect(call[0].status).toBe('draft');
    expect(call[0].deletedAt).toBeDefined(); // IsNull() 算子
    expect(call[1].deletedAt).toBeInstanceOf(Date);

    const race = harness({
      affected: 0,
      after: approvalOf({ deletedAt: new Date() }),
    });
    const r2 = await race.tool.execute(
      { approvalId: '33', confirm: true },
      CTX,
    );
    expect(r2.idempotent_replay).toBe(true);
  });

  it('⑩ 非申请人且无 ACL write ⇒ 拒绝', async () => {
    const h = harness({ write: false });
    const r = await h.tool.execute({ approvalId: '33', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('无权丢弃');
    expect(h.update).not.toHaveBeenCalled();
  });
});
