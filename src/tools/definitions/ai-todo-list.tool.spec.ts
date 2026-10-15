/**
 * AiTodoListTool 测试（R101-AI-37 步骤 3 · 待办读工具）
 *
 * 反测（判据=目标用例变红；凌舟裁定 ② 即本条）：
 * ① **库层隔离承重**：断言传给仓储的 where 是"租户 + (ACL 授予 OR 我创建 OR 派给我)"的**三支 OR**
 *    —— mutation：去掉收窄（只留 `tenant_id`）⇒ ①/② 红（同时会返回无关数据）
 * ② 无关待办不得出现（同租户、非授予、非我创建、非派给我）⇒ 同上 mutation 时红
 * ③ **纵深防御承重**：桩**故意多返回一条"越权行"**（模拟库条件被绕过/漏配）
 *    ⇒ 逐行确认必须把它丢掉；mutation：去掉逐行确认 ⇒ ③ 红
 * ④ 租户隔离：异租户待办不出现（mutation：去掉 tenant 条件 ⇒ 红）
 * ⑤ 读工具契约：isWriteOperation=false；`aclBucket` 如实报告授权数与范围
 *
 * 桩语义：忠实实现 TypeORM 的 where（对象或对象数组=OR），并支持"注入越权行"以测第二层。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiTodoListTool } from './ai-todo-list.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function todoOf(over: Partial<AiTodoEntity>): AiTodoEntity {
  return {
    id: '1',
    tenantId: 't1',
    title: '待办',
    description: null,
    assignee: 'user:u-1',
    status: 'pending',
    priority: 'normal',
    dueAt: null,
    source: 'user',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** TypeORM where 匹配（支持 In / LessThanOrEqual 与"对象数组=OR"） */
function opValue(v: unknown): unknown[] | null {
  if (v && typeof v === 'object') {
    const o = v as { value?: unknown; _value?: unknown; type?: string };
    const raw = o.value ?? o._value;
    if (o.type === 'in' && Array.isArray(raw)) return raw as unknown[];
  }
  return null;
}

function matches(t: AiTodoEntity, cond: Record<string, unknown>): boolean {
  return Object.entries(cond).every(([k, v]) => {
    const inVals = opValue(v);
    if (inVals) {
      return inVals
        .map(String)
        .includes(String((t as unknown as Record<string, unknown>)[k]));
    }
    const opType = (v as { type?: string }).type;
    if (opType === 'lte' || opType === 'lessThanOrEqual') {
      const raw =
        (v as { value?: unknown; _value?: unknown }).value ??
        (v as { _value?: unknown })._value;
      const due = t.dueAt ? new Date(t.dueAt).getTime() : null;
      return due !== null && due <= new Date(String(raw)).getTime();
    }
    const actual = (t as unknown as Record<string, unknown>)[k];
    return actual === v || String(actual) === String(v);
  });
}

function createHarness(
  todos: AiTodoEntity[],
  acls: Array<Record<string, unknown>> = [],
  injectRogue = false,
) {
  const find = jest.fn(({ where }: { where: unknown }) => {
    const conds = Array.isArray(where) ? where : [where];
    let out = todos.filter((t) =>
      conds.some((c) => matches(t, c as Record<string, unknown>)),
    );
    if (injectRogue) {
      // 模拟"库条件被绕过/漏配"：多返回一条与主体毫无关系的行
      out = out.concat([
        todoOf({
          id: '999',
          title: '越权行',
          createdBy: 'u-other',
          assignee: 'user:u-other',
        }),
      ]);
    }
    return Promise.resolve(out);
  });

  const aclFind = jest.fn(() => Promise.resolve(acls));
  const officeAcl = new OfficeAclService(
    { find: aclFind } as never,
    { find: jest.fn(), findOne: jest.fn() } as never,
  );

  const tool = new AiTodoListTool({ find } as never, officeAcl);
  return { tool, find, aclFind };
}

function aclRow(resourceId: string, perm = 'read') {
  return {
    id: `todo-${resourceId}`,
    tenantId: 't1',
    resourceType: 'todo',
    resourceId,
    principalType: 'user',
    principalId: 'u-1',
    perm,
    createdAt: new Date(),
  };
}

