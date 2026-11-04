/**
 * ToolExecutor × InvocationGuard 集成测试（AI-P2-4-TOOL-INVOCATION-GUARD-01）
 *
 * 消费者验收口径：超时统一失败语义、读写重试差异、熔断先于副作用、
 * timeout/异常/success=false 均正确记账熔断与指标、审计含通道/类别/尝试数。
 */

import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';
import { InvocationGuardService } from './invocation-guard.service';
import type {
  ToolContext,
  ToolExecutionRecord,
  ToolResult,
} from './tool.interface';
import type { ToolCall } from '../providers/provider.interface';
import type { AuditLogger } from '../bridge/audit-logger';
import { CircuitBreakerService } from './circuit-breaker.service';
import type { IdempotencyGateService } from './idempotency-gate.service';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

function makeToolCall(
  name: string,
  args: unknown = {},
  id = 'call-1',
): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 快速配置 guard（退避 10ms，超时 200ms——测试不等待真实 60s/300ms） */
function makeFastGuard(): InvocationGuardService {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'TOOL_TIMEOUT_MS') return '200';
      if (key === 'TOOL_RETRY_BACKOFF_MS') return '10';
      return fallback;
    }),
  } as unknown as ConfigService;
  return new InvocationGuardService(config);
}

describe('ToolExecutor × InvocationGuard（三通道统一保护）', () => {
  let registry: ToolRegistry;
  let breaker: {
    canProceed: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
  };
  let metrics: Record<string, jest.Mock>;
  let auditRecords: ToolExecutionRecord[];
  let executor: ToolExecutor;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    registry = new ToolRegistry();
    breaker = {
      canProceed: jest.fn(() => ({ ok: true })),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
    };
    metrics = {
      recordToolCall: jest.fn(),
      recordToolDuration: jest.fn(),
      recordToolRetry: jest.fn(),
    };
    auditRecords = [];
    const auditLogger = {
      logToolExecution: jest.fn(
        (r: ToolExecutionRecord) => void auditRecords.push(r),
      ),
      logAiCall: jest.fn(),
    } as unknown as AuditLogger;
    const idemGate = {
      isEnabled: jest.fn(() => true),
      check: jest.fn(() =>
        Promise.resolve({ decision: 'proceed', handle: null }),
      ),
      complete: jest.fn(() => Promise.resolve()),
    } as unknown as IdempotencyGateService;
    executor = new ToolExecutor(
      registry,
      auditLogger,
      breaker as unknown as CircuitBreakerService,
      metrics as never,
      idemGate,
      makeFastGuard(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('工具卡死：预算内返回统一超时失败语义（三通道同一句式），并计熔断失败与指标 fail', async () => {
    registry.register({
      name: 'slowRead',
      description: '挂死读工具',
      category: 'system',
      isWriteOperation: false,
      parameters: { type: 'object', properties: {} },
      execute: () => new Promise<ToolResult>(() => undefined),
    });
    const r = await executor.executeToolCall(makeToolCall('slowRead'), CTX, {
      channel: 'agent',
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain('执行超时');
    expect(breaker.recordFailure).toHaveBeenCalledWith('slowRead');
    expect(metrics.recordToolCall).toHaveBeenCalledWith('slowRead', 'fail');
    // 审计含通道/错误类别/尝试数（可按工具、通道、尝试数、耗时、错误类别追溯）
    expect(auditRecords[0].channel).toBe('agent');
    expect(auditRecords[0].errorClass).toBe('timeout');
    expect(auditRecords[0].attempts).toBe(1);
    expect(auditRecords[0].success).toBe(false);
  });

  it('读工具 transient 抛错：guard 有界重试恢复，最终记熔断成功与重试恢复指标', async () => {
    let calls = 0;
    registry.register({
      name: 'flakyRead',
      description: '第一次抖动',
      category: 'system',
      isWriteOperation: false,
      parameters: { type: 'object', properties: {} },
      execute: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve({ success: true, data: { ok: 1 } });
      },
    });
    const r = await executor.executeToolCall(makeToolCall('flakyRead'), CTX, {
      channel: 'graph',
    });
    expect(r.success).toBe(true);
    expect(calls).toBe(2);
    expect(breaker.recordSuccess).toHaveBeenCalledTimes(1);
    expect(breaker.recordFailure).not.toHaveBeenCalled();
    expect(metrics.recordToolRetry).toHaveBeenCalledWith(true);
    expect(auditRecords[0].attempts).toBe(2);
    expect(auditRecords[0].channel).toBe('graph');
  });

  it('写工具 transient 抛错：默认零自动重试（副作用计数 1）', async () => {
    let calls = 0;
    registry.register({
      name: 'createThing',
      description: '写工具',
      category: 'order',
      isWriteOperation: true,
      parameters: { type: 'object', properties: {} },
      execute: () => {
        calls += 1;
        return Promise.reject(new Error('ECONNRESET'));
      },
    });
    const r = await executor.executeToolCall(
      makeToolCall('createThing', { confirm: true }, 'confirm-call-1'),
      CTX,
      { allowConfirm: true, channel: 'agent' },
    );
    expect(r.success).toBe(false);
    expect(calls).toBe(1);
    expect(metrics.recordToolRetry).not.toHaveBeenCalled();
  });

  it('写工具唯一重试例外：allowConfirm+显式稳定幂等键+transient → 恰好补试 1 次', async () => {
    let calls = 0;
    registry.register({
      name: 'createThing',
      description: '写工具',
      category: 'order',
      isWriteOperation: true,
      idempotencyKeyFields: ['orderNo'],
      parameters: { type: 'object', properties: {} },
      execute: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
        return Promise.resolve({ success: true, data: { orderNo: 'XS1' } });
      },
    });
    const r = await executor.executeToolCall(
      makeToolCall(
        'createThing',
        { orderNo: 'ORD-1', confirm: true },
        'confirm-call-1',
      ),
      CTX,
      {
        allowConfirm: true,
        idempotencyKey: 'ERP-ORDER-2026-0001',
        channel: 'chat',
      },
    );
    expect(r.success).toBe(true);
    expect(calls).toBe(2);
    expect(metrics.recordToolRetry).toHaveBeenCalledWith(true);
  });

  it('熔断打开：副作用之前拦截、不计成功、不产生调用（请求计数=0）', async () => {
    let calls = 0;
    registry.register({
      name: 'guardedTool',
      description: '被熔断工具',
      category: 'system',
      isWriteOperation: false,
      parameters: { type: 'object', properties: {} },
      execute: () => {
        calls += 1;
        return Promise.resolve({ success: true, data: {} });
      },
    });
    breaker.canProceed.mockReturnValue({
      ok: false,
      reason: '服务暂时熔断，请 30 秒后重试',
    });
    const r = await executor.executeToolCall(makeToolCall('guardedTool'), CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('熔断');
    expect(calls).toBe(0);
    expect(breaker.recordSuccess).not.toHaveBeenCalled();
    expect(metrics.recordToolCall).toHaveBeenCalledWith('guardedTool', 'fail');
  });

  it('success=false 业务失败：透传原语义、记熔断失败与指标 fail（不重试不降级改写）', async () => {
    registry.register({
      name: 'bizFail',
      description: '业务失败',
      category: 'order',
      isWriteOperation: false,
      parameters: { type: 'object', properties: {} },
      execute: () => Promise.resolve({ success: false, error: '查无此客户' }),
    });
    const r = await executor.executeToolCall(makeToolCall('bizFail'), CTX);
    expect(r.success).toBe(false);
    expect(r.error).toBe('查无此客户');
    expect(breaker.recordFailure).toHaveBeenCalledWith('bizFail');
    expect(metrics.recordToolCall).toHaveBeenCalledWith('bizFail', 'fail');
    expect(metrics.recordToolRetry).not.toHaveBeenCalled();
    expect(auditRecords[0].errorClass).toBe('transient');
    expect(auditRecords[0].attempts).toBe(1);
  });
});
