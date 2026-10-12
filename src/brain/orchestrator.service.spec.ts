/**
 * Orchestrator（Agent Loop 核心）同名 spec — R101-AI-26 ⑥
 *
 * 背景：`orchestrator.service.ts`（1600+ 行）此前**无同名 spec**，只被
 * v2-handle.service.spec.ts / chat.controller.revoke.spec.ts 等间接引用。
 *
 * 本文件覆盖 4 条核心路径（均走真实 `run()` 生成器，只桩掉依赖）：
 * 1. 主流程：上下文构建 → LLM 流式 → 工具调用 → 回填 → 最终文本
 * 2. 工具调用失败**不中断 Loop**（失败结果回填后继续下一轮）
 * 3. 达到最大轮次 ⇒ 退出并下发 AI_009 错误事件（不无限循环）
 * 4. 撤销入口对齐：写工具返回 preview ⇒ 挂起确认（`confirmationService.create`
 *    铸令牌，即后续 confirm→registerExecuted（3 分钟撤销窗口）的入口）；
 *    撤销 HTTP 端点本身由 `chat.controller.revoke.spec.ts` 覆盖，此处不重复造。
 *
 * mock 写法照 `v2-handle.service.spec.ts`（普通对象 + overrides），不自造第二套范式。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-13
 */
import { Orchestrator, MAX_AGENT_ITERATIONS } from './orchestrator.service';
import type { OrchestratorParams } from './orchestrator.service';

/** 流式生成器替身：先吐增量文本，再以 done=true 返回最终 ChatResult */
function streamOf(deltas: string[], result: Record<string, unknown>) {
  let i = 0;
  return {
    next: jest.fn(() => {
      if (i < deltas.length) {
        const value = deltas[i];
        i += 1;
        return Promise.resolve({ value, done: false });
      }
      return Promise.resolve({ value: result, done: true });
    }),
  };
}

/** 一次 LLM 调用的结果（含/不含 tool_calls） */
function chatResult(
  content: string,
  toolCalls: unknown[] = [],
): Record<string, unknown> {
  return {
    content,
    tool_calls: toolCalls,
    prompt_tokens: 10,
    completion_tokens: 5,
    fallback: { used: false },
  };
}

