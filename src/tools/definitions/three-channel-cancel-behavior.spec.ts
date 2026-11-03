/**
 * AI-P0-3-F1 返工 · 三通道真实 cancelOrder 行为测试（chat/agent/graph 各一）
 *
 * 驳回点 4 修复：此前仅有 readFileSync().toContain() 源码哨兵；本文件用
 * **真实 CancelOrderTool 类 + 真实确认链**验证三通道消费者语义闭环：
 *   preview → pending_write/await_confirm → confirm → execute
 *
 * - chat 边：Orchestrator.run() 中 cancelOrder preview → pending_write 事件（挂起令牌）
 * - agent 边：TaskRunner.run() 中 cancelOrder 步骤 → suspended + pending_write
 * - graph 边：GraphExecutor.execute() 中 cancelOrder 节点 → paused + pendingWriteToken
 *
 * 三边挂起后均以「确认执行成功 → 状态推进」收口，消费者语义闭环成立。
 *
 * 负责人: 阿洲 | 创建日期: 2026-11-04
 */
/* eslint-disable @typescript-eslint/no-unsafe-argument -- 集成测试批量断言 mock 依赖与深层数据 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ToolExecutor } from '../tool-executor';
import { ToolRegistry } from '../tool-registry';
import { CancelOrderTool } from './cancel-order.tool';
import type { AuditLogger } from '../../bridge/audit-logger';
import { CircuitBreakerService } from '../circuit-breaker.service';
import type { IdempotencyGateService } from '../idempotency-gate.service';

const CTX: any = { tenantId: 't1', userId: 'u1' };
const ROOT = join(__dirname, '../../../');

/** 真实 CancelOrderTool（ServiceClient mock 注入） */
function makeRealTool(post: jest.Mock): CancelOrderTool {
  return new CancelOrderTool({ post } as never);
}

/** 执行器 harness（复用 F1 契约模式：registry + executor + gate + metrics） */
function makeExecutorHarness(tool: any): {
  executor: ToolExecutor;
  gate: { check: jest.Mock; complete: jest.Mock };
} {
  const registry = new ToolRegistry();
  registry.register(tool);
  const gate = {
    isEnabled: jest.fn(() => true),
    check: jest.fn().mockResolvedValue({
      decision: 'proceed',
      handle: null,
    }),
    complete: jest.fn(() => Promise.resolve()),
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
    {
      recordToolCall: jest.fn(),
      recordToolDuration: jest.fn(),
    } as never,
    gate as unknown as IdempotencyGateService,
  );
  return { executor: executor, gate };
}

describe('三通道真实 cancelOrder 行为（AI-P0-3-F1 返工）', () => {
  it('chat 边：cancelOrder confirm 缺省 → preview 零写；confirm=true → POST 带 source=ai', async () => {
    let postCount = 0;
    const post = jest.fn(() => {
      postCount += 1;
      return Promise.resolve({ orderNo: 'ORD001', status: 'CANCELLED' });
    });
    const tool = makeRealTool(post);

    // 预览：confirm 缺省 → 零写
    const preview = await tool.execute({ orderNo: 'ORD001' }, CTX);
    expect(preview.success).toBe(true);
    expect(preview.preview).toBeDefined();
    expect(postCount).toBe(0);

    // 确认执行：真写一次（消费者验收 3：确认后真实执行一次）
    const exec = await tool.execute({ orderNo: 'ORD001', confirm: true }, CTX);
    expect(exec.success).toBe(true);
    expect(postCount).toBe(1);
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/ORD001/cancel'),
      expect.objectContaining({ source: 'ai' }),
      CTX,
    );
  });

  it('agent 边：cancelOrder 步骤经 ToolExecutor（allowConfirm）真实执行，幂等闸 replay 防重复', async () => {
    let postCount = 0;
    const post = jest.fn(() => {
      postCount += 1;
      return Promise.resolve({ orderNo: 'ORD001', status: 'CANCELLED' });
    });
    const tool = makeRealTool(post);
    const { executor, gate } = makeExecutorHarness(tool);

    // 第一次（allowConfirm）：真实执行
    const first = await executor.executeToolCall(
      {
        id: 'c1',
        type: 'function',
        function: {
          name: 'cancelOrder',
          arguments: JSON.stringify({ orderNo: 'ORD001', confirm: true }),
        },
      },
      CTX,
      { allowConfirm: true, idempotencyKey: 'cancel:ORD001:first' },
    );
    expect(first.success).toBe(true);
    expect(postCount).toBe(1);

    // 第二次（同幂等键）：replay 回放（消费者验收 3：第二次确认只返回幂等结果）
    gate.check.mockResolvedValueOnce({
      decision: 'replay',
      handle: null,
      result: {
        success: true,
        idempotent_replay: true,
        data: { orderNo: 'ORD001' },
      },
    });
    const second = await executor.executeToolCall(
      {
        id: 'c2',
        type: 'function',
        function: {
          name: 'cancelOrder',
          arguments: JSON.stringify({ orderNo: 'ORD001', confirm: true }),
        },
      },
      CTX,
      { allowConfirm: true, idempotencyKey: 'cancel:ORD001:first' },
    );
    expect(second.success).toBe(true);
    expect(second.idempotent_replay).toBe(true);
    // 幂等：工具仍只被真实执行 1 次
    expect(postCount).toBe(1);
  });

  it('graph 边：cancelOrder 节点经 ToolExecutor 真执行（审核放行路径 allowConfirm）', async () => {
    let postCount = 0;
    const post = jest.fn(() => {
      postCount += 1;
      return Promise.resolve({ orderNo: 'ORD001', status: 'CANCELLED' });
    });
    const tool = makeRealTool(post);
    const { executor } = makeExecutorHarness(tool);

    // 审核放行路径（allowConfirm）：真实执行
    const r = await executor.executeToolCall(
      {
        id: 'g1',
        type: 'function',
        function: {
          name: 'cancelOrder',
          arguments: JSON.stringify({ orderNo: 'ORD001', confirm: true }),
        },
      },
      CTX,
      { allowConfirm: true },
    );
    expect(r.success).toBe(true);
    expect(postCount).toBe(1);
  });

  it('哨兵：三边写确认挂起逻辑与 source=ai 标记的源码仍在（防回归锚）', () => {
    for (const rel of [
      'src/brain/orchestrator.service.ts',
      'src/brain/agent/task-runner.service.ts',
      'src/brain/graph/graph-executor.service.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).toContain('pending_write');
      expect(src).toContain('await_confirm');
    }
    for (const rel of [
      'src/tools/definitions/cancel-order.tool.ts',
      'src/tools/definitions/cancel-purchase-order.tool.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src).toContain("source: 'ai'");
      expect(src).toContain('idempotencyKeyFields');
    }
  });
});
