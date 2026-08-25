/**
 * SelfHealLoopService 单元测试（批次2，文档 22.5）
 *
 * 覆盖：错误分类、建议生成、重试成功/失败、give_up 直接终止、经验回流
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { SelfHealLoopService } from './self-heal-loop.service';
import type { PlanStep } from './agent.types';

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 's1',
    label: '创建销售单',
    type: 'tool',
    tool: 'createSalesOrder',
    args: { customerId: 1 },
    status: 'pending',
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('SelfHealLoopService', () => {
  const svc = new SelfHealLoopService();

  it('分类：库存不足', () => {
    expect(svc.classify('库存不足，无法创建销售单')).toBe('insufficient_stock');
    expect(svc.classify('库存不够 5 件')).toBe('insufficient_stock');
  });

  it('分类：参数缺失', () => {
    expect(svc.classify('缺少必填参数 customerId')).toBe('missing_args');
  });

  it('分类：超时', () => {
    expect(svc.classify('request timeout after 30000ms')).toBe('timeout');
  });

  it('分类：服务不可用', () => {
    expect(svc.classify('服务暂时不可用，请稍后重试')).toBe(
      'service_unavailable',
    );
    expect(svc.classify('circuit breaker open')).toBe('service_unavailable');
  });

  it('分类：工具未注册', () => {
    expect(svc.classify('工具 "xxx" 未注册')).toBe('tool_unknown');
  });

  it('建议：库存不足 → 澄清（减量/补货）', () => {
    const suggestion = svc.suggest(makeStep(), '库存不足');
    expect(suggestion.action).toBe('clarify');
    expect(suggestion.message).toContain('库存不足');
  });

  it('建议：超时 → 重试', () => {
    const suggestion = svc.suggest(makeStep(), 'timeout');
    expect(suggestion.action).toBe('retry');
  });

  it('建议：工具未注册 → 终止', () => {
    const suggestion = svc.suggest(makeStep(), '工具未注册');
    expect(suggestion.action).toBe('give_up');
    expect(suggestion.giveUp).toBe(true);
  });

  it('heal：重试后成功 → ok=true 且经验回流 success', async () => {
    const step = makeStep();
    const execute = jest
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'timeout' })
      .mockResolvedValueOnce({ success: true, data: { orderId: 100 } });
    const capture = jest.fn().mockResolvedValue(undefined);

    const result = await svc.heal({
      step,
      goal: '创建销售单',
      tenantId: 't1',
      error: 'timeout',
      execute,
      capture,
    });

    expect(result.ok).toBe(true);
    expect(result.result?.data).toEqual({ orderId: 100 });
    expect(result.gaveUp).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('自愈成功'),
    );
    expect(step.healLog).toBeUndefined(); // healLog 由调用方写回，heal 返回内部记录
    expect(result.healLog?.length).toBeGreaterThan(0);
  });

  it('heal：重试耗尽仍失败 → ok=false 且经验回流 failed', async () => {
    const step = makeStep();
    const execute = jest.fn().mockResolvedValue({
      success: false,
      error: '后端 500',
    });
    const capture = jest.fn().mockResolvedValue(undefined);

    const result = await svc.heal({
      step,
      goal: '创建销售单',
      tenantId: 't1',
      error: '后端 500',
      execute,
      capture,
    });

    expect(result.ok).toBe(false);
    expect(result.gaveUp).toBe(false);
    expect(result.suggestion?.action).toBe('clarify');
    expect(execute.mock.calls.length).toBeLessThanOrEqual(3);
    expect(capture).toHaveBeenCalledWith('failed', expect.any(String));
  });

  it('heal：工具未注册 → 不重试直接终止', async () => {
    const step = makeStep();
    const execute = jest.fn();
    const result = await svc.heal({
      step,
      goal: '创建销售单',
      tenantId: 't1',
      error: '工具 "xxx" 未注册',
      execute,
    });

    expect(result.ok).toBe(false);
    expect(result.gaveUp).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});
