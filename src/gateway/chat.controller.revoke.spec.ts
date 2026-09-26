/**
 * ChatController.revokeOperation —— 撤销/自动回滚结果契约单测
 *
 * 背景（2026-09-26 调查）：撤销端点原实现先 `markRevoked`（**删除**记录）再执行自动回滚，
 * 且无论回滚成败都返回 `success: true`。后果是：命中回滚映射但回滚失败时，
 * 用户看到"撤销成功"，但业务单据仍在执行态，且记录已被删除 —— 3 分钟窗口内
 * **失去重试入口**，形成不可重试的静默数据不一致。
 *
 * 本单测锁死三分支契约：
 * 1. 自动回滚成功 → success:true，记录清除（不可重复撤销）
 * 2. 自动回滚失败 → success:false + error，记录**保留**（窗口内可重试）
 * 3. 无回滚映射 → success:true + 引导文案（既有降级语义，不阻塞用户）
 *
 * 负责人: AI底座 | 创建日期: 2026-09-26
 */
import { ChatController } from './chat.controller';
import {
  ConfirmationService,
  type ExecutedOperation,
} from '../brain/confirmation.service';
import type { RollbackExecutorService } from '../brain/rollback-executor.service';
import { TenantContext } from '../tenant/tenant-context';
import type { ToolContext } from '../tools/tool.interface';
import type { Orchestrator } from '../brain/orchestrator.service';
import type { TaskRunnerService } from '../brain/agent/task-runner.service';
import type { ExternalModelService } from '../tenant/external-model.service';
import type { AiConfigService } from '../tenant/ai-config.service';
import type { VisionService } from '../providers/vision.service';
import type { RollbackResult } from '../brain/rollback-executor.service';

/**
 * revoke 链路不涉及的依赖用定型空桩（避免 any 引发的 lint 告警）
 */
const UNUSED_ORCHESTRATOR = undefined as unknown as Orchestrator;
const UNUSED_TASK_RUNNER = undefined as unknown as TaskRunnerService;
const UNUSED_EXTERNAL_MODEL = undefined as unknown as ExternalModelService;
const UNUSED_AI_CONFIG = undefined as unknown as AiConfigService;
const UNUSED_VISION = undefined as unknown as VisionService;

/** 构造只测 revoke 端点的最小控制器（其余依赖传空桩，revoke 链路不涉及） */
function buildController(
  confirmationService: ConfirmationService,
  rollbackExecutor: RollbackExecutorService,
  tenantContext: TenantContext,
): ChatController {
  return new ChatController(
    UNUSED_ORCHESTRATOR,
    tenantContext,
    confirmationService,
    UNUSED_TASK_RUNNER,
    rollbackExecutor,
    UNUSED_EXTERNAL_MODEL,
    UNUSED_AI_CONFIG,
    UNUSED_VISION,
  );
}

/** 回滚执行器桩：按预设结果返回，并记录调用参数 */
function fakeRollbackExecutor(
  result: { handled: boolean; success?: boolean; message: string },
  spy?: { calls: Array<{ toolName: string; context: ToolContext }> },
): RollbackExecutorService {
  const executeRollback = (
    operation: ExecutedOperation,
    context: ToolContext,
  ): Promise<RollbackResult> => {
    spy?.calls.push({ toolName: operation.toolName, context });
    return Promise.resolve({ ...result, data: undefined });
  };

  return { executeRollback } as unknown as RollbackExecutorService;
}

