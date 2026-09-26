/**
 * S3 WeeklyPlanService 单元测试
 *
 * 覆盖：有信号 → LLM 规划 + 推送留痕；LLM 失败 → 降级信号清单；空信号 → 通用清单。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试断言直接引用 jest mock 方法及其调用参数；mock 无需真实异步 */
import { DataSource } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { ProactivePushService } from './proactive-push.service';
import { WeeklyPlanService } from './weekly-plan.service';

function createService(opts: {
  rows?: Array<{ title: string; content: string; created_at: string }>;
  llmText?: string;
  llmError?: boolean;
  cronEnabled?: boolean;
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
  const config = {
    get: jest.fn((key: string) =>
      key === 'WEEKLY_PLAN_CRON_ENABLED'
        ? opts.cronEnabled
          ? 'true'
          : 'false'
        : undefined,
    ),
  } as never as ConfigService;

  const service = new WeeklyPlanService(
    dataSource,
    aiConfigService,
    router,
    push,
    config,
  );
  return { service, dataSource, chatSync, push, config };
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

  it('同标题信号去重：同一预警每天推送，计划只留一条', async () => {
    const { service, dataSource } = createService({
      rows: [
        {
          title: '库存预警：五粮液低于安全线',
          content: 'x',
          created_at: '2026-09-05 08:00:00',
        },
        {
          title: '库存预警：五粮液低于安全线', // 同标题去重
          content: 'x',
          created_at: '2026-09-04 08:00:00',
        },
        {
          title: '应收提醒',
          content: 'x',
          created_at: '2026-09-03 09:00:00',
        },
      ],
    });
    const result = await service.buildWeeklyPlan('t_001');
    expect(result.signals).toBe(2);
    expect(dataSource.query).toHaveBeenCalled();
  });

  it('cron 开关关闭 → handleWeeklyCron 空转（不查信号不推送）', async () => {
    const { service, dataSource, push } = createService({
      rows: [],
      cronEnabled: false,
    });
    await service.handleWeeklyCron();
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(push.push).not.toHaveBeenCalled();
  });

  it('cron 开关开启 → 自动生成 default 租户周计划', async () => {
    const { service, push } = createService({
      rows: [],
      cronEnabled: true,
    });
    await service.handleWeeklyCron();
    expect(push.push).toHaveBeenCalledWith(
      'default',
      'weekly-plan',
      expect.objectContaining({ title: '本周经营计划（AI 规划）' }),
    );
  });

  it('空信号 + LLM 失败 → 通用周初检查清单', async () => {
    const { service } = createService({ rows: [], llmError: true });
    const result = await service.buildWeeklyPlan('t_001');
    expect(result.signals).toBe(0);
    expect(result.plan).toContain('周初建议检查');
  });
});
