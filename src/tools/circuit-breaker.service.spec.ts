/**
 * P1-3 CircuitBreakerService 单元测试
 *
 * 覆盖：失败阈值触发熔断、冷却期拒绝、半开测试成功恢复、半开测试失败重新熔断、重置。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from './circuit-breaker.service';

function createBreaker(): CircuitBreakerService {
  return new CircuitBreakerService({
    get: jest.fn((key: string) =>
      key === 'CIRCUIT_FAILURE_THRESHOLD'
        ? '3'
        : key === 'CIRCUIT_WINDOW_MS'
          ? '60000'
          : key === 'CIRCUIT_COOLDOWN_MS'
            ? '10000'
            : undefined,
    ),
  } as unknown as ConfigService);
}

describe('P1-3 CircuitBreakerService', () => {
  it('正常执行：失败未达阈值时放行', () => {
    const breaker = createBreaker();
    expect(breaker.canProceed('queryInventory').ok).toBe(true);
    breaker.recordFailure('queryInventory');
    breaker.recordFailure('queryInventory');
    expect(breaker.canProceed('queryInventory').ok).toBe(true);
  });

  it('失败达阈值：熔断打开并拒绝执行', () => {
    const breaker = createBreaker();
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('createSalesOrder');
    }
    const gate = breaker.canProceed('createSalesOrder');
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('熔断');
  });

  it('冷却期后：半开放行单个测试请求，成功则恢复', () => {
    const breaker = createBreaker();
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('queryInventory');
    }
    expect(breaker.canProceed('queryInventory').ok).toBe(false);

    // 推进时间越过冷却期
    jest.useFakeTimers();
    jest.advanceTimersByTime(11000);
    // 半开放行
    expect(breaker.canProceed('queryInventory').ok).toBe(true);
    breaker.recordSuccess('queryInventory');
    // 恢复 closed
    const status = breaker
      .status()
      .find((s) => s.toolName === 'queryInventory');
    expect(status?.state).toBe('closed');
    jest.useRealTimers();
  });

  it('半开测试失败：重新熔断', () => {
    const breaker = createBreaker();
    for (let i = 0; i < 3; i++) {
      breaker.recordFailure('stockCheck');
    }
    // 触发 open
    expect(breaker.canProceed('stockCheck').ok).toBe(false);
    jest.useFakeTimers();
    jest.advanceTimersByTime(11000);
    // 半开放行
    expect(breaker.canProceed('stockCheck').ok).toBe(true);
    breaker.recordFailure('stockCheck');
    // 重新熔断（冷却期内拒绝）
    expect(breaker.canProceed('stockCheck').ok).toBe(false);
    jest.useRealTimers();
  });

  it('熔断状态列表与重置', () => {
    const breaker = createBreaker();
    breaker.recordFailure('a');
    breaker.recordFailure('b');
    expect(breaker.status()).toHaveLength(2);
    expect(breaker.reset('a')).toBe(1);
    expect(breaker.status()).toHaveLength(1);
    expect(breaker.reset()).toBe(1);
    expect(breaker.status()).toHaveLength(0);
  });
});