function makeToolCall(name: string, args: unknown = {}) {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

interface Harness {
  orchestrator: Orchestrator;
  deps: ReturnType<typeof makeDeps>;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  const productTool = {
    name: 'searchProduct',
    description: '查商品',
    category: 'product',
    isWriteOperation: false,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: jest.fn(),
  };
  const writeTool = {
    name: 'createSalesOrder',
    description: '创建销售单',
    category: 'order',
    isWriteOperation: true,
    parameters: { type: 'object', properties: {}, required: [] },
    execute: jest.fn(),
  };

  return {
    executor: {
      executeToolCall: jest.fn().mockResolvedValue({
        success: true,
        data: { ok: true },
      }),
    },
    registry: {
      list: jest.fn().mockReturnValue([productTool, writeTool]),
      get: jest.fn((name: string) =>
        name === 'createSalesOrder' ? writeTool : productTool,
      ),
      toToolDefinitionsForCategories: jest.fn().mockReturnValue([]),
    },
    auditLogger: { logAiCall: jest.fn(), logToolExecution: jest.fn() },
    aiConfigService: {
      getResolvedConfig: jest.fn().mockResolvedValue({
        provider: 'deepseek',
        model: 'deepseek-chat',
        systemPrompt: '你是智享助手',
        source: 'platform',
        temperature: 0.7,
        maxTokens: 1024,
      }),
    },
    tenantContext: {
      getData: jest.fn().mockReturnValue({
        tenantId: 't1',
        userId: 'u1',
        role: 'STORE_MANAGER',
      }),
    },
    contextBuilder: {
      build: jest.fn().mockResolvedValue([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ]),
    },
    memoryManager: {
      generateSessionId: jest.fn().mockReturnValue('sess-gen'),
      loadHistory: jest.fn().mockResolvedValue([]),
      saveHistory: jest.fn().mockResolvedValue(undefined),
      archiveSession: jest.fn().mockResolvedValue(undefined),
    },
    confirmationService: {
      create: jest.fn().mockResolvedValue({
        confirmationId: 'wg_orch_token',
        docType: 'createSalesOrder',
        risk: 'medium',
        operationLabel: '创建销售单',
      }),
    },
    graphExecutor: { getGraph: jest.fn(), execute: jest.fn() },
    router: {
      route: jest.fn().mockReturnValue({
        providerName: 'deepseek',
        provider: {
          name: 'deepseek',
          chatSync: jest.fn().mockResolvedValue({ content: '', ok: true }),
        },
        reason: 'test',
      }),
      getSystemScope: jest.fn().mockReturnValue('mgmt'),
      chatWithFallback: jest.fn(),
    },
    learning: {
      absorb: jest.fn().mockResolvedValue(undefined),
      noteConversation: jest.fn().mockResolvedValue(undefined),
    },
    extractor: {
      tryEnhance: jest.fn().mockResolvedValue({
        used: false,
        needsClarification: false,
      }),
    },
    capture: {
      captureCorrection: jest.fn().mockResolvedValue(undefined),
      captureTask: jest.fn().mockResolvedValue(undefined),
    },
    metrics: {
      recordPlan: jest.fn(),
      recordToolRetry: jest.fn(),
      recordRequest: jest.fn(),
      recordDuration: jest.fn(),
      recordTokens: jest.fn(),
      recordAgentIterations: jest.fn(),
    },
    billing: { consume: jest.fn().mockResolvedValue(undefined) },
    // 自检/自动重试默认关闭：用 get 的 fallback 值决定（见下）
    configService: {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'ENABLE_ANSWER_SELF_CHECK') return 'false';
        if (key === 'ENABLE_TOOL_AUTO_RETRY') return 'false';
        return fallback;
      }),
    },
    selfCheck: { verify: jest.fn().mockResolvedValue({ ok: true }) },
    knowledgeRules: { getRulesContext: jest.fn().mockReturnValue('') },
    evidence: { recordWrite: jest.fn(), recordRead: jest.fn() },
    employeeService: {
      getByUid: jest.fn().mockResolvedValue(null),
      findBestForCategories: jest.fn().mockResolvedValue(null),
      dispatchTask: jest.fn().mockResolvedValue(null),
    },
    planner: { plan: jest.fn().mockResolvedValue([]) },
    ltm: { upsertProfile: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

/** 按 Orchestrator 构造顺序装配（构造参数顺序见 orchestrator.service.ts:280-303） */
function makeOrchestrator(overrides: Record<string, unknown> = {}): Harness {
  const deps = makeDeps(overrides);
  const orchestrator = new Orchestrator(
    deps.executor as never,
    deps.registry as never,
    deps.auditLogger as never,
    deps.aiConfigService as never,
    deps.tenantContext as never,
    deps.contextBuilder as never,
    deps.memoryManager as never,
    deps.confirmationService as never,
    deps.graphExecutor as never,
    deps.router as never,
    deps.learning as never,
    deps.extractor as never,
    deps.capture as never,
    deps.metrics as never,
    deps.billing as never,
    deps.configService as never,
    deps.selfCheck as never,
    deps.knowledgeRules as never,
    deps.evidence as never,
    deps.employeeService as never,
    deps.planner as never,
    deps.ltm as never,
  );
  return { orchestrator, deps };
}

const BASE_PARAMS: OrchestratorParams = {
  message: '查一下五粮液库存',
  conversationId: 'sess-1',
  tenantId: 't1',
  userId: 'u1',
};

async function collect(
  orchestrator: Orchestrator,
  params: OrchestratorParams = BASE_PARAMS,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of orchestrator.run(params)) {
    events.push(event);
  }
  return events;
}

