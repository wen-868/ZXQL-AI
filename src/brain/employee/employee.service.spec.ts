/**
 * EmployeeService 单元测试 — 数字员工 MVP（2026-09-26 补）
 *
 * 覆盖 12.3 验收标准的代码级部分：
 *  - 派发即返回（建任务 + 触发执行，不阻塞）
 *  - 边表校验（目标不在 dispatch_uids 内 → 拒绝）
 *  - 深度上限（MAX_DISPATCH_DEPTH，默认 2）
 *  - 用户直接交办（无 callerUid → dispatchedBy=user，不受边表限制）
 *  - 执行异常 → 任务落 failed
 *  - 联系人列表项（dispatchUids 边表回显 + 管理岗标记）
 *  - 结果摘要截断（4000）
 *
 * 负责人: 苏然（测试） | 创建日期: 2026-09-26
 */
import { Repository } from 'typeorm';
import { EmployeeService } from './employee.service';
import {
  AiEmployeeEntity,
  AiEmployeeTaskEntity,
} from '../../database/entities/ai-employee.entity';

/** 构造员工实体（仅测试必填字段） */
function makeEmployee(over: Partial<AiEmployeeEntity> = {}): AiEmployeeEntity {
  return {
    id: over.id ?? 1,
    tenantId: over.tenantId ?? 't1',
    employeeUid: over.employeeUid ?? 'emp_caller',
    name: over.name ?? '库管家',
    post: over.post ?? '库存管家',
    department: over.department ?? '商品部',
    personaPrompt: over.personaPrompt ?? null,
    toolCategories: over.toolCategories ?? null,
    dataScope: over.dataScope ?? null,
    dispatchUids: over.dispatchUids ?? null,
    replyStyle: over.replyStyle ?? null,
    status: over.status ?? 1,
    createdAt: over.createdAt ?? new Date(),
    updatedAt: over.updatedAt ?? new Date(),
  };
}

/** QueryBuilder 的链式桩（findByNameOrPost 用 getOne，listTasksFor 用 getMany） */
interface QbStub {
  where: () => QbStub;
  andWhere: () => QbStub;
  setParameter: () => QbStub;
  orderBy: () => QbStub;
  take: () => QbStub;
  getOne: () => Promise<AiEmployeeEntity | null>;
  getMany: () => Promise<AiEmployeeTaskEntity[]>;
}

function makeQb(
  one: AiEmployeeEntity | null = null,
  many: AiEmployeeTaskEntity[] = [],
): QbStub {
  const qb: QbStub = {
    where: () => qb,
    andWhere: () => qb,
    setParameter: () => qb,
    orderBy: () => qb,
    take: () => qb,
    getOne: () => Promise.resolve(one),
    getMany: () => Promise.resolve(many),
  };
  return qb;
}

