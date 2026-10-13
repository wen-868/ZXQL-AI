/**
 * AdminController.executeTool 多租户隔离测试（2026-10-04 P0 修复回归）
 *
 * 背景：POST /api/admin/tools/execute 此前把 context.tenantId 完全交给
 * 请求体自报——商户管理员携带合法 JWT、body 传他人租户 ID，即可调用
 * ToolRegistry 全部业务工具跨租户读写。修复口径：商户身份锁定 JWT 中的
 * 租户；仅平台身份允许经 body 指定目标租户。
 *
 * 用 Object.create 式最小构造：只挂被测方法用到的 executor/logger。
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminController } from './admin.controller';

function reqOf(
  identityType: 'merchant' | 'platform',
  tenantId?: string,
): Request {
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

function createController() {
  const executor = {
    executeToolCall: jest.fn().mockResolvedValue({ success: true, data: {} }),
  };
  const controller = Object.create(
    AdminController.prototype,
  ) as AdminController;
  Object.defineProperty(controller, 'executor', { value: executor });
  Object.defineProperty(controller, 'logger', {
    value: { log: jest.fn(), warn: jest.fn() },
  });
  return { controller, executor };
}

const baseDto = {
  name: 'searchCustomer',
  args: {},
  context: { userId: '1', sessionId: 's1' },
};

describe('AdminController.executeTool 租户锁定（P0）', () => {
  it('商家身份：body 自报他人租户 → 403（统一口径：不静默改写）', async () => {
    const { controller, executor } = createController();

    await expect(
      controller.executeTool(reqOf('merchant', 'tenant-A'), {
        ...baseDto,
        context: { ...baseDto.context, tenantId: 'tenant-B' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executor.executeToolCall).not.toHaveBeenCalled();
  });

  it('商家身份：body 缺 tenantId → 用 JWT 租户，不再沿用请求体', async () => {
    const { controller, executor } = createController();

    await controller.executeTool(reqOf('merchant', 'tenant-A'), {
      ...baseDto,
    } as never);

    expect(executor.executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-A' }),
    );
  });

  it('平台身份：body 指定目标租户 → 允许代执行', async () => {
    const { controller, executor } = createController();

    await controller.executeTool(reqOf('platform'), {
      ...baseDto,
      context: { ...baseDto.context, tenantId: 'tenant-B' },
    });

    expect(executor.executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: 'tenant-B' }),
    );
  });

  it('平台身份：未指定目标租户 → 400（不接受缺省，防静默落到错误租户）', async () => {
    const { controller, executor } = createController();

    await expect(
      controller.executeTool(reqOf('platform'), baseDto as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(executor.executeToolCall).not.toHaveBeenCalled();
  });

  it('身份缺失（未经守卫直调）→ 403', async () => {
    const { controller, executor } = createController();

    await expect(
      controller.executeTool({} as unknown as Request, baseDto as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(executor.executeToolCall).not.toHaveBeenCalled();
  });
});

/**
 * R101-AI-28：tools/execute 的 authToken 透传
 *
 * 缺陷：构造的 context 不含 authToken ⇒ 工具经 ServiceClient 调后端无 Authorization
 * ⇒ 后端 401「未登录」，该端点实际不可用。修复：从 AdminIdentity.authToken 透传。
 */
describe('AdminController.executeTool authToken 透传（R101-AI-28）', () => {
  /** 带 authToken 的 req（模拟 AdminGuard 验签后挂载） */
  function reqWithToken(
    identityType: 'merchant' | 'platform',
    tenantId: string | undefined,
    authToken: string | undefined,
  ): Request {
    return {
      adminIdentity: {
        identityType,
        tenantId,
        userId: 1,
        username: 'tester',
        authToken,
      },
    } as unknown as Request;
  }

  it('商户身份：context.authToken 透传为操作者本人 JWT（工具调后端带 Authorization）', async () => {
    const { controller, executor } = createController();

    await controller.executeTool(
      reqWithToken('merchant', 'tenant-A', 'jwt-merchant-abc'),
      baseDto as never,
    );

    expect(executor.executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-A',
        authToken: 'jwt-merchant-abc',
      }),
    );
  });

  it('平台身份：同样透传操作者 JWT（跨租户代执行也须带身份）', async () => {
    const { controller, executor } = createController();

    await controller.executeTool(
      reqWithToken('platform', 'tenant-B', 'jwt-platform-xyz'),
      {
        ...baseDto,
        context: { ...baseDto.context, tenantId: 'tenant-B' },
      },
    );

    expect(executor.executeToolCall).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'tenant-B',
        authToken: 'jwt-platform-xyz',
      }),
    );
  });

  it('身份未携带 authToken（历史/异常路径）⇒ context.authToken 为 undefined（行为不变）', async () => {
    const { controller, executor } = createController();

    await controller.executeTool(
      reqWithToken('merchant', 'tenant-A', undefined),
      baseDto as never,
    );

    const [, ctx] = executor.executeToolCall.mock.calls[0] as [
      unknown,
      { authToken?: string; tenantId: string },
    ];
    expect(ctx.tenantId).toBe('tenant-A');
    expect(ctx.authToken).toBeUndefined();
  });
});
