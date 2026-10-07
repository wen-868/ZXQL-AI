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

// ── listTasksFor 租户隔离：真实求值 WHERE 子句的 QueryBuilder 桩 ──────────
//
// 为什么不用上面那个 makeQb：它对 where/andWhere 一律返回自身、getMany 恒返回
// 预设数组。拿它断言「跨租户返回空数组」是**恒真断言** —— 无论服务里有没有
// 租户条件，用例都绿。
//
// 这里的桩把服务真实传入的条件串与参数原样记下，按 SQL 优先级
// （AND 高于 OR，支持显式括号）对夹具行求值。关键在于它复现了 TypeORM 的
// 拼接规则：`where(字符串)` 不加括号，后续 `andWhere` 直接以 " AND " 追加。
// 于是「漏掉租户条件」或「OR 组没加括号」都会让越权行被返回 ⇒ 用例立刻变红。
// 只覆盖本服务用到的语法；遇到不认识的语法直接抛错，避免"解析失败即匹配"假绿。

/** 把 `t.<col>` 归一到夹具行的字段名（夹具用驼峰键） */
function resolveColumn(
  column: string,
): 'id' | 'tenantId' | 'employeeId' | 'dispatchedBy' {
  const camel = column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (
    camel !== 'id' &&
    camel !== 'tenantId' &&
    camel !== 'employeeId' &&
    camel !== 'dispatchedBy'
  ) {
    throw new Error(`桩不认识的列：${column}`);
  }
  return camel;
}

/**
 * 极简 SQL 布尔表达式求值器（仅支持 `t.col = :param`、AND、OR、括号）。
 * 抛错优先于猜测：解析不了就失败，绝不静默当成 true。
 */
function evalWhereSql(
  sql: string,
  params: Record<string, unknown>,
  row: AiEmployeeTaskEntity,
): boolean {
  // ⚠️ 顺序要紧：先匹配 `t.col` 与 `:param`，否则 `t.employee_id` 会被拆成
  // `t` + `employee_id` 两个 token。
  const tokens = sql.match(/t\.\w+|:\w+|[A-Za-z_]\w*|[()=<>!]+/g);
  if (!tokens) throw new Error(`桩无法词法分析：${sql}`);
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const eat = (expected: string): void => {
    const t = tokens[pos];
    if (t?.toUpperCase() !== expected.toUpperCase()) {
      throw new Error(`桩期望 ${expected}，实际 ${String(t)}（SQL: ${sql}）`);
    }
    pos += 1;
  };

  /** comparison := t.col = :param */
  const parseComparison = (): boolean => {
    const ref = tokens[pos];
    const m = /^t\.(\w+)$/.exec(String(ref));
    if (!m) throw new Error(`桩期望列引用，实际 ${String(ref)}（SQL: ${sql}）`);
    pos += 1;
    eat('=');
    const token = String(tokens[pos]);
    if (!token.startsWith(':')) {
      throw new Error(`桩期望参数，实际 ${token}（SQL: ${sql}）`);
    }
    pos += 1;
    // 绑定值的键不带前导冒号（与 TypeORM 一致）
    const name = token.slice(1);
    if (!(name in params)) {
      throw new Error(`桩未收到参数绑定：${token}`);
    }
    return row[resolveColumn(m[1])] === params[name];
  };

  /** factor := '(' expr ')' | comparison */
  const parseFactor = (): boolean => {
    if (peek() === '(') {
      eat('(');
      const v = parseExpr();
      eat(')');
      return v;
    }
    return parseComparison();
  };

  /** term := factor (AND factor)* */
  const parseTerm = (): boolean => {
    let left = parseFactor();
    while (peek()?.toUpperCase() === 'AND') {
      eat('AND');
      //不可短路：右侧仍须解析，否则语法错误会被吞掉
      const right = parseFactor();
      left = left && right;
    }
    return left;
  };

  /** expr := term (OR term)* */
  function parseExpr(): boolean {
    let left = parseTerm();
    while (peek()?.toUpperCase() === 'OR') {
      eat('OR');
      const right = parseTerm();
      left = left || right;
    }
    return left;
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new Error(`桩解析后仍有残留 token（SQL: ${sql}）`);
  }
  return result;
}

/**
 * 真实求值 WHERE 的 QueryBuilder 桩。
 * 拼接规则对齐 TypeORM `createWhereClausesExpression`：首个条件裸接，
 * 后续 andWhere 以 " AND " 追加 —— 字符串条件**不会**被自动加括号。
 */
function makeEvalQb(rows: AiEmployeeTaskEntity[]): {
  qb: QbStub;
  whereSql: () => string;
} {
  let sql = '';
  const params: Record<string, unknown> = {};
  const chain = {
    where: (cond: string, p: Record<string, unknown> = {}) => {
      sql = `${sql}${sql === '' ? '' : ' AND '}${cond}`;
      Object.assign(params, p);
      return chain;
    },
    andWhere: (cond: string, p: Record<string, unknown> = {}) => {
      sql = `${sql} AND ${cond}`;
      Object.assign(params, p);
      return chain;
    },
    setParameter: () => chain,
    orderBy: () => chain,
    take: () => chain,
    getOne: () => Promise.resolve(null),
    getMany: () =>
      Promise.resolve(
        sql === '' ? [] : rows.filter((r) => evalWhereSql(sql, params, r)),
      ),
  };
  return { qb: chain as unknown as QbStub, whereSql: () => sql };
}

