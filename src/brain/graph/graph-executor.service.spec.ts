/**
 * GraphExecutorService 单元测试
 *
 * 覆盖：线性图按序执行、条件分支、工具失败中止、断点续跑、未知图
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ToolExecutor } from '../../tools/tool-executor';
import { ToolRegistry } from '../../tools/tool-registry';
import type { ToolContext } from '../../tools/tool.interface';
import { CheckpointerService } from './checkpointer.service';
import { GraphExecutorService } from './graph-executor.service';
import { GraphDefinition, GraphState } from './graph.types';
import { ReviewTaskService } from '../review/review-task.service';
import { EvidenceLedgerService } from '../evidence/evidence-ledger.service';

/** 内存版 Checkpointer（模拟 Redis 持久化，便于断点测试） */
function makeCheckpointer() {
  const store = new Map<string, GraphState>();
  return {
    save: jest.fn((s: GraphState) => {
      store.set(`ai:graph:${s.tenantId}:${s.sessionId}`, s);
      return Promise.resolve();
    }),
    load: jest.fn((t: string, s: string) => {
      return Promise.resolve(store.get(`ai:graph:${t}:${s}`) ?? null);
    }),
    clear: jest.fn((t: string, s: string) => {
      store.delete(`ai:graph:${t}:${s}`);
      return Promise.resolve();
    }),
  };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenantId: 't1',
    userId: 'u1',
    sessionId: 's1',
    role: 'STORE_MANAGER',
    authToken: 'jwt',
    ...overrides,
  };
}

const LINEAR_GRAPH: GraphDefinition = {
  id: 'test_linear',
  name: '线性测试图',
  entry: 'step1',
  nodes: [
    {
      id: 'step1',
      label: '第一步',
      type: 'tool',
      tool: 'searchCustomer',
      args: { name: '红星商行' },
      next: 'step2',
    },
    {
      id: 'step2',
      label: '第二步',
      type: 'tool',
      tool: 'checkInventory',
      args: { productName: '五粮液' },
      next: 'end',
    },
    { id: 'end', label: '完成', type: 'end' },
  ],
};

const BRANCH_GRAPH: GraphDefinition = {
  id: 'test_branch',
  name: '条件分支图',
  entry: 'check',
  nodes: [
    {
      id: 'check',
      label: '判断',
      type: 'condition',
      condition: (state) =>
        state.results['step1'] && state.results['step1'] === 'ok'
          ? 'success'
          : 'fallback',
    },
    {
      id: 'success',
      label: '成功分支',
      type: 'tool',
      tool: 'searchCustomer',
      next: 'end',
    },
    {
      id: 'fallback',
      label: '回退分支',
      type: 'tool',
      tool: 'searchCustomer',
      next: 'end',
    },
    { id: 'end', label: '完成', type: 'end' },
  ],
};

/** 域 Agent 图（P0-3）：agent 节点带工具白名单 */
const AGENT_GRAPH: GraphDefinition = {
  id: 'test_agent',
  name: '域Agent测试图',
  entry: 'agent1',
  nodes: [
    {
      id: 'agent1',
      label: '客服域Agent',
      type: 'agent',
      agent: {
        systemPrompt: '你是客服域 Agent，可查询订单与客户。',
        tools: ['searchCustomer', 'querySaleBills'],
        maxToolRounds: 2,
      },
      next: 'end',
    },
    { id: 'end', label: '完成', type: 'end' },
  ],
};

