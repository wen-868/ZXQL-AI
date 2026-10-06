import { Test } from '@nestjs/testing';
import { RollbackExecutorService } from './rollback-executor.service';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolExecutor } from '../tools/tool-executor';
import type { ITool } from '../tools/tool.interface';
import type { ExecutedOperation } from './confirmation.service';

describe('RollbackExecutorService', () => {
  let service: RollbackExecutorService;
  let registry: ToolRegistry;
  /** 熔断开关（测试用：canProceed 依据此返回） */
  let breakerOpen = false;

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
    // P2 修复（2026-10-04）：回滚改经 ToolExecutor 执行（进审计/熔断/指标链），
    // 用真实 ToolExecutor + 桩审计/熔断/指标，registry 仍是测试桩
    const toolExecutor = new ToolExecutor(
      registry,
      { logToolExecution: jest.fn() } as never,
      {
        canProceed: jest.fn(() =>
          breakerOpen ? { ok: false, reason: '熔断 open' } : { ok: true },
        ),
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
      } as never,
      { recordToolCall: jest.fn(), recordToolDuration: jest.fn() } as never,
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        RollbackExecutorService,
        { provide: ToolRegistry, useValue: registry },
        { provide: ToolExecutor, useValue: toolExecutor },
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

  it('createSalesOrder 命中新映射并自动执行取消销售单（billNo 提取）', async () => {
    const execute = jest.fn().mockResolvedValue({
      success: true,
      data: { status: 'CANCELLED', message: '销售单已取消' },
    });
    registry.register({
      name: 'cancelOrder',
      execute,
    } as unknown as ITool);

    const res = await service.executeRollback(
      makeOperation({
        toolName: 'createSalesOrder',
        result: { billNo: 'XS2026092570288' },
      }),
      { tenantId: 't1', authToken: 'jwt' },
    );
    expect(res.handled).toBe(true);
    expect(res.success).toBe(true);
    expect(execute).toHaveBeenCalledWith(
      { orderNo: 'XS2026092570288', reason: expect.any(String) as string },
      expect.anything(),
    );
  });

  it('无回滚映射的操作降级为引导', async () => {
    const res = await service.executeRollback(
      makeOperation({ toolName: 'createProduct' }),
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

  // P2 返工回归（验收意见）：回滚受熔断管辖的副作用须有区别化提示
  it('回滚工具被熔断拦截 → 提示可重试语义（区别于普通失败）', async () => {
    breakerOpen = true;
    registry.register({
      name: 'cancelPurchaseOrder',
      execute: jest.fn(),
    } as unknown as ITool);

    const res = await service.executeRollback(makeOperation(), {
      tenantId: 't1',
    });
    expect(res.handled).toBe(true);
    expect(res.success).toBe(false);
    expect(res.message).toContain('熔断');
    expect(res.message).toContain('稍后重试');
  });
});
