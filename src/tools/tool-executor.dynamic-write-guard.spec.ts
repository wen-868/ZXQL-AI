/**
 * 动态写条目三通道零写守卫（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01）
 *
 * 消费者验收口径：注入含写条目的目录后——
 * - 生成/注册层拒绝写条目，registry 不增长；
 * - chat/agent/graph 三通道在工具清单中均看不到写工具，强行调用也零后端写请求；
 * - 既有读工具（GET）与纯计算 POST 保持可见可用。
 */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- 集成测试批量断言 mock 依赖 */
import { Logger } from '@nestjs/common';
import { ServiceClient } from '../bridge/service-client';
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';
import type { AuditLogger } from '../bridge/audit-logger';
import { CircuitBreakerService } from './circuit-breaker.service';
import type { IdempotencyGateService } from './idempotency-gate.service';
import { API_CATALOG } from './catalog/api-catalog';
import { ToolGeneratorService } from './catalog/tool-generator.service';

function makeToolCall(name: string, args: unknown = {}, id = 'call-1'): any {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 三通道调用方上下文（chat/agent/graph 同一 registry，仅来源不同） */
const CHANNEL_CTXS = [
  { label: 'chat', ctx: { tenantId: 't1', userId: 'u-chat' } },
  { label: 'agent', ctx: { tenantId: 't1', userId: 'u-agent' } },
  { label: 'graph', ctx: { tenantId: 't1', userId: 'u-graph' } },
] as const;

describe('动态写条目三通道零写守卫', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let http: {
    get: jest.Mock;
    post: jest.Mock;
    put: jest.Mock;
    delete: jest.Mock;
  };
  let registry: ToolRegistry;
  let executor: ToolExecutor;
  /** 未获准写条目（模拟 evolution newtool 提案 / 目录混入） */
  const writeDef = {
    name: 'api_create_hold_order',
    description: '创建挂单（未获准写条目）',
    category: 'order' as const,
    method: 'POST' as const,
    path: '/api/store/hold-orders',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: true,
    risk: 'medium' as const,
  };

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    http = {
      get: jest.fn().mockResolvedValue({ list: [] }),
      post: jest.fn().mockResolvedValue({ ok: 1 }),
      put: jest.fn(),
      delete: jest.fn(),
    };
    registry = new ToolRegistry();
    const generator = new ToolGeneratorService(
      http as unknown as ServiceClient,
      {
        get: jest.fn(() => 'true'),
      } as never,
    );
    // 注入含写条目的目录（真实生成/注册链路，非 mock 生成器）
    const result = generator.generateAndRegister(registry, [
      ...API_CATALOG,
      writeDef,
    ]);
    // 生成/注册层 fail-closed：写条目被拒、registry 不增长
    expect(result.registered).toBe(API_CATALOG.length);
    expect(result.rejected.map((r) => r.name)).toContain(writeDef.name);
    expect(registry.has(writeDef.name)).toBe(false);

    executor = new ToolExecutor(
      registry,
      {
        logToolExecution: jest.fn(),
        logAiCall: jest.fn(),
      } as unknown as AuditLogger,
      {
        canProceed: jest.fn(() => ({ ok: true })),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      } as unknown as CircuitBreakerService,
      {
        recordToolCall: jest.fn(),
        recordToolDuration: jest.fn(),
      } as never,
      {
        check: jest.fn(),
        complete: jest.fn(),
      } as unknown as IdempotencyGateService,
    );
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('三通道均看不到写工具，强行调用零后端请求（请求计数=0）', async () => {
    for (const { label, ctx } of CHANNEL_CTXS) {
      const r = await executor.executeToolCall(
        makeToolCall(writeDef.name, { items: [{ skuId: 1 }] }, `call-${label}`),
        ctx,
      );
      expect(r.success).toBe(false);
      expect(JSON.stringify(r)).toContain(writeDef.name);
      // registry 中根本没有该工具（通道工具清单不含未获准写工具）
      expect(registry.has(writeDef.name)).toBe(false);
    }
    // 后端写请求计数 = 0（三通道合计）
    expect(http.post).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
    expect(http.get).not.toHaveBeenCalled();
  });

  it('读工具（GET 查询）三通道可见可执行（既有能力零回归）', async () => {
    for (const { label, ctx } of CHANNEL_CTXS) {
      const r = await executor.executeToolCall(
        makeToolCall(
          'api_query_sale_bills',
          { status: 'PENDING' },
          `call-${label}`,
        ),
        ctx,
      );
      expect(r.success).toBe(true);
    }
    expect(http.get).toHaveBeenCalledTimes(CHANNEL_CTXS.length);
    // 写方法零调用
    expect(http.post).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
    expect(http.delete).not.toHaveBeenCalled();
  });

  it('纯计算 POST（api_calculate_promotion）可见可执行（既有能力零回归）', async () => {
    const r = await executor.executeToolCall(
      makeToolCall('api_calculate_promotion', {
        items: [{ skuId: 1, qty: 2 }],
        activityType: 'full_reduction',
      }),
      CHANNEL_CTXS[0].ctx,
    );
    expect(r.success).toBe(true);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(registry.has('api_calculate_promotion')).toBe(true);
  });
});
