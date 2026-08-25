/**
 * TaskRunnerService 单元测试（批次2，文档 22.4）
 *
 * 覆盖：计划 CRUD、人工介入（approve/reject/cancel）、断点续跑、
 * 写步骤挂起令牌、确认回写后续跑、单步容错（failed 不中断后续）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { TaskRunnerService } from './task-runner.service';
import { AiExecutionPlanEntity } from '../../database/entities/ai-execution-plan.entity';
import type { PlanStep } from './agent.types';

type ExecutorMock = {
  executeToolCall: jest.Mock;
};

function makeRepo() {
  const store = new Map<number, AiExecutionPlanEntity>();
  let nextId = 1;
  return {
    store,
    save: jest.fn((entity: Partial<AiExecutionPlanEntity>) => {
      const id = entity.id ?? nextId++;
      const saved = { ...entity, id } as AiExecutionPlanEntity;
      store.set(id, saved);
      return saved;
    }),
    findOne: jest.fn(
      ({ where }: { where: { id: number; tenantId: string } }) =>
        [...store.values()].find(
          (e) => e.id === where.id && e.tenantId === where.tenantId,
        ) ?? null,
    ),
    find: jest.fn(({ where }: { where: { tenantId: string } }) =>
      [...store.values()].filter((e) => e.tenantId === where.tenantId),
    ),
    update: jest.fn(
      (criteria: { id: number }, patch: Partial<AiExecutionPlanEntity>) => {
        const e = store.get(criteria.id);
        if (e) {
          store.set(criteria.id, { ...e, ...patch });
        }
      },
    ),
    create: jest.fn((entity: Partial<AiExecutionPlanEntity>) => entity),
  };
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1',
    label: '查询库存',
    type: 'tool',
    tool: 'queryInventory',
    args: { sku: 'WLJ' },
    status: 'pending',
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRunner(
  overrides: {
    executor?: Partial<ExecutorMock>;
    selfHeal?: { heal: jest.Mock };
    confirmation?: { create: jest.Mock };
    registry?: { get: jest.Mock };
  } = {},
) {
  const repo = makeRepo();
  const executor = {
    executeToolCall: jest.fn().mockResolvedValue({
      success: true,
      data: { items: [{ sku: 'WLJ', qty: 52 }] },
    }),
    ...overrides.executor,
  };
  const registry = {
    get: jest.fn().mockReturnValue({
      risk: 'medium',
      needsReview: false,
      isWriteOperation: false,
    }),
    toToolDefinitionsForCategories: jest.fn().mockReturnValue([]),
    ...overrides.registry,
  };
  const confirmation = {
    create: jest.fn().mockResolvedValue({
      confirmationId: 'wg_test_token',
    }),
    ...overrides.confirmation,
  };
  const selfHeal = {
    heal: jest.fn().mockResolvedValue({
      ok: true,
      result: { success: true, data: { ok: 1 } },
      healLog: [],
      gaveUp: false,
    }),
    ...overrides.selfHeal,
  };
  const planner = {
    fillStepArgs: jest.fn().mockResolvedValue({ sku: 'WLJ' }),
  };
  const capture = {
    captureTask: jest.fn().mockResolvedValue(undefined),
  };
  const metrics = {
    recordRequest: jest.fn(),
    recordDuration: jest.fn(),
    recordTokens: jest.fn(),
    recordAgentIterations: jest.fn(),
  };
  const auditLogger = { logAiCall: jest.fn() };
  const router = {
    chatWithFallback: jest.fn(),
    getSystemScope: jest.fn(() => 'mgmt'),
  };
  const aiConfigService = {
    getResolvedConfig: jest.fn().mockResolvedValue({
      provider: 'glm',
      providerConfig: {},
      model: 'glm-4-flash',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt: null,
      source: 'platform',
    }),
  };

  const runner = new TaskRunnerService(
    repo as never,
    executor as never,
    registry as never,
    confirmation as never,
    selfHeal as never,
    planner as never,
    capture as never,
    metrics as never,
    auditLogger as never,
    router as never,
    aiConfigService as never,
  );
  return {
    runner,
    repo,
    executor,
    registry,
    confirmation,
    selfHeal,
    planner,
    capture,
  };
}

async function collect(
  gen: AsyncGenerator<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const e of gen) {
    events.push(e as Record<string, unknown>);
  }
  return events;
}

describe('TaskRunnerService', () => {
  it('createPlan/getPlan 往返：steps JSON 解析还原', async () => {
    const { runner } = makeRunner();
    const steps = [
      makeStep(),
      {
        ...makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      },
    ];
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '查库存',
      steps,
      createdBy: 'u1',
    });

    expect(plan.id).toBe(1);
    expect(plan.state).toBe('pending');
    expect(plan.steps).toHaveLength(2);

    const loaded = await runner.getPlan(1, 't1');
    expect(loaded?.goal).toBe('查库存');
    expect(loaded?.steps[0].tool).toBe('queryInventory');
    // 租户隔离
    expect(await runner.getPlan(1, 'other')).toBeNull();
  });

  it('approveStep：suspended → pending，计划可续跑', async () => {
    const { runner } = makeRunner();
    const step = makeStep({
      status: 'suspended',
      pendingToken: 'wg_x',
      preview: { operation: '创建销售单' },
    });
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '开单',
      steps: [
        step,
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });
    const result = await runner.approveStep(plan.id, 't1', 's1');
    expect(result.success).toBe(true);
    expect(result.plan?.steps[0].status).toBe('pending');
    expect(result.plan?.state).toBe('pending');
    // 非 suspended 步骤不可审批
    const again = await runner.approveStep(plan.id, 't1', 's1');
    expect(again.success).toBe(false);
  });

  it('rejectStep：suspended → skipped，计划继续', async () => {
    const { runner } = makeRunner();
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '开单',
      steps: [
        makeStep({ status: 'suspended', pendingToken: 'wg_x' }),
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });
    const result = await runner.rejectStep(plan.id, 't1', 's1', '客户取消');
    expect(result.success).toBe(true);
    expect(result.plan?.steps[0].status).toBe('skipped');
    expect(result.plan?.state).toBe('pending'); // end 仍 pending
  });

  it('cancelPlan：running → skipped', async () => {
    const { runner } = makeRunner();
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '长任务',
      steps: [makeStep()],
    });
    const result = await runner.cancelPlan(plan.id, 't1');
    expect(result.success).toBe(true);
    expect(result.plan?.state).toBe('skipped');
    expect(result.plan?.steps[0].status).toBe('skipped');
  });

  it('run：纯读计划自动执行至 success，done 事件携带统计', async () => {
    const { runner, executor } = makeRunner();
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '查五粮液库存',
      steps: [
        makeStep(),
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });

    const events = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    const done = events.find((e) => e.type === 'done') as Record<
      string,
      unknown
    >;
    expect(done).toBeDefined();
    expect(done.state).toBe('success');
    expect(executor.executeToolCall).toHaveBeenCalledTimes(1);
    // 读操作不产生确认令牌
    expect(events.some((e) => e.type === 'pending_write')).toBe(false);
    const persisted = await runner.getPlan(plan.id, 't1');
    expect(persisted?.state).toBe('success');
    expect(persisted?.steps[0].status).toBe('success');
  });

  it('run：写步骤返回预览 → 挂起令牌，流结束且计划 suspended', async () => {
    const { runner, confirmation } = makeRunner({
      executor: {
        executeToolCall: jest.fn().mockResolvedValue({
          success: true,
          preview: { operation: '创建销售单', summary: '红星商行 20 件五粮液' },
        }),
      },
    });
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '给红星商行开单20件五粮液',
      steps: [
        makeStep({ tool: 'createSalesOrder' }),
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });

    const events = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    expect(events.some((e) => e.type === 'pending_write')).toBe(true);
    expect(events.some((e) => e.type === 'await_confirm')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(confirmation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: plan.id,
        planStepId: 's1',
        toolName: 'createSalesOrder',
      }),
    );
    const persisted = await runner.getPlan(plan.id, 't1');
    expect(persisted?.state).toBe('suspended');
    expect(persisted?.steps[0].status).toBe('suspended');
    expect(persisted?.steps[0].pendingToken).toBe('wg_test_token');
  });

  it('markStepExecutedByToken 确认回写 → 续跑执行剩余步骤至 success', async () => {
    const { runner } = makeRunner({
      executor: {
        executeToolCall: jest
          .fn()
          .mockResolvedValueOnce({
            success: true,
            preview: { operation: '创建销售单' },
          })
          .mockResolvedValueOnce({ success: true, data: { orderId: 100 } }),
      },
    });
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '开单',
      steps: [
        makeStep({ tool: 'createSalesOrder' }),
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });

    // 第一轮：写步骤挂起
    const first = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    expect(first.some((e) => e.type === 'await_confirm')).toBe(true);

    // 确认执行回写
    const marked = await runner.markStepExecutedByToken('wg_test_token', 't1', {
      success: true,
      data: { orderId: 100 },
    });
    expect(marked?.steps[0].status).toBe('success');

    // 续跑：剩余 end 步骤
    const second = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    const done = second.find((e) => e.type === 'done') as Record<
      string,
      unknown
    >;
    expect(done).toBeDefined();
    expect(done.state).toBe('success');
    const persisted = await runner.getPlan(plan.id, 't1');
    expect(persisted?.steps[1].status).toBe('success');
  });

  it('单步容错：失败步骤标记 failed 后继续后续步骤，终态 failed', async () => {
    const { runner } = makeRunner({
      executor: {
        executeToolCall: jest
          .fn()
          .mockResolvedValueOnce({ success: false, error: '服务不可用' })
          .mockResolvedValueOnce({ success: true, data: { ok: 1 } }),
      },
      selfHeal: {
        heal: jest.fn().mockResolvedValue({
          ok: false,
          error: '服务不可用（自愈未恢复）',
          suggestion: { action: 'clarify', message: '请人工介入' },
          healLog: [{ at: 0, action: 'retry', detail: '重试失败' }],
          gaveUp: true,
        }),
      },
    });
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '多步骤任务',
      steps: [
        makeStep({ tool: 'api_query_stock_warnings' }),
        makeStep({ id: 's2', label: '查询订单', tool: 'api_query_orders' }),
        makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
      ],
    });

    const events = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    const failedSteps = events.filter(
      (e) => e.type === 'agent_step' && e.status === 'failed',
    );
    expect(failedSteps.length).toBeGreaterThan(0);
    const done = events.find((e) => e.type === 'done') as Record<
      string,
      unknown
    >;
    expect(done).toBeDefined();
    expect(done.state).toBe('failed');
    // 第二步仍在失败后继续执行（容错）
    const persisted = await runner.getPlan(plan.id, 't1');
    expect(persisted?.steps[0].status).toBe('failed');
    expect(persisted?.steps[1].status).toBe('success');
  });

  it('run：已结束计划拒绝再次执行', async () => {
    const { runner } = makeRunner();
    const plan = await runner.createPlan({
      tenantId: 't1',
      goal: '查库存',
      steps: [makeStep()],
    });
    await runner.cancelPlan(plan.id, 't1');
    const events = await collect(runner.run(plan.id, 't1', { tenantId: 't1' }));
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });
});
