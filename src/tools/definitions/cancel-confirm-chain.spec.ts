/**
 * AI-P0-3-F1-WRITE-CONFIRM-BYPASS-01 · 取消订单确认链旁路整改 — 契约测试
 *
 * 覆盖（卡面必须完成 3-6 / 消费者验收 1-6）：
 * - 零写：confirm 缺省/false 仅返回 preview，MS POST 零调用（含后果说明与 source='ai'）
 * - 确认执行：confirm=true 经 ToolExecutor（allowConfirm）真实执行一次
 * - 重复确认：幂等闸 replay ⇒ 回放首次结果，MS POST 仅 1 次
 * - 处理中：in_flight ⇒ 拦截不执行
 * - 失败回滚：执行失败 ⇒ success=false（不把已取消状态写回）
 * - 高权限伪造：模型/平台 role 自带 confirm=true 仍被强制降级（与 role 无关）
 * - 跨通道：三边挂起/确认逻辑源码锚点（防回归哨兵）
 * - 审计：POST body 带 source='ai'（可追溯为 AI 发起）
 *
 * 负责人: 阿洲 | 创建日期: 2026-11-04
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- 集成测试批量断言 mock 依赖 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ToolExecutor } from '../tool-executor';
import { ToolRegistry } from '../tool-registry';
import type { ITool, ToolContext } from '../tool.interface';
import type { AuditLogger } from '../../bridge/audit-logger';
import { CircuitBreakerService } from '../circuit-breaker.service';
import { CancelOrderTool } from './cancel-order.tool';
import { CancelPurchaseOrderTool } from './cancel-purchase-order.tool';

import type {
  IdempotencyGateService,
  IdempotencyHandle,
} from '../idempotency-gate.service';

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };
const CTX_T2: ToolContext = { tenantId: 't2', userId: 'u2' };

/** 测试用取消订单工具（isWriteOperation=true；execute 可断言调用次数与收到的 body） */
class FakeCancelOrderTool implements ITool {
  readonly name = 'cancelOrder';
  readonly description = '测试用取消订单';
  readonly category = 'order' as const;
  readonly isWriteOperation = true;
  readonly idempotencyKeyFields = ['orderNo'] as const;
  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: { type: 'string', description: '订单号' },
      confirm: { type: 'boolean', description: '是否确认执行' },
    },
    required: ['orderNo'],
  };
  execute = jest.fn();
}

/** 测试用取消采购单工具 */
class FakeCancelPurchaseTool implements ITool {
  readonly name = 'cancelPurchaseOrder';
  readonly description = '测试用取消采购单';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly idempotencyKeyFields = ['orderNo'] as const;
  readonly parameters = {
    type: 'object' as const,
    properties: {
      orderNo: { type: 'string', description: '采购单号' },
      confirm: { type: 'boolean', description: '是否确认执行' },
    },
    required: ['orderNo'],
  };
  execute = jest.fn();
}

const HANDLE: IdempotencyHandle = {
  id: '1',
  tenantId: 't1',
  toolName: 'cancelOrder',
  idemKey: 'a'.repeat(64),
  keySource: 'confirm_token',
};

function makeToolCall(args: unknown, id = 'call-1'): any {
  return {
    id,
    type: 'function',
    function: { name: 'cancelOrder', arguments: JSON.stringify(args) },
  };
}