function makeRegistryMock() {
  return {
    toToolDefinitions: jest.fn(() => [
      {
        type: 'function',
        function: {
          name: 'searchCustomer',
          description: '搜索客户',
          parameters: { type: 'object', properties: {} },
        },
      },
      {
        type: 'function',
        function: {
          name: 'querySaleBills',
          description: '查询销售单',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]),
    has: jest.fn((name: string) =>
      ['searchCustomer', 'querySaleBills'].includes(name),
    ),
    get: jest.fn((name: string) =>
      name === 'searchCustomer' || name === 'querySaleBills'
        ? { name, risk: 'low', needsReview: false }
        : undefined,
    ),
  };
}

function makeExecutor(
  executorMock: { executeToolCall?: jest.Mock; executeToolCalls?: jest.Mock },
  checkpointer: ReturnType<typeof makeCheckpointer>,
  reviewMock?: {
    create?: jest.Mock;
    get?: jest.Mock;
  },
) {
  const review = reviewMock ?? {
    create: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
  };
  const evidence = {
    recordWrite: jest.fn(),
    verify: jest.fn().mockReturnValue({ ok: true, issues: [] }),
  };
  return new GraphExecutorService(
    executorMock as unknown as ToolExecutor,
    checkpointer as unknown as CheckpointerService,
    makeRegistryMock() as unknown as ToolRegistry,
    review as unknown as ReviewTaskService,
    evidence as unknown as EvidenceLedgerService,
  );
}

async function collectEvents(
  executor: GraphExecutorService,
  graph: GraphDefinition,
  ctx: ToolContext,
) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  for await (const e of executor.execute(graph, ctx.sessionId, ctx)) {
    events.push(e);
  }
  return events;
}

describe('GraphExecutorService', () => {
  it('线性图按序执行工具并产出事件流', async () => {
    const executorMock = {
      executeToolCall: jest.fn().mockResolvedValue({
        success: true,
        data: { id: 1 },
      }),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor(executorMock, checkpointer);

    const events = await collectEvents(executor, LINEAR_GRAPH, makeCtx());

    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'node_start',
        'tool_start',
        'tool_result',
        'node_end',
        'graph_done',
      ]),
    );
    expect(executorMock.executeToolCall).toHaveBeenCalledTimes(2);
    // 完成后检查点已清除
    expect(checkpointer.clear).toHaveBeenCalled();
  });

  it('condition 节点按条件流转到成功分支', async () => {
    const executorMock = {
      executeToolCall: jest
        .fn()
        .mockResolvedValue({ success: true, data: 'ok' }),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor(executorMock, checkpointer);
    // 预置 step1 结果驱动条件
    const ctx = makeCtx();
    await checkpointer.save({
      graphId: 'test_branch',
      tenantId: 't1',
      sessionId: 's1',
      currentNodeId: 'check',
      status: 'running',
      results: { step1: 'ok' },
      nodeOrder: [],
      history: [],
      updatedAt: 0,
    });

    const events = await collectEvents(executor, BRANCH_GRAPH, ctx);
    expect(
      events.some((e) => e.type === 'node_start' && e.nodeId === 'success'),
    ).toBe(true);
    expect(
      events.some((e) => e.type === 'node_start' && e.nodeId === 'fallback'),
    ).toBe(false);
  });

  it('工具执行失败时中止并写错误状态', async () => {
    const executorMock = {
      executeToolCall: jest.fn().mockResolvedValue({
        success: false,
        error: '库存不足',
      }),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor(executorMock, checkpointer);

    const events = await collectEvents(executor, LINEAR_GRAPH, makeCtx());
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent?.message)).toContain('库存不足');
    // 状态保存为 error（可查）
    const state = await checkpointer.load('t1', 's1');
    expect(state?.status).toBe('error');
  });

  it('从断点续跑：已有 Checkpoint 时从 currentNodeId 继续', async () => {
    const executorMock = {
      executeToolCall: jest
        .fn()
        .mockResolvedValue({ success: true, data: { done: true } }),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor(executorMock, checkpointer);
    // 断点：已完成 step1，从 step2 续跑
    await checkpointer.save({
      graphId: 'test_linear',
      tenantId: 't1',
      sessionId: 's1',
      currentNodeId: 'step2',
      status: 'running',
      results: { step1: { id: 1 } },
      nodeOrder: ['step1'],
      history: [{ nodeId: 'step1', label: '第一步', success: true }],
      updatedAt: 0,
    });

    const events = await collectEvents(executor, LINEAR_GRAPH, makeCtx());
    // step1 不应重新执行（从断点继续）
    const step1Starts = events.filter(
      (e) => e.type === 'node_start' && e.nodeId === 'step1',
    );
    expect(step1Starts).toHaveLength(0);
    expect(executorMock.executeToolCall).toHaveBeenCalledTimes(1);
  });

  it('getGraph 未知图返回 null，listGraphs 含内置图', () => {
    const executor = makeExecutor({}, makeCheckpointer());
    expect(executor.getGraph('sale_create_graph')).not.toBeNull();
    expect(executor.getGraph('not_exist')).toBeNull();
    expect(executor.listGraphs().length).toBeGreaterThanOrEqual(1);
  });

  it('域 Agent 节点：调用白名单工具后生成最终文本（P0-3）', async () => {
    // 构造单次 done 的 AsyncGenerator（value = ChatResult）
    function makeChatResult(value: unknown) {
      return {
        next: () => Promise.resolve({ done: true as const, value }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
    // provider.chat：第一轮返回 tool_calls，第二轮返回纯文本
    const chatMock = jest.fn();
    chatMock
      .mockImplementationOnce(() =>
        makeChatResult({
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: {
                name: 'searchCustomer',
                arguments: '{"name":"红星商行"}',
              },
            },
          ],
          prompt_tokens: 10,
          completion_tokens: 5,
        }),
      )
      .mockImplementationOnce(() =>
        makeChatResult({
          content: '已查询到客户红星商行',
          prompt_tokens: 10,
          completion_tokens: 5,
        }),
      );
    const provider = { chat: chatMock } as unknown as {
      chat: (messages: unknown[], opts?: unknown) => AsyncGenerator<string>;
    };
    const executorMock = {
      executeToolCalls: jest.fn().mockResolvedValue([
        {
          role: 'tool' as const,
          tool_call_id: 'call_1',
          content: JSON.stringify({
            success: true,
            data: { id: 1, name: '红星商行' },
          }),
        },
      ]),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor(executorMock, checkpointer);

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const e of executor.execute(
      AGENT_GRAPH,
      's1',
      makeCtx(),
      provider as never,
    )) {
      events.push(e);
    }

    expect(executorMock.executeToolCalls).toHaveBeenCalledTimes(1);
    const toolResultEvent = events.find(
      (e) => e.type === 'tool_result' && e.tool === 'call_1',
    );
    expect(toolResultEvent).toBeDefined();
    expect(
      events.some((e) => e.type === 'node_end' && e.nodeId === 'agent1'),
    ).toBe(true);
    // 完成后检查点清除（不残留脏状态）
    expect(checkpointer.clear).toHaveBeenCalled();
  });

  it('高危工具节点触发人工闸：生成工单并暂停图', async () => {
    const highRiskGraph: GraphDefinition = {
      id: 'test_high',
      name: '高危图',
      entry: 'publish',
      nodes: [
        {
          id: 'publish',
          label: '发布（高危）',
          type: 'tool',
          tool: 'searchCustomer',
          needsReview: true,
          reviewNote: '发布需人工审核',
          next: 'end',
        },
        { id: 'end', label: '完成', type: 'end' },
      ],
    };
    const reviewMock = {
      create: jest.fn().mockResolvedValue({
        id: 99,
        payload: { nodeLabel: '发布（高危）' },
      }),
      get: jest.fn().mockResolvedValue({ status: 'pending' }),
    };
    const checkpointer = makeCheckpointer();
    const executor = makeExecutor({}, checkpointer, reviewMock);

    const events: Array<{ type: string; [k: string]: unknown }> = [];
    for await (const e of executor.execute(highRiskGraph, 's1', makeCtx())) {
      events.push(e);
    }

    const reviewEvent = events.find((e) => e.type === 'review_required');
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent?.reviewId).toBe(99);
    expect(reviewMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'searchCustomer',
        nodeId: 'publish',
      }),
    );
    // 状态暂停
    const state = await checkpointer.load('t1', 's1');
    expect(state?.status).toBe('paused');
    expect(state?.pendingReviewId).toBe(99);
  });

  it('暂停态审核通过后续跑，pending 则继续等待', async () => {
    const graph: GraphDefinition = {
      id: 'test_resume',
      name: '续跑图',
      entry: 'step1',
      nodes: [
        {
          id: 'step1',
          label: '第一步',
          type: 'tool',
          tool: 'searchCustomer',
          next: 'end',
        },
        { id: 'end', label: '完成', type: 'end' },
      ],
    };
    // pending：返回等待，不执行节点
    const pendingReview = {
      create: jest.fn(),
      get: jest.fn().mockResolvedValue({ status: 'pending' }),
    };
    const checkpointer = makeCheckpointer();
    await checkpointer.save({
      graphId: 'test_resume',
      tenantId: 't1',
      sessionId: 's1',
      currentNodeId: 'step1',
      status: 'paused',
      results: {},
      nodeOrder: ['step1'],
      history: [],
      pendingReviewId: 7,
      updatedAt: 0,
    });
    const executorPending = makeExecutor({}, checkpointer, pendingReview);
    const events1: Array<{ type: string }> = [];
    for await (const e of executorPending.execute(graph, 's1', makeCtx())) {
      events1.push(e);
    }
    expect(events1.some((e) => e.type === 'review_required')).toBe(true);
    expect(events1.some((e) => e.type === 'graph_done')).toBe(false);

    // approved：继续执行
    const approvedReview = {
      create: jest.fn(),
      get: jest.fn().mockResolvedValue({ status: 'approved' }),
    };
    const checkpointer2 = makeCheckpointer();
    await checkpointer2.save({
      graphId: 'test_resume',
      tenantId: 't1',
      sessionId: 's1',
      currentNodeId: 'step1',
      status: 'paused',
      results: {},
      nodeOrder: ['step1'],
      history: [],
      pendingReviewId: 7,
      updatedAt: 0,
    });
    const executorApproved = makeExecutor(
      {
        executeToolCall: jest
          .fn()
          .mockResolvedValue({ success: true, data: {} }),
      },
      checkpointer2,
      approvedReview,
    );
    const events2: Array<{ type: string }> = [];
    for await (const e of executorApproved.execute(graph, 's1', makeCtx())) {
      events2.push(e);
    }
    expect(events2.some((e) => e.type === 'graph_done')).toBe(true);
  });
});