describe('ChatController.revokeOperation 撤销/回滚契约', () => {
  const TENANT = 'tenant-A';
  let confirmationService: ConfirmationService;
  let tenantContext: TenantContext;

  beforeEach(() => {
    confirmationService = new ConfirmationService();
    tenantContext = new TenantContext();
  });

  /** 注册一个已执行操作并返回其 ID */
  function registerOperation(): string {
    return confirmationService.registerExecuted({
      tenantId: TENANT,
      conversationId: 'conv-1',
      toolName: 'createSalesOrder',
      args: { confirm: true },
      result: { billNo: 'SB20260926001' },
      operationLabel: '创建销售单',
    }).operationId;
  }

  it('自动回滚成功：返回成功且清除记录（不可重复撤销）', async () => {
    const operationId = registerOperation();
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor({
        handled: true,
        success: true,
        message: '已自动回滚：单据已取消',
      }),
      tenantContext,
    );

    const res = await tenantContext.run({ tenantId: TENANT }, () =>
      controller.revokeOperation(operationId, {}),
    );

    expect(res.success).toBe(true);
    expect(res.rollbackHandled).toBe(true);
    expect(res.rollbackSuccess).toBe(true);
    // 成功即落定，记录清除
    expect(confirmationService.getExecuted(operationId)).toBeNull();
  });

  it('自动回滚失败：返回失败且保留记录（窗口内可重试）', async () => {
    const operationId = registerOperation();
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor({
        handled: true,
        success: false,
        message: '自动回滚失败：后端取消接口 500',
      }),
      tenantContext,
    );

    const res = await tenantContext.run({ tenantId: TENANT }, () =>
      controller.revokeOperation(operationId, {}),
    );

    // 关键断言：不得谎报成功
    expect(res.success).toBe(false);
    expect(res.error).toContain('自动回滚失败');
    expect(res.rollbackHandled).toBe(true);
    expect(res.rollbackSuccess).toBe(false);

    // 关键断言：重试入口必须保留，否则单据卡在执行态且无撤销手段
    const kept = confirmationService.getExecuted(operationId);
    expect(kept).not.toBeNull();
    expect(kept?.status).toBe('executed');
    expect(kept?.lastRevokeError).toContain('自动回滚失败');
    expect(confirmationService.canRevoke(operationId, TENANT).ok).toBe(true);
  });

  it('回滚失败后再次撤销可重试，且累计尝试次数', async () => {
    const operationId = registerOperation();
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor({
        handled: true,
        success: false,
        message: '自动回滚失败：超时',
      }),
      tenantContext,
    );

    await tenantContext.run({ tenantId: TENANT }, () =>
      controller.revokeOperation(operationId, {}),
    );
    await tenantContext.run({ tenantId: TENANT }, () =>
      controller.revokeOperation(operationId, {}),
    );

    expect(confirmationService.getExecuted(operationId)?.revokeAttempts).toBe(
      2,
    );
  });

  it('无回滚映射：降级为引导且返回成功（不阻塞，维持既有语义）', async () => {
    const operationId = registerOperation();
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor({
        handled: false,
        message: '操作类型 createSalesOrder 暂不支持自动回滚',
      }),
      tenantContext,
    );

    const res = await tenantContext.run({ tenantId: TENANT }, () =>
      controller.revokeOperation(operationId, {}),
    );

    expect(res.success).toBe(true);
    expect(res.rollbackHandled).toBe(false);
    expect(res.message).toContain('暂不支持自动回滚');
    expect(confirmationService.getExecuted(operationId)).toBeNull();
  });

  it('未认证：无租户上下文时拒绝撤销', async () => {
    const operationId = registerOperation();
    const spy = {
      calls: [] as Array<{ toolName: string; context: ToolContext }>,
    };
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor(
        { handled: true, success: true, message: 'ok' },
        spy,
      ),
      tenantContext,
    );

    const res = await controller.revokeOperation(operationId, {});

    expect(res.success).toBe(false);
    expect(res.error).toContain('未认证');
    // 不得在未认证时触发任何回滚调用
    expect(spy.calls).toHaveLength(0);
    expect(confirmationService.getExecuted(operationId)).not.toBeNull();
  });

  it('回滚执行器应收到租户与鉴权上下文（避免跨租户/无 token 调用）', async () => {
    const operationId = registerOperation();
    const spy = {
      calls: [] as Array<{ toolName: string; context: ToolContext }>,
    };
    const controller = buildController(
      confirmationService,
      fakeRollbackExecutor(
        { handled: true, success: true, message: 'ok' },
        spy,
      ),
      tenantContext,
    );

    await tenantContext.run(
      { tenantId: TENANT, userId: 'u-1', authToken: 'jwt-xxx' },
      () => controller.revokeOperation(operationId, {}),
    );

    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].toolName).toBe('createSalesOrder');
    expect(spy.calls[0].context.tenantId).toBe(TENANT);
    expect(spy.calls[0].context.authToken).toBe('jwt-xxx');
  });
});