describe('Orchestrator（Agent Loop 核心）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('路径 1 主流程：上下文构建 → LLM → 工具调用 → 回填 → 最终文本', async () => {
    const h = makeOrchestrator();
    h.deps.router.chatWithFallback
      // 第 1 轮：返回一个只读工具调用
      .mockImplementationOnce(() =>
        streamOf(['正在查询'], chatResult('', [makeToolCall('searchProduct')])),
      )
      // 第 2 轮：无工具调用 ⇒ 收尾
      .mockImplementationOnce(() =>
        streamOf(['库存 52 箱'], chatResult('库存 52 箱')),
      );

    const events = await collect(h.orchestrator);

    // 上下文构建被调用（含租户与用户消息）
    expect(h.deps.contextBuilder.build).toHaveBeenCalledTimes(1);
    // 工具真实执行了一次，并把结果回填给 LLM
    expect(h.deps.executor.executeToolCall).toHaveBeenCalledTimes(1);
    expect(h.deps.router.chatWithFallback).toHaveBeenCalledTimes(2);
    // 事件序列：tool_start → tool_result（含成功）→ 最终文本 → done
    expect(events.some((e) => e.type === 'tool_start')).toBe(true);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.success).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // 无错误事件
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('路径 2：工具调用失败不中断 Loop（失败结果回填后继续跑完）', async () => {
    const h = makeOrchestrator();
    h.deps.executor.executeToolCall.mockResolvedValue({
      success: false,
      error: '库存服务暂不可用',
    });
    h.deps.router.chatWithFallback
      .mockImplementationOnce(() =>
        streamOf([], chatResult('', [makeToolCall('searchProduct')])),
      )
      .mockImplementationOnce(() =>
        streamOf(['抱歉，查询失败'], chatResult('抱歉，查询失败')),
      );

    const events = await collect(h.orchestrator);

    // 失败也回填（tool_result.success=false），Loop 继续到第 2 轮并正常收尾
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.success).toBe(false);
    expect(h.deps.router.chatWithFallback).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('路径 3：达到最大轮次 ⇒ 退出并下发 AI_009（不无限循环）', async () => {
    const h = makeOrchestrator();
    // 每轮都返回工具调用 ⇒ 只可能靠 MAX_ITERATIONS 退出
    h.deps.router.chatWithFallback.mockImplementation(() =>
      streamOf(['…'], chatResult('', [makeToolCall('searchProduct')])),
    );

    const events = await collect(h.orchestrator);

    expect(h.deps.router.chatWithFallback).toHaveBeenCalledTimes(
      MAX_AGENT_ITERATIONS,
    );
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe('AI_009');
    expect(String(errorEvent?.message)).toContain(`${MAX_AGENT_ITERATIONS}`);
  });

  it('路径 4：写工具 preview ⇒ 挂起确认铸令牌（撤销链路上游，不重复测 revoke 端点）', async () => {
    const h = makeOrchestrator();
    h.deps.executor.executeToolCall.mockResolvedValue({
      success: true,
      preview: {
        operation: '创建销售单',
        summary: '红星商行 20 件五粮液',
        details: { total: 19600 },
      },
    });
    h.deps.router.chatWithFallback
      .mockImplementationOnce(() =>
        streamOf([], chatResult('', [makeToolCall('createSalesOrder')])),
      )
      .mockImplementationOnce(() => streamOf(['请确认'], chatResult('请确认')));

    const events = await collect(h.orchestrator);

    // 写工具预览 ⇒ 经确认服务挂起并下发令牌（后续 confirm → 3 分钟撤销窗口的入口）
    expect(h.deps.confirmationService.create).toHaveBeenCalledTimes(1);
    expect(h.deps.confirmationService.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'createSalesOrder' }),
    );
    const confirmEvent = events.find(
      (e) =>
        e.type === 'tool_result' &&
        (e as { confirmationId?: string }).confirmationId === 'wg_orch_token',
    );
    expect(confirmEvent).toBeDefined();
    // 写工具在预览阶段**不得**真执行（confirm 门未放行）——断言调用的是写工具本身
    const firstCall = h.deps.executor.executeToolCall.mock.calls[0] as [
      { function: { name: string; arguments: string } },
      unknown,
    ];
    expect(firstCall[0].function.name).toBe('createSalesOrder');
  });
});
