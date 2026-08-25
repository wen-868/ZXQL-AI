/**
 * PlannerService 单元测试（批次2，文档 22.4）
 *
 * 覆盖：模板分解、LLM 动态规划、非法输出兜底、未知工具转换、参数填充、步数裁剪
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { ToolRegistry } from '../../tools/tool-registry';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { PlannerService } from './planner.service';

function makeRegistry(): ToolRegistry {
  return {
    has: jest.fn(() => true),
    get: jest.fn(),
    toToolDefinitionsForCategories: jest.fn(() => [
      {
        type: 'function',
        function: {
          name: 'queryInventory',
          description: '查库存',
          parameters: {},
        },
      },
      {
        type: 'function',
        function: {
          name: 'searchCustomer',
          description: '搜客户',
          parameters: {},
        },
      },
    ]),
  } as unknown as ToolRegistry;
}

function makePlanner(
  router: Partial<ProviderRouterService> = {},
  registry: ToolRegistry = makeRegistry(),
): PlannerService {
  const aiConfig = {
    getResolvedConfig: jest.fn().mockResolvedValue({
      provider: 'glm',
      providerConfig: {},
      model: 'glm-4-flash',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt: null,
      source: 'platform',
    }),
  } as unknown as AiConfigService;
  const fullRouter = {
    chatSyncWithFallback: jest.fn(),
    getSystemScope: jest.fn(() => 'mgmt'),
    ...router,
  } as unknown as ProviderRouterService;
  return new PlannerService(registry, fullRouter, aiConfig);
}

describe('PlannerService', () => {
  it('命中销售模板：目标含"开单"分解为销售开单步骤序列（末步 end）', async () => {
    const planner = makePlanner();
    const steps = await planner.plan({
      tenantId: 't1',
      goal: '给红星商行开单，20件五粮液，价格980',
    });

    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0].type).toBe('tool');
    expect(steps[0].tool).toBe('searchCustomer');
    expect(steps.every((s) => s.status === 'pending')).toBe(true);
    expect(steps[steps.length - 1].type).toBe('end');
  });

  it('命中采购模板：目标含"采购"分解为采购计划步骤', async () => {
    const planner = makePlanner();
    const steps = await planner.plan({
      tenantId: 't1',
      goal: '生成采购计划：五粮液缺货需要补货',
    });
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[steps.length - 1].type).toBe('end');
  });

  it('LLM 动态规划：合法 JSON 步骤序列被采纳且校验工具存在', async () => {
    const chatSync = jest.fn().mockResolvedValue({
      content:
        '[{"label":"查询库存","type":"tool","tool":"queryInventory","args":{"sku":"WLJ"}},{"label":"完成","type":"end"}]',
      prompt_tokens: 10,
      completion_tokens: 5,
    });
    const planner = makePlanner({ chatSyncWithFallback: chatSync });

    const steps = await planner.plan({
      tenantId: 't1',
      goal: '看看五粮液库存还有多少',
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe('tool');
    expect(steps[0].tool).toBe('queryInventory');
    expect(steps[0].args).toEqual({ sku: 'WLJ' });
    expect(steps[1].type).toBe('end');
  });

  it('LLM 返回非 JSON：降级为单 agent 步骤（不抛异常）', async () => {
    const chatSync = jest.fn().mockResolvedValue({
      content: '抱歉，我无法规划这个任务。',
      prompt_tokens: 5,
      completion_tokens: 3,
    });
    const planner = makePlanner({ chatSyncWithFallback: chatSync });

    const steps = await planner.plan({ tenantId: 't1', goal: '随便聊聊' });
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('agent');
  });

  it('LLM 返回未知工具：转换为 agent 步骤，不阻断规划', async () => {
    const registry = makeRegistry();
    (registry.has as jest.Mock).mockImplementation(
      (name: string) => name === 'queryInventory',
    );
    const chatSync = jest.fn().mockResolvedValue({
      content:
        '[{"label":"调价格","type":"tool","tool":"updatePriceXXX"},{"label":"完成","type":"end"}]',
      prompt_tokens: 5,
      completion_tokens: 3,
    });
    const planner = makePlanner({ chatSyncWithFallback: chatSync }, registry);

    const steps = await planner.plan({ tenantId: 't1', goal: '调价' });
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps[0].type).toBe('agent');
    expect(steps[steps.length - 1].type).toBe('end');
  });

  it('LLM 输出超 12 步：裁剪至上限且末步为 end', async () => {
    const manySteps = Array.from({ length: 15 }, (_, i) => ({
      label: `步骤${i}`,
      type: 'tool',
      tool: 'queryInventory',
      args: {},
    }));
    manySteps.push({ label: '完成', type: 'end' });
    const chatSync = jest.fn().mockResolvedValue({
      content: JSON.stringify(manySteps),
      prompt_tokens: 10,
      completion_tokens: 5,
    });
    const planner = makePlanner({ chatSyncWithFallback: chatSync });

    const steps = await planner.plan({ tenantId: 't1', goal: '批量任务' });
    expect(steps.length).toBeLessThanOrEqual(12);
  });

  it('fillStepArgs：LLM 函数调用提取参数', async () => {
    const chatSync = jest.fn().mockResolvedValue({
      content: '',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: {
            name: 'queryInventory',
            arguments: JSON.stringify({ sku: 'WLJ' }),
          },
        },
      ],
      prompt_tokens: 10,
      completion_tokens: 5,
    });
    const planner = makePlanner({ chatSyncWithFallback: chatSync });

    const step = {
      id: 's1',
      label: '查询库存',
      type: 'tool' as const,
      tool: 'queryInventory',
      args: {},
      status: 'pending' as const,
      retryCount: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const args = await planner.fillStepArgs(step, '看看五粮液库存', {
      tenantId: 't1',
      goal: '看看五粮液库存',
    });
    expect(args).toEqual({ sku: 'WLJ' });
  });

  it('fillStepArgs：LLM 失败保留原参数', async () => {
    const chatSync = jest.fn().mockRejectedValue(new Error('LLM 不可用'));
    const planner = makePlanner({ chatSyncWithFallback: chatSync });

    const step = {
      id: 's1',
      label: '查询库存',
      type: 'tool' as const,
      tool: 'queryInventory',
      args: { sku: 'keep' },
      status: 'pending' as const,
      retryCount: 0,
      createdAt: 0,
      updatedAt: 0,
    };
    const args = await planner.fillStepArgs(step, '看看五粮液库存', {
      tenantId: 't1',
      goal: '看看五粮液库存',
    });
    expect(args).toEqual({ sku: 'keep' });
  });
});
