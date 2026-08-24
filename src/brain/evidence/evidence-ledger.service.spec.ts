/**
 * EvidenceLedgerService 单元测试（C10 证据验证，P0-7）
 *
 * 覆盖：写操作账本留痕、成功缺 data 核查、金额/数量类型核查、正常结果通过
 */
import { AuditLogger } from '../../bridge/audit-logger';
import { EvidenceLedgerService } from './evidence-ledger.service';

describe('EvidenceLedgerService', () => {
  let service: EvidenceLedgerService;
  let auditLogger: { logAiCall: jest.Mock };

  beforeEach(() => {
    auditLogger = { logAiCall: jest.fn() };
    service = new EvidenceLedgerService(auditLogger as unknown as AuditLogger);
  });

  it('recordWrite 写操作留痕到审计', () => {
    service.recordWrite(
      { tenantId: 't1', userId: 'u1', sessionId: 's1' },
      'createSalesOrder',
      { customerName: '红星商行' },
      { success: true, data: { orderNo: 'XS001' } },
    );
    expect(auditLogger.logAiCall).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 't1',
        intent: 'evidence_write_ledger',
        success: true,
        toolCalls: expect.arrayContaining([
          expect.objectContaining({
            tool_name: 'createSalesOrder',
            is_write_operation: true,
          }),
        ]) as Array<Record<string, unknown>>,
      }),
    );
  });

  it('verify：成功但缺 data 时判定异常', () => {
    const result = service.verify({ success: true });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('缺少 data');
  });

  it('verify：金额/数量字段类型异常时提示', () => {
    const result = service.verify({
      success: true,
      data: { amount: { value: 100 } },
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('amount'))).toBe(true);
  });

  it('verify：正常结果通过', () => {
    const result = service.verify({
      success: true,
      data: { orderNo: 'XS001', totalAmount: 19600, quantity: 20 },
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('verify：失败结果不核查 data', () => {
    const result = service.verify({ success: false, error: '库存不足' });
    expect(result.ok).toBe(true);
  });
});
