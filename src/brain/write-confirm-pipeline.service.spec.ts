/**
 * WriteConfirmPipelineService 组件契约测试（AI-P2-4 切片 1）
 *
 * 硬验收对应：
 * 1. `WriteConfirmPipeline.suspend()` 为三通道唯一入口（令牌生成不再
 *    在通道侧发生——组件内委托 ConfirmationService.create 是唯一路径）；
 * 2. expireAt 单源：透传 suspend 落库的 write.expiresAt（随
 *    WRITE_TOKEN_TTL_HOURS 可配置），通道不再各自计算；
 * 3. 令牌契约：wg_ 前缀由 WriteGuardService.suspend 保证，组件不得篡改。
 *
 * 负责人: 阿洲 | 创建日期: 2026-10-31
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试断言直接引用 mock 方法及其调用参数 */
import { WriteConfirmPipelineService } from './write-confirm-pipeline.service';
import { ConfirmationService } from './confirmation.service';

const BASE_INPUT = {
  tenantId: 'tenant-A',
  conversationId: 'conv-1',
  toolName: 'createSalesOrder',
  docType: 'createSalesOrder',
  risk: 'medium' as const,
  needsReview: false,
  args: { confirm: false, customerName: '红星商行' },
  preview: {
    operation: '创建销售单',
    summary: '红星商行 20 件五粮液',
    details: {},
  },
  operationLabel: '创建销售单',
};

describe('WriteConfirmPipelineService（AI-P2-4 切片 1）', () => {
  function createService(
    opts: {
      confirmationId?: string;
      expiresAt?: number;
    } = {},
  ) {
    const confirmation = {
      confirmationId: opts.confirmationId ?? 'wg_pipeline_token',
      tenantId: BASE_INPUT.tenantId,
      toolName: BASE_INPUT.toolName,
      docType: BASE_INPUT.docType,
      risk: 'medium' as const,
      needsReview: false,
      args: BASE_INPUT.args,
      preview: BASE_INPUT.preview,
      operationLabel: BASE_INPUT.operationLabel,
      status: 'pending',
      confirmCount: 0,
      expiresAt: opts.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
      createdAt: Date.now(),
    };
    const confirmationService = {
      create: jest.fn().mockResolvedValue(confirmation),
    } as unknown as ConfirmationService;
    const service = new WriteConfirmPipelineService(confirmationService);
    return { service, confirmationService, confirmation };
  }

  it('suspend 委托 ConfirmationService.create 并透传完整入参（唯一令牌生成路径）', async () => {
    const { service, confirmationService } = createService();

    const out = await service.suspend(BASE_INPUT);

    expect(confirmationService.create).toHaveBeenCalledTimes(1);
    expect(confirmationService.create).toHaveBeenCalledWith(BASE_INPUT);
    // mutation M2 靶点：组件篡改令牌前缀 ⇒ 此断言红
    expect(out.token).toBe('wg_pipeline_token');
    expect(out.confirmation).toBeDefined();
  });

  it('expireAt 单源：透传 suspend 落库的令牌过期时间（不自算、不硬编码 24h）', async () => {
    // 模拟 WRITE_TOKEN_TTL_HOURS=2 的配置态：suspend 落库 expiresAt = now + 2h
    const twoHours = Date.now() + 2 * 60 * 60 * 1000;
    const { service, confirmationService } = createService({
      expiresAt: twoHours,
    });

    const out = await service.suspend(BASE_INPUT);

    // mutation M1 靶点：组件自算 expireAt（Date.now()+硬编码 TTL）⇒ 此断言红
    expect(out.expireAt).toBe(twoHours);
    expect(confirmationService.create).toHaveBeenCalledTimes(1);
  });

  it('入参适配：planId/planStepId（agent 维度）与 customerId（运营客户端）透传', async () => {
    const { service, confirmationService } = createService();

    await service.suspend({
      ...BASE_INPUT,
      conversationId: 'emp_buyer',
      customerId: 'cust-9',
      planId: 7,
      planStepId: 's2',
      needsReview: true,
      risk: 'high' as const,
    });

    expect(confirmationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cust-9',
        planId: 7,
        planStepId: 's2',
        needsReview: true,
        risk: 'high',
      }),
    );
  });
});