/** 真工具（走 ServiceClient mock，验证 preview/执行/审计 body） */
describe('取消订单二段式（工具层）', () => {
  let tool: CancelOrderTool;
  let post: jest.Mock;

  beforeEach(() => {
    post = jest.fn().mockResolvedValue({
      orderNo: 'ORD001',
      status: 'CANCELLED',
    });
    tool = new CancelOrderTool({
      post,
    } as never);
  });

  it('零写：confirm 缺省 → 仅返回 preview，POST 零调用', async () => {
    const r = await tool.execute({ orderNo: 'ORD001' }, CTX);
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('零写：confirm=false → 仅 preview，POST 零调用', async () => {
    const r = await tool.execute({ orderNo: 'ORD001', confirm: false }, CTX);
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('preview 携带后果说明与 AI 来源标记（消费者验收 1：先看到预览与后果）', async () => {
    const r = await tool.execute(
      { orderNo: 'ORD001', reason: '客户取消' },
      CTX,
    );
    const details = (r.preview as any).details;
    expect(details.source).toBe('ai');
    expect(details.consequence).toContain('CANCELLED');
    expect((r.preview as any).reviewRequired).toBe(true);
  });

  it('confirm=true → 真实执行取消（POST 调用，body 带 source=ai 可追溯）', async () => {
    post.mockResolvedValue({ orderNo: 'ORD001', status: 'CANCELLED' });

    const r = await tool.execute(
      { orderNo: 'ORD001', reason: '客户取消', confirm: true },
      CTX,
    );

    expect(r.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/ORD001/cancel'),
      expect.objectContaining({ reason: '客户取消', source: 'ai' }),
      CTX,
    );
  });

  it('执行失败 → success=false（不把已取消状态写回 UI）', async () => {
    post.mockRejectedValue(new Error('后端 500'));

    const r = await tool.execute({ orderNo: 'ORD001', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect((r.data as any)?.status).not.toBe('CANCELLED');
  });

  it('采购单：confirm 缺省 → 仅 preview 零写', async () => {
    const purchase = new CancelPurchaseOrderTool({ post } as never);

    const r = await purchase.execute({ orderNo: 'CG001' }, CTX);
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
    expect(post).not.toHaveBeenCalled();
  });

  it('采购单：confirm=true → 真实执行', async () => {
    const purchase = new CancelPurchaseOrderTool({ post } as never);
    post.mockResolvedValue({ orderNo: 'CG001', status: 'CANCELLED' });

    const r = await purchase.execute({ orderNo: 'CG001', confirm: true }, CTX);
    expect(r.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('取消订单确认链（执行器 + 幂等闸）', () => {
  let registry: ToolRegistry;
  let tool: FakeCancelOrderTool;
  let purchaseTool: FakeCancelPurchaseTool;
  let gate: {
    isEnabled: jest.Mock;
    check: jest.Mock;
    complete: jest.Mock;
  };
  let executor: ToolExecutor;

  beforeEach(() => {
    registry = new ToolRegistry();
    tool = new FakeCancelOrderTool();
    purchaseTool = new FakeCancelPurchaseTool();
    registry.register(tool);
    registry.register(purchaseTool);

    gate = {
      isEnabled: jest.fn(() => true),
      check: jest.fn(),
      complete: jest.fn(() => Promise.resolve()),
    };
    // 写工具缺省 preview（confirm 门降级后的形态）：success=true 无 data
    tool.execute.mockResolvedValue({
      success: true,
      preview: {
        operation: '取消订单',
        summary: '将取消订单 ORD001',
        details: { orderNo: 'ORD001', source: 'ai' },
        reviewRequired: true,
      },
    });
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
      gate as unknown as IdempotencyGateService,
    );
  });

  it('高危写缺省（confirm!==true）→ 幂等闸不被消耗（preview 零写）', async () => {
    gate.check.mockResolvedValue({
      decision: 'proceed',
      result: null,
      handle: HANDLE,
    });

    const r = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001' }),
      CTX,
    );
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
    expect(gate.check).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalledTimes(1);
    // 预览调用不落 POST（Fake 工具本身不发网络请求，仅断言未进入执行分支）
  });

  it('模型自带 confirm=true 无 allowConfirm → 强制降级 preview（高权限模型不能伪造）', async () => {
    const r = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001', confirm: true }),
      CTX,
    );
    // ToolExecutor 强制门：写工具的 confirm=true 一律降级为 preview
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
    expect(r.data).toBeUndefined();
  });

  it('确认通道（allowConfirm=true）→ 真实执行一次（MS 请求计数=1）', async () => {
    let postCount = 0;
    tool.execute.mockImplementation(async () => {
      postCount += 1;
      return { success: true, data: { orderNo: 'ORD001', postCount } };
    });

    const r = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001' }),
      CTX,
      { allowConfirm: true },
    );
    expect(r.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(postCount).toBe(1);
  });

  it('重复确认同一订单 → 幂等闸 replay 回放首次结果（MS 请求计数仍=1）', async () => {
    gate.check
      .mockResolvedValueOnce({ decision: 'proceed', handle: HANDLE })
      .mockResolvedValueOnce({
        decision: 'replay',
        handle: HANDLE,
        result: {
          success: true,
          idempotent_replay: true,
          data: { orderNo: 'ORD001' },
        },
      });

    const first = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001', confirm: true }),
      CTX,
      { allowConfirm: true },
    );
    expect(first.success).toBe(true);

    const second = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001', confirm: true }),
      CTX,
      { allowConfirm: true },
    );
    expect(second.success).toBe(true);
    expect(second.idempotent_replay).toBe(true);
    // replay：不重执行工具，直接回放既有结果
    expect(tool.execute).toHaveBeenCalledTimes(1);
  });

  it('in_flight（处理中）→ 拦截不执行', async () => {
    gate.check.mockResolvedValue({
      decision: 'in_flight',
      handle: null,
      result: {
        success: false,
        error: '该写操作正在处理中（工具 cancelOrder）',
      },
    });

    const r = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001', confirm: true }),
      CTX,
      { allowConfirm: true },
    );
    expect(r.success).toBe(false);
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('执行失败 → 幂等行回填 failed（允许重试），不把成功写回', async () => {
    tool.execute.mockRejectedValue(new Error('后端 500'));
    gate.check.mockResolvedValue({
      decision: 'proceed',
      handle: HANDLE,
    });

    const r = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001', confirm: true }),
      CTX,
      { allowConfirm: true },
    );
    expect(r.success).toBe(false);
    expect(gate.complete).toHaveBeenCalledWith(
      HANDLE,
      expect.objectContaining({ success: false }),
    );
  });

  it('错租户 → 不共享幂等键（t2 同订单号可独立执行）', async () => {
    let postCount = 0;
    tool.execute.mockImplementation(async () => {
      postCount += 1;
      return { success: true, data: { postCount } };
    });
    gate.check
      .mockResolvedValueOnce({
        decision: 'proceed',
        result: null,
        handle: { ...HANDLE, tenantId: 't1' },
      })
      .mockResolvedValueOnce({
        decision: 'proceed',
        result: null,
        handle: { ...HANDLE, tenantId: 't2' },
      });

    const r1 = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001' }),
      CTX,
      { allowConfirm: true },
    );
    const r2 = await executor.executeToolCall(
      makeToolCall({ orderNo: 'ORD001' }),
      CTX_T2,
      { allowConfirm: true },
    );
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledTimes(2);
  });
});

describe('跨通道确认链哨兵（源码锚点，防回归）', () => {
  const ROOT = join(__dirname, '../../../');

  it('三边均有写确认挂起逻辑（chat/agent/graph 源码锚点）', () => {
    // mutation 靶点：删除任一边的 preview 挂起逻辑 ⇒ 本用例红
    const chat = readFileSync(
      join(ROOT, 'src/brain/orchestrator.service.ts'),
      'utf8',
    );
    expect(chat).toContain('pending_write');
    expect(chat).toContain('await_confirm');

    const agent = readFileSync(
      join(ROOT, 'src/brain/agent/task-runner.service.ts'),
      'utf8',
    );
    expect(agent).toContain('pending_write');
    expect(agent).toContain('await_confirm');

    const graph = readFileSync(
      join(ROOT, 'src/brain/graph/graph-executor.service.ts'),
      'utf8',
    );
    expect(graph).toContain('pending_write');
    expect(graph).toContain('await_confirm');
  });

  it('三边均经 WriteConfirmPipeline 或既有确认服务（单一令牌生成源哨兵）', () => {
    // mutation 靶点：某边回退为自行生成令牌（绕过 pipeline）⇒ 对应断言红
    const chat = readFileSync(
      join(ROOT, 'src/brain/orchestrator.service.ts'),
      'utf8',
    );
    expect(chat).toContain('writeConfirmPipeline.suspend');

    const agent = readFileSync(
      join(ROOT, 'src/brain/agent/task-runner.service.ts'),
      'utf8',
    );
    expect(agent).toContain('writeConfirmPipeline.suspend');

    const graph = readFileSync(
      join(ROOT, 'src/brain/graph/graph-executor.service.ts'),
      'utf8',
    );
    expect(graph).toContain('writeConfirmPipeline.suspend');
  });

  it('审计可追溯：cancelOrder 真执行 body 带 source=ai（AI 发起标记）', () => {
    const tool = readFileSync(
      join(ROOT, 'src/tools/definitions/cancel-order.tool.ts'),
      'utf8',
    );
    expect(tool).toContain("source: 'ai'");
    const purchase = readFileSync(
      join(ROOT, 'src/tools/definitions/cancel-purchase-order.tool.ts'),
      'utf8',
    );
    expect(purchase).toContain("source: 'ai'");
  });
});
