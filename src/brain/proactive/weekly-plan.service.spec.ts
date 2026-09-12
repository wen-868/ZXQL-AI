/**
 * S3 WeeklyPlanService 单元测试
 *
 * 覆盖：有信号 → LLM 规划 + 推送留痕；LLM 失败 → 降级信号清单；空信号 → 通用清单。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试断言直接引用 jest mock 方法及其调用参数；mock 无需真实异步 */
import { DataSource } from 'typeorm';
import { AiConfigService } from '../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { ProactivePushService } from './proactive-push.service';
import { WeeklyPlanService } from './weekly-plan.service';

function createService(opts: {
  rows?: Array<{ title: string; content: string; created_at: string }>;
  llmText?: string;
  llmError?: boolean;
}) {
  const dataSource = {
    query: jest.fn().mockResolvedValue(opts.rows ?? []),
  } as unknown as DataSource;
  const chatSync = jest.fn(
    opts.llmError
      ? () => {
          throw new Error('llm down');
        }
      : () =>
          Promise.resolve({
            content: opts.llmText ?? '1. 补货 —— 库存预警3条 → 立即盘点下单',
            prompt_tokens: 10,
            completion_tokens: 20,
          }),
  );
  const router = {
    route: jest.fn().mockReturnValue({
      providerName: 'glm',
      provider: { chatSync },
      reason: 'mock',
    }),
  } as never as ProviderRouterService;
  const aiConfigService = {
    getResolvedConfig: jest.fn().mockResolvedValue({ provider: 'glm' }),
  } as never as AiConfigService;
  const push = {
    push: jest.fn().mockResolvedValue(true),
  } as never as ProactivePushService;

  const service = new WeeklyPlanService(
    dataSource,
    aiConfigService,
    router,
    push,
  );
  return { service, dataSource, chatSync, push };
}

describe('S3 WeeklyPlanService', () => {
  it('有信号 → LLM 规划 + 推送留痕', async () => {
    const { service, push, chatSync } = createService({
      rows: [
        {
          title: '库存预警：五粮液低于安全线',
          content: 'x',
          created_at: '2026-09-04 10:00:00',
        },
      ],
      llmText: '1. 五粮液补货 —— 库存预警 → 立即盘点下单',
    });

    const result = await service.buildWeeklyPlan('t_001');

    expect(result.signals).toBe(1);
    expect(result.plan).toContain('五粮液补货');
    // LLM 收到的提示词包含信号标题
    const prompt = (chatSync.mock.calls[0][0] as Array<{ content: string }>)[0]
      .content;
    expect(prompt).toContain('库存预警：五粮液低于安全线');
    expect(push.push).toHaveBeenCalledWith(
      't_001',
      'weekly-plan',
      expect.objectContaining({
        type: 'system',
        priority: 'important',
        title: '本周经营计划（AI 规划）',
      }),
    );
  });

  it('LLM 失败 → 降级为信号清单（不阻塞）', async () => {
    const { service } = createService({
      rows: [
        { title: '应收提醒', content: 'x', created_at: '2026-09-03 09:00:00' },
      ],
      llmError: true,
    });
    const result = await service.buildWeeklyPlan('t_001');
    expect(result.signals).toBe(1);
    expect(result.plan).toContain('1 条主动提醒');
  });

  it('空信号 + LLM 失败 → 通用周初检查清单', async () => {
    const { service } = createService({ rows: [], llmError: true });
    const result = await service.buildWeeklyPlan('t_001');
    expect(result.signals).toBe(0);
    expect(result.plan).toContain('周初建议检查');
  });
});
