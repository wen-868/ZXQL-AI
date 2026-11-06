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
import { readFileSync } from 'fs';
import { join } from 'path';
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
  deps: ReturnType<typeof makeDeps> & {
    /** AI-P2-4-TELEMETRY-PIPELINE：遥测桩（makeOrchestrator 装配时挂入） */
    telemetry: ReturnType<typeof makeTelemetryStub>;
  };
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
    writeConfirmPipeline: {
      suspend: jest.fn().mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({
          token: 'wg_orch_token',
          expireAt: Date.now() + 24 * 60 * 60 * 1000,
          confirmation: {
            confirmationId: 'wg_orch_token',
            toolName: input.toolName,
            docType: input.docType,
            risk: 'medium',
            operationLabel: input.operationLabel,
          },
        }),
      ),
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
      captureTask: jest.fn((_input?: Record<string, unknown>) =>
        Promise.resolve(undefined),
      ),
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
  const deps = makeDeps(overrides) as ReturnType<typeof makeDeps> & {
    telemetry: ReturnType<typeof makeTelemetryStub>;
  };
  const orchestrator = new Orchestrator(
    deps.executor as never,
    deps.registry as never,
    deps.aiConfigService as never,
    deps.tenantContext as never,
    deps.contextBuilder as never,
    deps.memoryManager as never,
    deps.writeConfirmPipeline as never,
    deps.graphExecutor as never,
    deps.router as never,
    deps.learning as never,
    deps.extractor as never,
    deps.capture as never,
    deps.metrics as never,
    deps.configService as never,
    deps.selfCheck as never,
    deps.knowledgeRules as never,
    deps.evidence as never,
    deps.employeeService as never,
    deps.planner as never,
    deps.ltm as never,
    // AI-P2-4-TELEMETRY-PIPELINE：遥测桩（断言经管线收口；overrides.telemetry 可替换）
    (deps.telemetry = ((overrides as { telemetry?: unknown }).telemetry ??
      makeTelemetryStub()) as never),
  );
  return { orchestrator, deps };
}

/** AI-P2-4-TELEMETRY-PIPELINE：遥测桩（记录 begin/end 调用） */
function makeTelemetryStub() {
  return {
    channelBegin: jest.fn(
      (input: { lane: string; sessionId?: string; tenantId: string }) => ({
        ...input,
        startTime: Date.now(),
      }),
    ),
    channelEnd: jest.fn((_input?: Record<string, unknown>) =>
      Promise.resolve(),
    ),
    resolveSessionId: jest.fn(
      (_lane: string, _t: string, preferred?: string, fallback?: string) =>
        preferred ?? fallback ?? 'chat-session-t1',
    ),
  };
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
    // AI-P2-4-CAPTURE-INTENT-NORMALIZE：chat 采集经统一归一口径——
    // searchProduct 未映射保持原值（不得折叠成 chat）
    expect(h.deps.capture.captureTask).toHaveBeenCalledTimes(1);
    const capArg = h.deps.capture.captureTask.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(capArg.intent).toBe('searchProduct');
    expect(capArg.outcome).toBe('success');
    expect(capArg.tenantId).toBe('t1');
  });

  // ════ Phase 0 哨兵（AI-P2-4-ORCHESTRATION-CONVERGENCE-IMPLEMENTATION-01）════
  it('Phase 0 哨兵：LLM 异常 → error 事件 + 失败遥测收口（billable:false / unknown）', async () => {
    const h = makeOrchestrator();
    h.deps.router.chatWithFallback = jest.fn(() => {
      throw new Error('provider down');
    }) as never;
    const events = await collect(h.orchestrator);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    // 失败路径遥测收口（1391-1406 区）：仅一次、billable:false、来源 unknown
    expect(h.deps.telemetry.channelEnd).toHaveBeenCalledTimes(1);
    const arg = h.deps.telemetry.channelEnd.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(arg.success).toBe(false);
    expect(arg.billable).toBe(false);
    expect(arg.error).toContain('provider down');
    const usage = arg.usage as Record<string, unknown>;
    expect(usage.usageSource).toBe('unknown');
    const session = arg.session as Record<string, unknown>;
    expect(session.lane).toBe('chat');
    expect(session.sessionId).toBe('sess-1');
    expect(session.tenantId).toBe('t1');
    // 失败路径不采集（capture 仅成功/纠正路径）
    expect(h.deps.capture.captureTask).not.toHaveBeenCalled();
  });

  it('Phase 0 哨兵：LLM 无文本仅工具结果 → 兜底摘要与工具分类（1461-1500 区）', async () => {
    const h = makeOrchestrator();
    h.deps.router.chatWithFallback
      .mockImplementationOnce(() =>
        streamOf([], chatResult('', [makeToolCall('searchProduct')])),
      )
      .mockImplementationOnce(() => streamOf([], chatResult('')));
    const events = await collect(h.orchestrator);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
    // 兜底摘要：无模型总结时由工具结果生成可读文本（不为空）
    const texts = events.filter((e) => e.type === 'text').map((e) => e.content);
    expect(texts.join('').length).toBeGreaterThan(0);
    // 成功采集：capture 带 toolCalls（原始工具名保留）
    expect(h.deps.capture.captureTask).toHaveBeenCalledTimes(1);
    const capArg2 = h.deps.capture.captureTask.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(capArg2.toolCalls)).toContain('searchProduct');
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

    // 写工具预览 ⇒ 经写确认管线挂起并下发令牌（后续 confirm → 3 分钟撤销窗口的入口）
    expect(h.deps.writeConfirmPipeline.suspend).toHaveBeenCalledTimes(1);
    expect(h.deps.writeConfirmPipeline.suspend).toHaveBeenCalledWith(
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

// AI-P2-4-TOOL-INVOCATION-GUARD：chat 通道超时闸与自动重试已收敛进 executor 的
// InvocationGuard（唯一 guard）。本哨兵防回归：orchestrator 不得再自带 timeout/重试。
describe('三通道唯一 guard 哨兵（chat 侧）', () => {
  it('orchestrator 源码不再自带超时闸/重试逻辑（防回归锚）', () => {
    const src = readFileSync(
      join(__dirname, 'orchestrator.service.ts'),
      'utf8',
    );
    expect(src).not.toContain('executeToolWithTimeout');
    expect(src).not.toContain('setTimeout');
    expect(src).not.toContain('ENABLE_TOOL_AUTO_RETRY');
    expect(src).toContain("channel: 'chat'");
  });
});
