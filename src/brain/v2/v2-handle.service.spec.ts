/**
 * V2HandleService 单元测试（批次3，文档 11.3 /ai/v2/handle）
 *
 * 覆盖：分析自动返回、写意图挂起令牌、LLM 未选工具降级、缺参澄清、
 * 写工具未返回预览拒绝放行
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { V2HandleService } from './v2-handle.service';

function makeService(overrides: Record<string, unknown> = {}) {
  const orchestrator = {
    run: jest.fn().mockImplementation(function* () {
      yield { type: 'text', content: '五粮液库存：52 箱 2 支' };
      yield {
        type: 'done',
        conversationId: 's1',
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          latencyMs: 10,
          iterations: 1,
        },
      };
    }),
    ...(overrides.orchestrator ?? {}),
  };
  const extractor = {
    tryEnhance: jest.fn().mockResolvedValue({
      used: true,
      needsClarification: false,
      args: { customerId: 1, items: [{ sku: 'WLJ', qty: 20, price: 980 }] },
    }),
    ...(overrides.extractor ?? {}),
  };
  const confirmationService = {
    create: jest.fn().mockResolvedValue({
      confirmationId: 'wg_v2_token',
      docType: 'createSalesOrder',
      risk: 'medium',
      operationLabel: '创建销售单',
    }),
    ...(overrides.confirmationService ?? {}),
  };
  const registry = {
    toToolDefinitionsForCategories: jest.fn().mockReturnValue([
      {
        type: 'function',
        function: {
          name: 'createSalesOrder',
          description: '创建销售单',
          parameters: {},
        },
      },
    ]),
    get: jest.fn().mockReturnValue({
      isWriteOperation: true,
      risk: 'medium',
      needsReview: false,
    }),
    ...(overrides.registry ?? {}),
  };
  const executor = {
    executeToolCall: jest.fn().mockResolvedValue({
      success: true,
      preview: {
        operation: '创建销售单',
        summary: '拟创建销售单：客户红星商行，五粮液×20@980',
      },
    }),
    ...(overrides.executor ?? {}),
  };
  const router = {
    chatSyncWithFallback: jest.fn().mockResolvedValue({
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'createSalesOrder',
            arguments: JSON.stringify({ customerId: 1 }),
          },
        },
      ],
      prompt_tokens: 1,
      completion_tokens: 1,
    }),
    getSystemScope: jest.fn(() => 'mgmt'),
    ...(overrides.router ?? {}),
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
    ...(overrides.aiConfigService ?? {}),
  };
  const service = new V2HandleService(
    orchestrator as never,
    extractor as never,
    confirmationService as never,
    registry as never,
    executor as never,
    router as never,
    aiConfigService as never,
  );
  return {
    service,
    orchestrator,
    extractor,
    confirmationService,
    registry,
    executor,
    router,
  };
}

const CTX = { tenantId: 't1', sessionId: 's1' };

describe('V2HandleService', () => {
  it('分析意图：无写关键词 → Orchestrator 执行并返回结论', async () => {
    const { service, orchestrator } = makeService();
    const result = await service.handle('查询五粮液库存', CTX);
    expect(result.intent).toBe('analysis');
    expect(result.message).toContain('五粮液库存');
    expect(orchestrator.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: '查询五粮液库存', tenantId: 't1' }),
    );
  });

  it('写意图：LLM 选工具 → 预览 → WriteGuard 挂起令牌', async () => {
    const { service, confirmationService, executor, registry } = makeService();
    const result = await service.handle('给红星商行开单20件五粮液980', CTX);
    expect(result.intent).toBe('write');
    if (result.intent !== 'write') return;
    expect(result.pendingWrite.token).toBe('wg_v2_token');
    expect(result.pendingWrite.docType).toBe('createSalesOrder');
    expect(result.pendingWrite.risk).toBe('medium');
    expect(result.message).toContain('待你确认');
    expect(executor.executeToolCall).toHaveBeenCalledTimes(1);
    expect(confirmationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        toolName: 'createSalesOrder',
        needsReview: false,
      }),
    );
    expect(registry.get).toHaveBeenCalledWith('createSalesOrder');
  });

  it('写关键词但 LLM 未选工具 → 降级分析', async () => {
    const { service, orchestrator } = makeService({
      router: {
        chatSyncWithFallback: jest.fn().mockResolvedValue({
          content: '这是咨询问题',
          tool_calls: undefined,
          prompt_tokens: 1,
          completion_tokens: 1,
        }),
        getSystemScope: jest.fn(() => 'mgmt'),
      },
    });
    const result = await service.handle('想了解创建销售单的流程', CTX);
    expect(result.intent).toBe('analysis');
    expect(orchestrator.run).toHaveBeenCalled();
  });

  it('参数缺失：StructuredExtractor 判定需澄清 → 返回 clarify（不挂残缺草稿）', async () => {
    const { service, executor, confirmationService } = makeService({
      extractor: {
        tryEnhance: jest.fn().mockResolvedValue({
          used: true,
          needsClarification: true,
          questions: ['请提供客户名称'],
          issues: [
            {
              field: 'customerId',
              reason: 'required',
              message: '缺少客户',
              question: '请提供客户名称',
            },
          ],
        }),
      },
    });
    const result = await service.handle('开单', CTX);
    expect(result.intent).toBe('clarify');
    if (result.intent !== 'clarify') return;
    expect(result.message).toContain('请提供客户名称');
    expect(executor.executeToolCall).not.toHaveBeenCalled();
    expect(confirmationService.create).not.toHaveBeenCalled();
  });

  it('写工具未返回预览 → 拒绝自动执行（clarify）', async () => {
    const { service, confirmationService } = makeService({
      executor: {
        executeToolCall: jest.fn().mockResolvedValue({
          success: true,
          preview: undefined,
        }),
      },
    });
    const result = await service.handle('开单20件五粮液', CTX);
    expect(result.intent).toBe('clarify');
    expect(confirmationService.create).not.toHaveBeenCalled();
  });

  it('写分支异常 → 降级分析（不抛错）', async () => {
    const { service, orchestrator } = makeService({
      router: {
        chatSyncWithFallback: jest
          .fn()
          .mockRejectedValue(new Error('LLM 不可用')),
        getSystemScope: jest.fn(() => 'mgmt'),
      },
    });
    const result = await service.handle('给红星商行开单20件五粮液', CTX);
    expect(result.intent).toBe('analysis');
    expect(orchestrator.run).toHaveBeenCalled();
  });
});
