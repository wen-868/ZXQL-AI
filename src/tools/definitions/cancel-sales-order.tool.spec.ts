/**
 * cancelSalesOrder 工具测试（R101-AI-36 · P1-3 兑现）
 *
 * 反测 5 组（各含 mutation；判据=目标用例变红）：
 * ① **preview 不执行**：`confirm` 缺省 ⇒ 返回 preview 且**不调后端**
 *    （mutation：去掉 `if (!confirm)` 早返回 ⇒ 本例红）
 * ② **body 必带 `source:'ai'`**（"AI 改动可追溯"）：断言 post 次参含 source='ai'
 *    （mutation：去掉 source ⇒ 本例红）
 * ③ MS 400（已结清）⇒ **可读文案原样透出**且不崩（含"已结清需走冲销流程"）
 * ④ **幂等**：`idempotencyKeyFields` 声明 `billNo`（业务键口径）⇒ 同一单重复取消是同一键
 *    （mutation：去掉 idempotencyKeyFields 声明 ⇒ 本例红）
 * ⑤ 双字段口径：识别已取消看 `businessStatus==='VOIDED' || status==='CANCELLED'`
 *    （**不得**要求 `business_status==='CANCELLED'`）
 * ⑥ 写工具契约：isWriteOperation=true + risk='high'
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { BridgeError, ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { CancelSalesOrderTool } from './cancel-sales-order.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function createHarness(
  postImpl: (path: string, body: unknown, ctx: ToolContext) => Promise<unknown>,
) {
  const post = jest.fn(postImpl);
  const tool = new CancelSalesOrderTool({ post } as unknown as ServiceClient);
  return { tool, post };
}

describe('CancelSalesOrderTool（R101-AI-36 取消销售单 SO/SB）', () => {
  it('① preview（confirm 缺省）⇒ 返回 preview 且**不调后端**', async () => {
    const h = createHarness(() => Promise.resolve({}));

    const result = await h.tool.execute(
      { billNo: 'SO202610010001', reason: '客户取消订货' },
      CTX,
    );

    expect(result.success).toBe(true);
    expect(result.preview?.operation).toBe('取消销售单');
    expect(result.preview?.summary).toContain('SO202610010001');
    const details = result.preview?.details as Record<string, unknown>;
    expect(details.billNo).toBe('SO202610010001');
    expect(details.reason).toBe('客户取消订货');
    expect(details.source).toBe('ai');
    expect(String(details.consequence)).toContain('库存将回滚');
    expect(result.preview?.reviewRequired).toBe(true);
    // 承重断言：预览绝不执行
    expect(h.post).not.toHaveBeenCalled();
    // mutation 检验点：去掉 `if (!confirm)` 早返回 ⇒ 会调 post ⇒ 本例红
  });

  it('② confirm=true ⇒ 调 MS 端点且 body **必带 source:ai**', async () => {
    const h = createHarness(() =>
      Promise.resolve({
        billNo: 'SO202610010001',
        status: 'CANCELLED',
        businessStatus: 'VOIDED',
        reversedStock: true,
      }),
    );

    const result = await h.tool.execute(
      { billNo: 'SO202610010001', reason: '客户取消', confirm: true },
      CTX,
    );

    expect(result.success).toBe(true);
    const call = h.post.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe('/api/admin/sale-bills/SO202610010001/cancel');
    // 🔴 来源标记（不传会被记成 admin ⇒ AI 改动可追溯断链）
    expect(call[1].source).toBe('ai');
    expect(call[1].reason).toBe('客户取消');
    // mutation 检验点：去掉 `source: 'ai'` ⇒ 本断言红
    const data = result.data as { cancelled: boolean; reversedStock: boolean };
    expect(data.cancelled).toBe(true);
    expect(data.reversedStock).toBe(true);
  });

  it('③ MS 400（已结清）⇒ 可读文案原样透出且不崩', async () => {
    const h = createHarness(() =>
      Promise.reject(
        new BridgeError(
          '后端 HTTP 400：已结清需走冲销流程（path=/api/admin/sale-bills/SO9/cancel）',
          400,
          '400',
        ),
      ),
    );

    const result = await h.tool.execute({ billNo: 'SO9', confirm: true }, CTX);

    expect(result.success).toBe(false);
    expect(result.error).toContain('已结清需走冲销流程');
    expect(result.suggestion).toContain('sale:cancel');
  });

  it('④ 幂等键口径：声明 idempotencyKeyFields=[billNo]（业务键，AI-25）', () => {
    const h = createHarness(() => Promise.resolve({}));
    // 同一张单重复取消 ⇒ 同一业务键 ⇒ 由幂等闸门回放（不二次执行、不二次回滚库存）
    expect(h.tool.idempotencyKeyFields).toEqual(['billNo']);
    // mutation 检验点：删掉该声明 ⇒ 本例红（会退化为 payload_hash 口径，重复取消不再回放）
  });

  it('⑤ 双字段口径：识别已取消看 status=CANCELLED 或 businessStatus=VOIDED（不得要求 business_status=CANCELLED）', async () => {
    // 只给 businessStatus=VOIDED（契约 status 缺失）⇒ 仍应判定 cancelled=true
    const onlyVoided = createHarness(() =>
      Promise.resolve({ billNo: 'SO1', businessStatus: 'VOIDED' }),
    );
    const r1 = await onlyVoided.tool.execute(
      { billNo: 'SO1', confirm: true },
      CTX,
    );
    expect((r1.data as { cancelled: boolean }).cancelled).toBe(true);

    // 只给 status=CANCELLED ⇒ 同样判定 true
    const onlyCancelled = createHarness(() =>
      Promise.resolve({ billNo: 'SO2', status: 'CANCELLED' }),
    );
    const r2 = await onlyCancelled.tool.execute(
      { billNo: 'SO2', confirm: true },
      CTX,
    );
    expect((r2.data as { cancelled: boolean }).cancelled).toBe(true);

    // mutation 检验点：把判定改成要求 businessStatus==='CANCELLED' ⇒ 上面两条红
  });

  it('⑥ 写工具契约：isWriteOperation=true + risk=high；入参校验 billNo 必填', async () => {
    const h = createHarness(() => Promise.resolve({}));
    expect(h.tool.isWriteOperation).toBe(true);
    expect(h.tool.risk).toBe('high');
    expect(h.tool.name).toBe('cancelSalesOrder');

    const noBill = await h.tool.execute({ confirm: true }, CTX);
    expect(noBill.success).toBe(false);
    expect(noBill.error).toContain('billNo');
    expect(h.post).not.toHaveBeenCalled();
  });
});