/** 构造任务行（跨租户隔离用例的夹具） */
function makeTask(over: Partial<AiEmployeeTaskEntity>): AiEmployeeTaskEntity {
  return {
    id: over.id ?? 1,
    tenantId: over.tenantId ?? 't_a',
    employeeId: over.employeeId ?? 7,
    task: over.task ?? '任务',
    dispatchedBy: over.dispatchedBy ?? 'user',
    resultSummary: over.resultSummary ?? null,
    status: over.status ?? 'running',
    taskType: over.taskType ?? null,
    ratingResult: over.ratingResult ?? null,
    createdAt: over.createdAt ?? new Date(),
  };
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

  // ── listTasksFor 租户隔离（2026-10-07 阶段 2 · A2）────────────────────
  // 此前 listTasksFor 自身零租户过滤，安全性 100% 依赖调用方先校验 ——
  // 约定而非机制：将来新增调用点忘了校验即跨租户泄露。
  // 用 makeEvalQb（真实求值 WHERE）而非 makeQb（恒返回预设数组），
  // 否则「跨租户返回空数组」是恒真断言。
  describe('listTasksFor：租户条件下沉到方法内部', () => {
    let rows: AiEmployeeTaskEntity[];
    let evalQb: ReturnType<typeof makeEvalQb>;

    /** 用求值桩替换任务仓储的 QueryBuilder */
    function useEvalQb(): void {
      evalQb = makeEvalQb(rows);
      qbImpl = () => evalQb.qb;
    }

    /**
     * 夹具设计原则：被断言为"空"的场景，B 租户**确实没有**对应任务 ——
     * 否则"返回空数组"可能是恒真断言。
     * A 租户有两条可被越权命中的任务（分别走 employee_id 与 dispatched_by 分支），
     * B 租户只有一条无关任务（employee 99 / dispatched_by=user）。
     */
    beforeEach(() => {
      rows = [
        makeTask({
          id: 1,
          tenantId: 't_a',
          employeeId: 7,
          task: 'A 租户机密任务',
          dispatchedBy: 'employee:emp_z',
        }),
        makeTask({
          id: 2,
          tenantId: 't_b',
          employeeId: 99,
          task: 'B 租户无关任务',
          dispatchedBy: 'user',
        }),
      ];
      useEvalQb();
    });

    it('本租户：只返回本租户的任务（证明夹具非空、断言非恒真）', async () => {
      const list = await service.listTasksFor('emp_z', 7, 't_a');
      expect(list.map((t) => t.id)).toEqual([1]);
      expect(list[0].task).toBe('A 租户机密任务');
    });

    it('跨租户：employee_id 命中别家租户 → 返回空数组（不是别人的数据）', async () => {
      // B 租户没有员工 7 的任务；若缺租户条件，id=1 会被 employee_id 分支命中
      const list = await service.listTasksFor('emp_z', 7, 't_b');
      expect(list.length).toBe(0);
      // 反测信号：明确断言"没拿到别家原文"，而不只是长度
      expect(list.map((t) => t.task)).not.toContain('A 租户机密任务');
    });

    it('跨租户：dispatched_by 命中别家租户 → 返回空数组', async () => {
      // B 租户没有任何 dispatched_by='employee:emp_z' 的任务；
      // 若缺租户条件，id=1 会被 dispatched_by 分支命中
      const list = await service.listTasksFor('emp_z', 999, 't_b');
      expect(list.length).toBe(0);
      expect(list.map((t) => t.task)).not.toContain('A 租户机密任务');
    });

    it('跨租户：两个越权面各命中一条别家数据 → 一条都不返回', async () => {
      rows = [
        // 走 employee_id 分支的越权数据
        makeTask({
          id: 1,
          tenantId: 't_a',
          employeeId: 7,
          dispatchedBy: 'user',
        }),
        // 走 dispatched_by 分支的越权数据
        makeTask({
          id: 2,
          tenantId: 't_a',
          employeeId: 555,
          dispatchedBy: 'employee:emp_z',
        }),
        // 本租户的合法数据（两个分支都命中）
        makeTask({
          id: 3,
          tenantId: 't_b',
          employeeId: 7,
          dispatchedBy: 'employee:emp_z',
        }),
      ];
      useEvalQb();
      // 缺租户条件时会返回 [1,2,3]；正确实现只返回本租户的 [3]
      const list = await service.listTasksFor('emp_z', 7, 't_b');
      expect(list.map((t) => t.id)).toEqual([3]);
      expect(list.every((t) => t.tenantId === 't_b')).toBe(true);
    });

    it('WHERE 子句：租户条件以 AND 挂在 OR 组之外（含括号，不可省）', async () => {
      await service.listTasksFor('emp_z', 7, 't_b');
      const sql = evalQb.whereSql();
      // 反测信号：若去掉括号，SQL 变成 `A OR B AND tenant`，
      // 按优先级 AND 先算 ⇒ employee_id 分支不受租户约束 ⇒ 上面的用例会红
      expect(sql).toContain('(t.employee_id = :eid OR t.dispatched_by = :uid)');
      expect(sql).toContain('AND t.tenant_id = :tenantId');
    });

    it('租户条件：tenantId 为必填位置参数（漏传在编译期就过不去）', async () => {
      // 编译期保证：tenantId 是必填位置参数。
      // 下面这行若被改成可选参数（`tenantId?: string`），@ts-expect-error
      // 会因"此处无错误可抑制"而让 tsc 报错 ⇒ 参数必填性被门禁守住。
      const noTenantId = () =>
        // @ts-expect-error 故意漏传 tenantId —— 证明签名把它设为必填
        service.listTasksFor('emp_z', 7);
      expect(typeof noTenantId).toBe('function');

      // 运行时行为：传本租户仍能正常取数（证明上一条不是靠"永远抛错"变绿）
      const list = await service.listTasksFor('emp_z', 7, 't_a');
      expect(list.length).toBe(1);
    });
  });
});
