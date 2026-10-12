/**
 * ConfirmationService × 显式幂等键 生产接线测试（R101-AI-24）
 *
 * 接线链路（唯一真实执行通道 = 写全审核确认通道）：
 *   POST /api/ai/agent/confirm（WriteGuardActionDto.idempotencyKey）
 *     → ConfirmationService.confirmAndExecute(..., idempotencyKey)
 *     → executeConfirmed(...) → ToolExecutor.executeToolCall(..., { allowConfirm: true, idempotencyKey })
 *     → IdempotencyGateService（key_source='explicit'）
 *
 * 本文件断言：显式键**确实**透传到 executor 的 options；不传时不出现该字段（行为零变化）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { ConfirmationService } from './confirmation.service';
import type { PendingConfirmation } from './confirmation.service';
import type { ToolContext } from '../tools/tool.interface';

interface Harness {
  service: ConfirmationService;
  executeToolCall: jest.Mock;
}

function createHarness(): Harness {
  const executeToolCall = jest.fn(() =>
    Promise.resolve({ success: true, data: { orderNo: 'SO1' } }),
  );
  // ctor 顺序：(writeGuard?, executor?, evidence?)；本文件只走 executeConfirmed，不经令牌校验
  const service = new ConfirmationService(
    {
      cleanupExpired: () => 0,
      resetToPending: () => Promise.resolve(true),
    } as never,
    { executeToolCall } as never,
  );
  return { service, executeToolCall };
}

/** 最小可用 PendingConfirmation（executeConfirmed 只用其中少数字段） */
function pendingConfirmation(): PendingConfirmation {
  return {
    confirmationId: 'wg_token_1',
    tenantId: 't1',
    toolName: 'createSalesOrder',
    docType: 'sales_order_create',
    risk: 'medium',
    needsReview: false,
    confirmCount: 1,
    args: { items: [{ skuId: 'S1' }] },
    preview: {
      operation: '创建销售单',
      summary: '测试预览',
      details: {},
    },
    operationLabel: '创建销售单',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'confirmed',
  };
}

const CTX: ToolContext = { tenantId: 't1', userId: 'u1' };

describe('ConfirmationService · 显式幂等键接线（R101-AI-24）', () => {
  it('executeConfirmed 传入显式键 ⇒ executor options 带 idempotencyKey（key_source=explicit 依据）', async () => {
    const h = createHarness();

    const result = await h.service.executeConfirmed(
      pendingConfirmation(),
      CTX,
      '确认执行',
      'ERP2026-0001',
    );

    expect(result.success).toBe(true);
    expect(h.executeToolCall).toHaveBeenCalledTimes(1);
    const [toolCall, , options] = h.executeToolCall.mock.calls[0] as [
      { id: string; function: { name: string; arguments: string } },
      ToolContext,
      { allowConfirm?: boolean; idempotencyKey?: string },
    ];
    // 写全审核门放行 + 显式键透传（调用方式：确认通道 → 真实执行）
    expect(options).toEqual({
      allowConfirm: true,
      idempotencyKey: 'ERP2026-0001',
    });
    // 真实执行参数仍带 confirm=true（既有语义未变）
    expect(JSON.parse(toolCall.function.arguments)).toEqual({
      items: [{ skuId: 'S1' }],
      confirm: true,
      remark: '确认执行',
    });
  });

  it('不传显式键 ⇒ options.idempotencyKey 为 undefined（行为与接线前一致）', async () => {
    const h = createHarness();

    await h.service.executeConfirmed(pendingConfirmation(), CTX);

    const [, , options] = h.executeToolCall.mock.calls[0] as [
      unknown,
      unknown,
      { allowConfirm?: boolean; idempotencyKey?: string },
    ];
    expect(options.allowConfirm).toBe(true);
    expect(options.idempotencyKey).toBeUndefined();
  });
});
