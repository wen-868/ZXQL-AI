import { Test } from '@nestjs/testing';
import { RollbackExecutorService } from './rollback-executor.service';
import { ToolRegistry } from '../tools/tool-registry';
import type { ITool } from '../tools/tool.interface';
import type { ExecutedOperation } from './confirmation.service';

describe('RollbackExecutorService', () => {
  let service: RollbackExecutorService;
  let registry: ToolRegistry;

  const makeOperation = (
    overrides: Partial<ExecutedOperation> = {},
  ): ExecutedOperation => ({
    operationId: 'op-1',
    tenantId: 't1',
    toolName: 'createPurchaseOrder',
    args: {},
    result: { orderNo: 'CG2026081500001' },
    operationLabel: '创建采购单',
    executedAt: Date.now(),
    revokeExpiresAt: Date.now() + 180000,
    status: 'executed',
    ...overrides,
  });

  beforeEach(async () => {
    registry = new ToolRegistry();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RollbackExecutorService,
        { provide: ToolRegistry, useValue: registry },
      ],
    }).compile();
    service = moduleRef.get(RollbackExecutorService);
  });

  it('createPurchaseOrder 命中映射并自动执行取消采购单', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      data: { status: 'CANCELLED', message: '采购单已取消' },
    });
    registry.register({
      name: 'cancelPurchaseOrder',
      execute,
    } as unknown as ITool);

    const res = await service.executeRollback(makeOperation(), {
      tenantId: 't1',
      authToken: 'jwt',
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      { orderNo: 'CG2026081500001', reason: expect.any(String) as string },
      expect.objectContaining({ tenantId: 't1', authToken: 'jwt' }),
    );
  });

  it('从 args.orderNo 提取单号（result 缺失时）', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true, data: {} });
    registry.register({
      name: 'cancelPurchaseOrder',
      execute,
    } as unknown as ITool);

    await service.executeRollback(
      makeOperation({ args: { orderNo: 'CG-ARG-001' }, result: undefined }),
      { tenantId: 't1' },
    );
    expect(execute).toHaveBeenCalledWith(
      { orderNo: 'CG-ARG-001', reason: expect.any(String) as string },
      expect.anything(),
    );
  });

  it('无回滚映射的操作降级为引导', async () => {
    const res = await service.executeRollback(
      makeOperation({ toolName: 'createSalesOrder' }),
      { tenantId: 't1' },
    );
    expect(res.handled).toBe(false);
    expect(res.message).toContain('暂不支持自动回滚');
  });

  it('回滚工具未注册时降级', async () => {
    const res = await service.executeRollback(makeOperation(), {
      tenantId: 't1',
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toContain('未注册');
  });

  it('无法提取单号时降级', async () => {
    registry.register({
      name: 'cancelPurchaseOrder',
      execute: jest.fn(),
    } as unknown as ITool);
    const res = await service.executeRollback(
      makeOperation({ args: {}, result: undefined }),
      { tenantId: 't1' },
    );
    expect(res.success).toBe(false);
    expect(res.message).toContain('无法从操作记录提取单据号');
  });

  it('回滚工具执行失败时返回失败信息', async () => {
    registry.register({
      name: 'cancelPurchaseOrder',
      execute: jest
        .fn()
        .mockResolvedValue({ success: false, error: '采购单状态不可取消' }),
    } as unknown as ITool);
    const res = await service.executeRollback(makeOperation(), {
      tenantId: 't1',
    });
    expect(res.success).toBe(false);
    expect(res.message).toContain('自动回滚失败');
  });
});