describe('EmployeeService', () => {
  let service: EmployeeService;
  let savedTasks: Array<Partial<AiEmployeeTaskEntity> & { id: number }>;
  let runnerCalls: Array<{
    taskId: number;
    depth: number;
    taskText: string;
    dispatchedBy: string;
  }>;
  /** 可替换的仓储行为 */
  let findOneImpl: (opt: {
    where: { employeeUid?: string; tenantId?: string; id?: number };
  }) => Promise<AiEmployeeEntity | null>;
  let qbImpl: () => QbStub;
  let findImpl: () => Promise<AiEmployeeEntity[]>;
  let runnerImpl: () => Promise<{
    summary: string;
    status: 'completed' | 'failed';
  }>;
  /** 任务仓储（提升为模块级，供租户隔离用例断言调用参数） */
  let taskRepo: Repository<AiEmployeeTaskEntity>;

  beforeEach(() => {
    savedTasks = [];
    runnerCalls = [];
    findOneImpl = () => Promise.resolve(null);
    qbImpl = () => makeQb();
    findImpl = () =>
      Promise.resolve([makeEmployee({ id: 2, employeeUid: 'emp_a' })]);
    runnerImpl = () =>
      Promise.resolve({
        summary: '采购单已创建',
        status: 'completed' as const,
      });

    const employeeRepo = {
      find: async () => findImpl(),
      findOne: async (opt: {
        where: { employeeUid?: string; tenantId?: string; id?: number };
      }) => findOneImpl(opt),
      create: (e: Partial<AiEmployeeEntity>) => e as AiEmployeeEntity,
      save: (e: Partial<AiEmployeeEntity>) =>
        Promise.resolve({ ...e, id: 99 } as AiEmployeeEntity),
      createQueryBuilder: () => qbImpl(),
    } as unknown as Repository<AiEmployeeEntity>;

    taskRepo = {
      create: (e: Partial<AiEmployeeTaskEntity>) => e as AiEmployeeTaskEntity,
      findOne: jest.fn(
        (opt: { where?: Record<string, unknown> } | undefined = {}) => {
          const w = (opt.where ?? {}) as { id?: number; tenantId?: string };
          const row = savedTasks.find(
            (t) =>
              t.id === w.id &&
              // 租户不匹配则查不到 —— 这正是本次修复要验证的隔离语义
              (w.tenantId === undefined || t.tenantId === w.tenantId),
          );
          return Promise.resolve((row ?? null) as AiEmployeeTaskEntity | null);
        },
      ),
      save: (e: Partial<AiEmployeeTaskEntity>) => {
        const row = { ...e, id: savedTasks.length + 1 };
        savedTasks.push(row);
        return Promise.resolve(row as AiEmployeeTaskEntity);
      },
      update: jest.fn(
        (
          criteria: number | { id: number; tenantId?: string },
          patch: Partial<AiEmployeeTaskEntity>,
        ) => {
          // 兼容两种形态：修复前 update(id, patch)，修复后 update({id,tenantId}, patch)
          const id = typeof criteria === 'number' ? criteria : criteria.id;
          const tenantId =
            typeof criteria === 'object' ? criteria.tenantId : undefined;
          const row = savedTasks.find(
            (t) =>
              t.id === id &&
              (tenantId === undefined || t.tenantId === tenantId),
          );
          if (row) Object.assign(row, patch);
          return Promise.resolve({ affected: row ? 1 : 0 });
        },
      ),
      createQueryBuilder: () => qbImpl(),
    } as unknown as Repository<AiEmployeeTaskEntity>;

    service = new EmployeeService(employeeRepo, taskRepo);
    service.setTaskRunner(async (input) => {
      runnerCalls.push({
        taskId: input.taskId,
        depth: input.depth,
        taskText: input.taskText,
        dispatchedBy: input.dispatchedBy,
      });
      return runnerImpl();
    });
  });

  it('派发成功：目标在边表内 → 派发即返回 + 任务记录 running + 触发下级执行', async () => {
    findOneImpl = (opt) =>
      Promise.resolve(
        opt.where.employeeUid === 'emp_caller'
          ? makeEmployee({
              id: 1,
              employeeUid: 'emp_caller',
              name: '库管家',
              dispatchUids: ['emp_target'],
            })
          : null,
      );
    qbImpl = () =>
      makeQb(
        makeEmployee({
          id: 2,
          employeeUid: 'emp_target',
          name: '采专员',
          post: '采购专员',
        }),
      );

    const res = await service.dispatchTask({
      callerUid: 'emp_caller',
      tenantId: 't1',
      targetKeyword: '采专员',
      task: '按缺货清单创建采购单',
      dispatchDepth: 0,
    });

    expect(res.accepted).toBe(true);
    expect(res.taskId).toBe(1);
    expect(res.message).toContain('已派发给「采专员」');
    // 任务记录：running + 署名调用者
    expect(savedTasks.length).toBe(1);
    expect(savedTasks[0].status).toBe('running');
    expect(savedTasks[0].dispatchedBy).toBe('employee:emp_caller');
    // 异步执行已触发（派发即返回，不等结果）
    expect(runnerCalls.length).toBe(1);
    expect(runnerCalls[0].depth).toBe(1);
    expect(runnerCalls[0].taskText).toBe('按缺货清单创建采购单');
  });

  it('边表校验：目标不在调用者可调用列表 → 拒绝，且不建任务、不触发执行', async () => {
    findOneImpl = (opt) =>
      Promise.resolve(
        opt.where.employeeUid === 'emp_caller'
          ? makeEmployee({
              id: 1,
              employeeUid: 'emp_caller',
              name: '库管家',
              dispatchUids: ['emp_other'],
            })
          : null,
      );
    qbImpl = () =>
      makeQb(
        makeEmployee({ id: 2, employeeUid: 'emp_target', name: '采专员' }),
      );

    const res = await service.dispatchTask({
      callerUid: 'emp_caller',
      tenantId: 't1',
      targetKeyword: '采专员',
      task: 'x',
      dispatchDepth: 0,
    });

    expect(res.accepted).toBe(false);
    expect(res.message).toContain('不在「库管家」的可调用员工列表中');
    expect(savedTasks.length).toBe(0);
    expect(runnerCalls.length).toBe(0);
  });

  it('深度上限：超过 MAX_DISPATCH_DEPTH（默认 2）→ 拒绝', async () => {
    findOneImpl = (opt) =>
      Promise.resolve(
        opt.where.employeeUid === 'emp_caller'
          ? makeEmployee({
              id: 1,
              employeeUid: 'emp_caller',
              dispatchUids: ['emp_target'],
            })
          : null,
      );
    qbImpl = () => makeQb(makeEmployee({ id: 2, employeeUid: 'emp_target' }));

    // depth=1 → 二级派发允许；depth=2 → 三级拒绝
    const ok = await service.dispatchTask({
      callerUid: 'emp_caller',
      tenantId: 't1',
      targetKeyword: '采专员',
      task: 'x',
      dispatchDepth: 1,
    });
    expect(ok.accepted).toBe(true);

    const denied = await service.dispatchTask({
      callerUid: 'emp_caller',
      tenantId: 't1',
      targetKeyword: '采专员',
      task: 'x',
      dispatchDepth: 2,
    });
    expect(denied.accepted).toBe(false);
    expect(denied.message).toContain('已达派发深度上限');
  });

  it('用户直接交办：无 callerUid → dispatchedBy=user，不受边表限制', async () => {
    qbImpl = () => makeQb(makeEmployee({ id: 2, employeeUid: 'emp_target' }));

    const res = await service.dispatchTask({
      tenantId: 't1',
      targetKeyword: '采专员',
      task: '直接交办',
      dispatchDepth: 0,
    });

    expect(res.accepted).toBe(true);
    expect(savedTasks[0].dispatchedBy).toBe('user');
  });

  it('目标不存在 → 拒绝', async () => {
    qbImpl = () => makeQb(null);
    const res = await service.dispatchTask({
      tenantId: 't1',
      targetKeyword: '不存在的人',
      task: 'x',
      dispatchDepth: 0,
    });
    expect(res.accepted).toBe(false);
    expect(res.message).toContain('未找到员工或岗位');
    expect(savedTasks.length).toBe(0);
  });

  it('任务执行器未装配 → 拒绝派发，且不落孤儿任务记录', async () => {
    // 只装配查询所需能力，不 setTaskRunner → 应返回"任务执行器未装配"
    // 关键回归点：执行器预检已前置到落库之前，不能再留下永远 running 的孤儿记录
    const orphanTasks: Array<Partial<AiEmployeeTaskEntity>> = [];
    const employeeRepoNoRunner = {
      createQueryBuilder: () => makeQb(makeEmployee({ id: 2 })),
      create: (e: Partial<AiEmployeeEntity>) => e as AiEmployeeEntity,
      save: (e: Partial<AiEmployeeEntity>) =>
        Promise.resolve({ ...e, id: 99 } as AiEmployeeEntity),
    } as unknown as Repository<AiEmployeeEntity>;
    const taskRepoNoRunner = {
      create: (e: Partial<AiEmployeeTaskEntity>) => e as AiEmployeeTaskEntity,
      save: (e: Partial<AiEmployeeTaskEntity>) => {
        orphanTasks.push(e);
        return Promise.resolve({ ...e, id: 99 } as AiEmployeeTaskEntity);
      },
    } as unknown as Repository<AiEmployeeTaskEntity>;
    const svcNoRunner = new EmployeeService(
      employeeRepoNoRunner,
      taskRepoNoRunner,
    );
    const res = await svcNoRunner.dispatchTask({
      tenantId: 't1',
      targetKeyword: '采专员',
      task: 'x',
      dispatchDepth: 0,
    });
    expect(res.accepted).toBe(false);
    expect(res.message).toContain('任务执行器未装配');
  });

  it('下级执行抛异常 → 任务落 failed（含异常原因）', async () => {
    runnerImpl = () => Promise.reject(new Error('LLM 超时'));
    qbImpl = () => makeQb(makeEmployee({ id: 2, employeeUid: 'emp_target' }));

    const res = await service.dispatchTask({
      tenantId: 't1',
      targetKeyword: '采专员',
      task: 'x',
      dispatchDepth: 0,
    });
    expect(res.accepted).toBe(true);

    // 等待 fire-and-forget 的 catch 落库
    await new Promise((r) => setTimeout(r, 10));
    expect(savedTasks[0].status).toBe('failed');
    expect(savedTasks[0].resultSummary).toContain('LLM 超时');
  });

  it('completeTask：结果摘要截断到 4000 字符', async () => {
    await service.recordTask({
      employeeId: 1,
      tenantId: 't1',
      task: 't',
      dispatchedBy: 'user',
    });
    await service.completeTask(1, 'x'.repeat(5000), 'completed', 't1');
    expect(savedTasks[0].resultSummary?.length).toBe(4000);
    expect(savedTasks[0].status).toBe('completed');
  });

  // ── 租户隔离（2026-10-04 审查 P1-5）────────────────────────────
  // 任务表此前无 tenant_id，getTaskById/completeTask/markTaskRated 均按自增 id
  // 裸查裸改 —— 评分端点可枚举别家租户任务并读走原文（泄漏+投毒双重）。

  it('recordTask：写入租户归属（迁移 011）', async () => {
    await service.recordTask({
      employeeId: 1,
      tenantId: 't_real',
      task: 't',
      dispatchedBy: 'user',
    });
    expect(savedTasks[0].tenantId).toBe('t_real');
  });

  it('getTaskById：查询带租户条件（不得只按 id）', async () => {
    await service.getTaskById(1, 't_a');
    const findOneCalls = (taskRepo.findOne as jest.Mock).mock.calls as Array<
      [{ where?: Record<string, unknown> }]
    >;
    const where = findOneCalls.at(-1)?.[0]?.where ?? {};
    // 反测信号：若仍是 { id: 1 }，这里拿不到 tenantId
    expect(where.id).toBe(1);
    expect(where.tenantId).toBe('t_a');
  });

  it('completeTask：更新带租户条件（不得按 id 裸改）', async () => {
    await service.completeTask(1, 'done', 'completed', 't_a');
    const calls = (taskRepo.update as jest.Mock).mock.calls as Array<
      [Record<string, unknown>, unknown]
    >;
    expect(calls.at(-1)?.[0]).toEqual({ id: 1, tenantId: 't_a' });
  });

  it('markTaskRated：更新带租户条件（防给别家任务打标记）', async () => {
    await service.markTaskRated(1, 'sample', 't_a');
    const calls = (taskRepo.update as jest.Mock).mock.calls as Array<
      [Record<string, unknown>, unknown]
    >;
    expect(calls.at(-1)?.[0]).toEqual({ id: 1, tenantId: 't_a' });
  });

  it('端到端：别家租户按 id 读取任务 → 拿不到（枚举攻击失效）', async () => {
    await service.recordTask({
      employeeId: 1,
      tenantId: 't_a',
      task: 'A 租户的机密采购任务',
      dispatchedBy: 'user',
    });
    const id = savedTasks[0].id;

    // 本租户能读到
    const own = await service.getTaskById(id, 't_a');
    expect(own?.task).toBe('A 租户的机密采购任务');

    // 别家租户按同一个 id 读 → null（修复前会返回该任务原文）
    const other = await service.getTaskById(id, 't_b');
    expect(other).toBeNull();
  });

  it('端到端：别家租户按 id 改任务状态 → 改不动（防篡改）', async () => {
    await service.recordTask({
      employeeId: 1,
      tenantId: 't_a',
      task: 't',
      dispatchedBy: 'user',
    });
    const id = savedTasks[0].id;

    // 别家租户尝试篡改状态
    await service.completeTask(id, '恶意覆盖结果', 'completed', 't_b');
    expect(savedTasks[0].status).toBe('running');
    expect(savedTasks[0].resultSummary).toBeUndefined();

    // 本租户正常完成
    await service.completeTask(id, '正常结果', 'completed', 't_a');
    expect(savedTasks[0].status).toBe('completed');
    expect(savedTasks[0].resultSummary).toBe('正常结果');
  });

  it('list：回显 dispatchUids 边表，有下级标记为管理岗', async () => {
    findImpl = () =>
      Promise.resolve([
        makeEmployee({ id: 2, employeeUid: 'emp_a', dispatchUids: ['emp_b'] }),
        makeEmployee({ id: 3, employeeUid: 'emp_b', dispatchUids: null }),
      ]);
    const list = await service.list('t1');
    expect(list.length).toBe(2);
    expect(list[0].dispatchUids).toEqual(['emp_b']);
    expect(list[0].status).toBe('管理岗');
    expect(list[1].dispatchUids).toEqual([]);
    expect(list[1].status).toBe('就绪');
  });
});
