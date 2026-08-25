/**
 * AgentEngineService 单元测试（批次2，文档 22 章门面）
 *
 * 覆盖：规划+执行（run）、仅规划（createPlan）、续跑（runPlan）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { AgentEngineService } from './agent-engine.service';
import { PlannerService } from './planner.service';
import { TaskRunnerService } from './task-runner.service';
import type { PlanStep } from './agent.types';

function makeStep(): PlanStep {
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
  };
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

describe('AgentEngineService', () => {
  it('run：规划 → 落库 → 执行，产出事件流', async () => {
    const step = makeStep();
    const planner = { plan: jest.fn().mockResolvedValue([step]) };
    const runner = {
      createPlan: jest.fn().mockResolvedValue({
        id: 7,
        tenantId: 't1',
        goal: '查五粮液库存',
        steps: [step],
        state: 'pending',
      }),
      run: jest.fn().mockImplementation(function* () {
        yield {
          type: 'agent_step',
          planId: 7,
          stepId: 'plan',
          label: '计划启动',
          status: 'running',
        };
        yield {
          type: 'done',
          planId: 7,
          state: 'success',
          usage: { steps: 1 },
        };
      }),
    };
    const engine = new AgentEngineService(
      planner as unknown as PlannerService,
      runner as unknown as TaskRunnerService,
    );

    const events = await collect(
      engine.run({ goal: '查五粮液库存', tenantId: 't1' }),
    );

    expect(planner.plan).toHaveBeenCalledWith(
      expect.objectContaining({ goal: '查五粮液库存', tenantId: 't1' }),
    );
    expect(runner.createPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        goal: '查五粮液库存',
        steps: [step],
      }),
    );
    expect(events.some((e) => (e as { type?: string }).type === 'done')).toBe(
      true,
    );
  });

  it('createPlan：仅规划，不执行', async () => {
    const planner = { plan: jest.fn().mockResolvedValue([makeStep()]) };
    const runner = {
      createPlan: jest.fn().mockResolvedValue({ id: 1, state: 'pending' }),
      run: jest.fn(),
    };
    const engine = new AgentEngineService(
      planner as unknown as PlannerService,
      runner as unknown as TaskRunnerService,
    );

    const plan = await engine.createPlan({
      goal: '盘点库存',
      tenantId: 't1',
    });
    expect(plan.id).toBe(1);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('runPlan：续跑委托 TaskRunner，透传上下文', async () => {
    const planner = { plan: jest.fn() };
    const run = jest.fn().mockImplementation(function* () {
      yield { type: 'done', planId: 9, state: 'success', usage: {} };
    });
    const runner = {
      createPlan: jest.fn(),
      run,
    };
    const engine = new AgentEngineService(
      planner as unknown as PlannerService,
      runner as unknown as TaskRunnerService,
    );

    const events = await collect(
      engine.runPlan(9, {
        goal: '',
        tenantId: 't1',
        authToken: 'jwt',
        model: 'glm',
      }),
    );
    expect(run).toHaveBeenCalledWith(
      9,
      't1',
      expect.objectContaining({
        tenantId: 't1',
        authToken: 'jwt',
        model: 'glm',
      }),
    );
    expect(events.length).toBe(1);
  });
});