describe('AiTodoListTool（R101-AI-37 步骤 3 待办读工具）', () => {
  it('① 库层隔离：where 必须是「租户 + (ACL 授予 OR 我创建 OR 派给我)」三支 OR', async () => {
    const h = createHarness(
      [
        todoOf({ id: '1', createdBy: 'u-1' }), // 我创建
        todoOf({ id: '2', createdBy: 'u-x', assignee: 'user:u-1' }), // 派给我
        todoOf({ id: '3', createdBy: 'u-x', assignee: 'user:u-x' }), // 仅 ACL 授予
        todoOf({ id: '4', createdBy: 'u-x', assignee: 'user:u-x' }), // 与我无关
      ],
      [aclRow('3')],
    );

    const result = await h.tool.execute({}, CTX);

    // 内容：无关待办 4 必须不出现
    const data = result.data as {
      total: number;
      list: Array<{ todoId: string }>;
    };
    expect(data.list.map((x) => x.todoId).sort()).toEqual(['1', '2', '3']);

    // 承重断言：库查询条件形状（去掉收窄 ⇒ 本断言红）
    const where = (h.find.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    expect(Array.isArray(where)).toBe(true);
    const branches = where as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(3);
    expect(branches.every((b) => b.tenantId === 't1')).toBe(true);
    expect(opValue(branches[0].id)).toEqual(['3']); // ACL 授予集
    expect(branches[1].createdBy).toBe('u-1');
    expect(branches[2].assignee).toBe('user:u-1');
  });

  it('② 无关待办不出现（同租户、非授予、非我创建、非派给我）+ aclBucket 如实', async () => {
    const h = createHarness(
      [
        todoOf({ id: '1', createdBy: 'u-1' }),
        todoOf({ id: '4', createdBy: 'u-x', assignee: 'user:u-x' }),
      ],
      [aclRow('7')],
    );

    const result = await h.tool.execute({}, CTX);

    const data = result.data as {
      total: number;
      list: Array<{ todoId: string }>;
      aclBucket: { grantedCount: number; scope: string };
    };
    expect(data.list.map((x) => x.todoId)).toEqual(['1']);
    expect(data.aclBucket.grantedCount).toBe(1);
    expect(data.aclBucket.scope).toContain('tenant');
  });

  it('③ 纵深防御：库条件"漏配"多返回越权行时，逐行确认必须丢掉它', async () => {
    const h = createHarness(
      [todoOf({ id: '1', createdBy: 'u-1' })],
      [],
      true, // 桩注入 id=999 的越权行
    );

    const result = await h.tool.execute({}, CTX);

    const data = result.data as { list: Array<{ todoId: string }> };
    expect(data.list.map((x) => x.todoId)).toEqual(['1']);
    // mutation 检验点：把逐行确认改成"全部放行" ⇒ 999 出现 ⇒ 本例红
  });

  it('④ 租户隔离：异租户待办不出现（tenant 条件在库层）', async () => {
    const h = createHarness([
      todoOf({ id: '1', createdBy: 'u-1' }),
      todoOf({ id: '5', tenantId: 't2', createdBy: 'u-1' }), // 同一个人，别的租户
    ]);

    const result = await h.tool.execute({}, CTX);

    const data = result.data as { list: Array<{ todoId: string }> };
    expect(data.list.map((x) => x.todoId)).toEqual(['1']);
    // mutation 检验点：去掉 tenantId 条件 ⇒ 5 出现 ⇒ 本例红
  });

  it('⑤ 筛选透传（status/dueBefore）+ 读工具契约', async () => {
    const h = createHarness([
      todoOf({
        id: '1',
        createdBy: 'u-1',
        status: 'pending',
        dueAt: new Date('2026-10-18'),
      }),
      todoOf({
        id: '2',
        createdBy: 'u-1',
        status: 'done',
        dueAt: new Date('2026-10-18'),
      }),
    ]);

    const result = await h.tool.execute(
      { status: 'pending', dueBefore: '2026-10-20' },
      CTX,
    );

    const data = result.data as { list: Array<{ todoId: string }> };
    expect(data.list.map((x) => x.todoId)).toEqual(['1']);
    expect(h.tool.isWriteOperation).toBe(false);
    expect(h.tool.name).toBe('aiTodoList');
  });
});
