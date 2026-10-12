/**
 * ToolExecutor × 幂等闸门 集成测试（R101-AI-21 阶段 3 幂等键）
 *
 * 覆盖交付物 2/5 与反测 ①⑤：
 * - 预览路径（`confirm !== true`）**不消耗幂等键**（反测 ⑤：闸门不得被调用）
 * - LLM 自带 `confirm=true` 无 allowConfirm ⇒ 被写全审核门强制降级 ⇒ 同样不消耗键
 * - 确认通道真实执行 ⇒ 认领（proceed）→ 执行 → 回填
 * - 回放（裁定 A）⇒ **不执行工具**，直接返回既有结果 + `idempotent_replay`
 * - 处理中（in_flight）⇒ 不执行工具，返回 success=false
 * - 工具抛异常 ⇒ 幂等行回填为 failed（允许重试）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { ToolExecutor } from './tool-executor';
import { ToolRegistry } from './tool-registry';
import type { ITool, ToolContext, ToolResult } from './tool.interface';
import type { ToolCall } from '../providers/provider.interface';
import type { AuditLogger } from '../bridge/audit-logger';
import { CircuitBreakerService } from './circuit-breaker.service';
import type {
  IdempotencyGateService,
  IdempotencyHandle,
} from './idempotency-gate.service';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

function makeToolCall(
  name: string,
  args: unknown,
  id = 'confirm-wg_token_1',
): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

/** 测试用写工具（isWriteOperation=true；execute 可断言调用次数） */
class FakeWriteTool implements ITool {
  readonly name = 'createSalesOrder';
  readonly description = '测试写工具（创建销售单）';
  readonly category = 'order' as const;
  readonly isWriteOperation = true;
  readonly parameters = {
    type: 'object' as const,
    properties: {
      items: { type: 'array', description: '明细' },
      confirm: { type: 'boolean', description: '是否确认执行' },
    },
    required: ['items'],
  };

  execute = jest.fn((): Promise<ToolResult> =>
    Promise.resolve({
      success: true,
      data: { orderNo: 'SO2026101200001' },
    }),
  );
}

interface Harness {
  executor: ToolExecutor;
  tool: FakeWriteTool;
  gate: {
    isEnabled: jest.Mock;
    check: jest.Mock;
    complete: jest.Mock;
  };
  metrics: { recordToolCall: jest.Mock; recordToolDuration: jest.Mock };
}

function createHarness(): Harness {
  const registry = new ToolRegistry();
  const tool = new FakeWriteTool();
  registry.register(tool);

  const gate = {
    isEnabled: jest.fn(() => true),
    check: jest.fn(),
    complete: jest.fn(() => Promise.resolve()),
  };
  const metrics = {
    recordToolCall: jest.fn(),
    recordToolDuration: jest.fn(),
  };

  const executor = new ToolExecutor(
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
    metrics as never,
    gate as unknown as IdempotencyGateService,
  );

  return { executor, tool, gate, metrics };
}

const HANDLE: IdempotencyHandle = {
  id: '1',
  tenantId: 't1',
  toolName: 'createSalesOrder',
  idemKey: 'a'.repeat(64),
  keySource: 'confirm_token',
};

describe('ToolExecutor × 幂等闸门（R101-AI-21）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('反测 ⑤：预览路径（confirm !== true）不消耗幂等键', async () => {
    const h = createHarness();
    h.tool.execute.mockResolvedValueOnce({
      success: true,
      preview: {
        operation: '创建销售单',
        summary: '预览',
        details: {},
      },
    });

    const result = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: false,
      }),
      CTX,
    );

    expect(result.success).toBe(true);
    expect(h.gate.check).not.toHaveBeenCalled();
    // 即使被调用也无句柄（handle=null）⇒ 未消耗任何幂等键
    expect(h.gate.complete).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ success: true }),
    );
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
  });

  it('LLM 自带 confirm=true 无 allowConfirm ⇒ 强制降级为预览，同样不消耗幂等键', async () => {
    const h = createHarness();

    await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
    );

    expect(h.gate.check).not.toHaveBeenCalled();
    // 降级后的参数里 confirm=false
    expect(h.tool.execute).toHaveBeenCalledWith(
      expect.objectContaining({ confirm: false }),
      CTX,
    );
  });

  it('反测 ①：确认通道真实执行 ⇒ 认领 → 执行 → 回填；同令牌第二次直接回放且不再执行', async () => {
    const h = createHarness();
    h.gate.check.mockResolvedValueOnce({ decision: 'proceed', handle: HANDLE });

    const first = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
      { allowConfirm: true, idempotencyKey: 'ERP-1' },
    );

    expect(first.success).toBe(true);
    expect(h.gate.check).toHaveBeenCalledTimes(1);
    expect(h.gate.check).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'createSalesOrder',
        toolCallId: 'confirm-wg_token_1',
        explicitKey: 'ERP-1',
      }),
    );
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
    expect(h.gate.complete).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ success: true }),
    );

    // 第二次：闸门判回放（裁定 A）
    h.gate.check.mockResolvedValueOnce({
      decision: 'replay',
      handle: null,
      result: {
        success: true,
        data: { orderNo: 'SO2026101200001' },
        idempotent_replay: true,
      },
    });
    const second = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
      { allowConfirm: true },
    );

    expect(second.success).toBe(true);
    expect(second.idempotent_replay).toBe(true);
    expect(second.data).toEqual({ orderNo: 'SO2026101200001' });
    // 回放不得产生第二次副作用
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
    expect(h.gate.complete).toHaveBeenCalledTimes(1);
  });

  it('in_flight ⇒ 不执行工具，返回 success=false + 处理中提示', async () => {
    const h = createHarness();
    h.gate.check.mockResolvedValueOnce({
      decision: 'in_flight',
      handle: null,
      result: {
        success: false,
        error: '该写操作正在处理中（工具 createSalesOrder）',
      },
    });

    const result = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
      { allowConfirm: true },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('处理中');
    expect(h.tool.execute).not.toHaveBeenCalled();
    expect(h.gate.complete).not.toHaveBeenCalled();
    // 指标口径：拦截计为 fail
    expect(h.metrics.recordToolCall).toHaveBeenCalledWith(
      'createSalesOrder',
      'fail',
    );
  });

  it('工具抛异常 ⇒ 幂等行回填 failed（允许同键重试）', async () => {
    const h = createHarness();
    h.gate.check.mockResolvedValueOnce({ decision: 'proceed', handle: HANDLE });
    h.tool.execute.mockRejectedValueOnce(new Error('后端 500'));

    const result = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
      { allowConfirm: true },
    );

    expect(result.success).toBe(false);
    expect(h.gate.complete).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ success: false }),
    );
  });

  it('闸门放行但未认领（降级/开关关闭）⇒ handle 为空，工具照常执行', async () => {
    const h = createHarness();
    h.gate.check.mockResolvedValueOnce({ decision: 'proceed', handle: null });

    const result = await h.executor.executeToolCall(
      makeToolCall('createSalesOrder', {
        items: [{ skuId: 'S1' }],
        confirm: true,
      }),
      CTX,
      { allowConfirm: true },
    );

    expect(result.success).toBe(true);
    expect(h.tool.execute).toHaveBeenCalledTimes(1);
    expect(h.gate.complete).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ success: true }),
    );
  });
});
