/**
 * AiTodoCreateTool 测试（R101-AI-37 步骤 3 · 建单）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① **preview 零副作用**：`confirm` 缺省 ⇒ 返回 preview 且**不查库、不落库**
 *    （mutation：去掉 `if (!confirm)` 早返回 ⇒ ① 红）
 * ② confirm ⇒ 落库字段正确（tenant/title/assignee/status=pending/source=ai/createdBy）
 * ③ **幂等第 1 层（业务）**：同名未完结已存在 ⇒ 回放且**不重复 save**
 *    （mutation：去掉业务幂等判定 ⇒ ③ 红）
 * ④ **幂等第 2 层（DB 唯一键竞态）**：save 抛唯一键冲突 ⇒ 再读并回放
 *    （mutation：去掉竞态兜底 ⇒ ④ 红：变成 success=false）
 * ⑤ **复用既有派单路径**：`assignee='employee:e-1'` ⇒ 调用 `DispatchEmployeeTaskTool.execute`
 *    且参数为 `{target:'e-1', task, taskType:'todo'}`
 *    （mutation：跳过派单 ⇒ ⑤ 红；改成直调新端点不可能——本工具未注入 ServiceClient）
 * ⑥ 🔴 **主次不倒置**：派单抛异常 ⇒ 待办仍创建成功、`dispatch.status='failed'`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { ToolContext } from '../tool.interface';
import { AiTodoCreateTool } from './ai-todo-create.tool';
import { DispatchEmployeeTaskTool } from './dispatch-employee-task.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function todoOf(over: Partial<AiTodoEntity> = {}): AiTodoEntity {
  return {
    id: '9',
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

function createHarness(
  opts: {
    existing?: AiTodoEntity | null;
    raced?: AiTodoEntity | null;
    saveRejects?: string;
    dispatch?: (args: Record<string, unknown>) => unknown;
    withDispatch?: boolean;
  } = {},
) {
  let findCalls = 0;
  const findOne = jest.fn(() => {
    findCalls += 1;
    // 第 1 次：业务幂等查询；第 2 次：竞态兜底查询
    return Promise.resolve(
      findCalls === 1 ? (opts.existing ?? null) : (opts.raced ?? null),
    );
  });
  const save = jest.fn((e: Partial<AiTodoEntity>) => {
    if (opts.saveRejects) {
      return Promise.reject(new Error(opts.saveRejects));
    }
    return Promise.resolve({ ...e, id: '77' } as AiTodoEntity);
  });
  const create = jest.fn((e: Partial<AiTodoEntity>) => e);
  const dispatchExecute = jest.fn(
    opts.dispatch ??
      (() => Promise.resolve({ success: true, data: { dispatched: true } })),
  );
  const tool = new AiTodoCreateTool(
    { findOne, save, create } as never,
    opts.withDispatch === false
      ? undefined
      : ({ execute: dispatchExecute } as unknown as DispatchEmployeeTaskTool),
  );
  return { tool, findOne, save, create, dispatchExecute };
}

describe('AiTodoCreateTool（R101-AI-37 步骤 3 建单）', () => {
  it('① preview（confirm 缺省）⇒ 零副作用（不查库、不落库）', async () => {
    const h = createHarness();

    const result = await h.tool.execute({ title: '准备季度汇报' }, CTX);

    expect(result.success).toBe(true);
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.title).toBe('准备季度汇报');
    expect(details.assignee).toBe('user:u-1'); // 缺省 = 当前用户
    expect(details.source).toBe('ai');
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('② confirm ⇒ 落库且字段正确', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      {
        title: '准备季度汇报',
        assignee: 'user:u-1',
        dueAt: '2026-10-20',
        priority: 'high',
        confirm: true,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const saved = h.save.mock.calls[0][0];
    expect(saved.tenantId).toBe('t1');
    expect(saved.status).toBe('pending');
    expect(saved.source).toBe('ai');
    expect(saved.createdBy).toBe('u-1');
    expect(saved.priority).toBe('high');
    const data = result.data as { todoId: string };
    expect(data.todoId).toBe('77');
  });

  it('③ 幂等第 1 层（业务）：同名未完结已存在 ⇒ 回放且不重复 save', async () => {
    const h = createHarness({
      existing: todoOf({ id: '9', status: 'in_progress' }),
    });

    const result = await h.tool.execute(
      { title: '准备季度汇报', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    const data = result.data as { todoId: string; duplicate: boolean };
    expect(data.todoId).toBe('9');
    expect(data.duplicate).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
    // mutation 检验点：去掉业务幂等 ⇒ 会 save ⇒ 本例红
  });

  it('④ 幂等第 2 层（并发竞态）：save 唯一键冲突 ⇒ 再读回放', async () => {
    const h = createHarness({
      existing: null,
      raced: todoOf({ id: '88' }),
      saveRejects: 'UNIQUE constraint failed: t_ai_todo',
    });

    const result = await h.tool.execute(
      { title: '准备季度汇报', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.idempotent_replay).toBe(true);
    const data = result.data as { todoId: string };
    expect(data.todoId).toBe('88');
    // mutation 检验点：去掉竞态兜底 ⇒ success=false ⇒ 本例红
  });

  it('⑤ 复用既有派单路径：employee:{id} ⇒ 调 DispatchEmployeeTaskTool（不新建派发路径）', async () => {
    const h = createHarness();

    const result = await h.tool.execute(
      {
        title: '准备季度汇报',
        description: '含 Q3 数据',
        assignee: 'employee:e-1',
        confirm: true,
      },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.dispatchExecute).toHaveBeenCalledTimes(1);
    const call = h.dispatchExecute.mock.calls[0] as unknown as [
      Record<string, unknown>,
      ToolContext,
    ];
    expect(call[0].target).toBe('e-1');
    expect(String(call[0].task)).toContain('准备季度汇报');
    expect(call[0].taskType).toBe('todo');
    // R101-AI-46：关联待办透传（数字员工完成后回写 done 的依据）
    // 🔴 断言到关键内容：必须是刚落库的 saved.id（字符串形态），不能只是"存在"
    expect(call[0].linkedTodoId).toBe(
      (result.data as { todoId: string }).todoId,
    );
    const data = result.data as { dispatch?: { status: string } };
    expect(data.dispatch?.status).toBe('dispatched');
    // mutation 检验点：跳过派单（if(false)）⇒ 上一行与 toHaveBeenCalledTimes(1) 同红；
    // 去掉 linkedTodoId 透传 ⇒ 上面 toBe 同红（R101-AI-46 已验证）
  });

  it('⑥ 🔴 主次不倒置：派单抛异常 ⇒ 待办仍创建成功、dispatch=failed', async () => {
    const h = createHarness({
      dispatch: () => {
        throw new Error('数字员工服务不可用');
      },
    });

    const result = await h.tool.execute(
      { title: '准备季度汇报', assignee: 'employee:e-1', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.save).toHaveBeenCalledTimes(1);
    const data = result.data as {
      todoId: string;
      dispatch?: { status: string };
    };
    expect(data.todoId).toBe('77');
    expect(data.dispatch?.status).toBe('failed');
  });

  it('⑦ 入参校验：title 空 / assignee 格式非法 ⇒ 拒绝且不落库', async () => {
    const h = createHarness();

    const noTitle = await h.tool.execute({ title: '  ', confirm: true }, CTX);
    expect(noTitle.success).toBe(false);
    expect(noTitle.error).toContain('title');

    const badAssignee = await h.tool.execute(
      { title: 'T', assignee: 'boss-1', confirm: true },
      CTX,
    );
    expect(badAssignee.success).toBe(false);
    expect(badAssignee.error).toContain('assignee');
    expect(h.save).not.toHaveBeenCalled();
  });
});
