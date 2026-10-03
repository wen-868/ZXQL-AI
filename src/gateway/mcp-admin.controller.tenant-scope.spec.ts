/**
 * McpAdminController 租户收口测试（2026-10-04 P1 修复回归）
 *
 * 背景：商户管理员此前可——① 经查询参数/请求体自报他人租户，枚举并
 * 为他人租户铸造 MCP Token（等于把对方租户的数据通道交出去）；
 * ② 按 id 启停/删除任意租户的 Token。修复口径与全仓一致：商户锁本租户、
 * 平台跨租户须显式指定目标。
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { McpAdminController } from './mcp-admin.controller';

function reqOf(
  identityType: 'merchant' | 'platform',
  tenantId?: string,
): Request {
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

function createController() {
  const tokenService = {
    list: jest.fn().mockResolvedValue([]),
    create: jest
      .fn()
      .mockResolvedValue({ entity: { id: 1 }, plaintext: 'plain-token' }),
    setEnabledFor: jest.fn().mockResolvedValue(true),
    removeFor: jest.fn().mockResolvedValue(true),
  };
  const controller = Object.create(
    McpAdminController.prototype,
  ) as McpAdminController;
  Object.defineProperty(controller, 'tokenService', { value: tokenService });
  return { controller, tokenService };
}

describe('McpAdminController 租户收口', () => {
  it('GET 列表（商户）：不带过滤条件 → 本租户；自报他人租户 → 403', async () => {
    const { controller, tokenService } = createController();

    await controller.list(reqOf('merchant', 'tenant-A'), undefined);
    expect(tokenService.list).toHaveBeenCalledWith('tenant-A');

    await expect(
      controller.list(reqOf('merchant', 'tenant-A'), 'tenant-B'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokenService.list).toHaveBeenCalledTimes(1);
  });

  it('GET 列表（平台）：按 query 过滤，不传=全量', async () => {
    const { controller, tokenService } = createController();

    await controller.list(reqOf('platform'), 'tenant-B');
    expect(tokenService.list).toHaveBeenCalledWith('tenant-B');

    await controller.list(reqOf('platform'), undefined);
    expect(tokenService.list).toHaveBeenLastCalledWith(undefined);
  });

  it('POST 生成（商户自报他人租户）→ 403，不铸造', async () => {
    const { controller, tokenService } = createController();

    await expect(
      controller.create(reqOf('merchant', 'tenant-A'), {
        tenantId: 'tenant-B',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(tokenService.create).not.toHaveBeenCalled();
  });

  it('POST 生成（商户为本租户）→ 放行且以 JWT 租户为准', async () => {
    const { controller, tokenService } = createController();

    await controller.create(reqOf('merchant', 'tenant-A'), {
      tenantId: 'tenant-A',
      name: '对接',
    });

    expect(tokenService.create).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-A' }),
    );
  });

  it('POST 启停（商户）：租户域下发，跨租户 id 落到"不存在"', async () => {
    const { controller, tokenService } = createController();

    await controller.setEnabled(reqOf('merchant', 'tenant-A'), 7, {
      enabled: false,
    });

    expect(tokenService.setEnabledFor).toHaveBeenCalledWith(
      7,
      false,
      'tenant-A',
    );
  });

  it('POST 启停（平台）：不带租户域（全量运维）', async () => {
    const { controller, tokenService } = createController();

    await controller.setEnabled(reqOf('platform'), 7, {
      enabled: true,
    });

    expect(tokenService.setEnabledFor).toHaveBeenCalledWith(7, true, undefined);
  });

  it('DELETE（商户）：租户域下发', async () => {
    const { controller, tokenService } = createController();

    await controller.remove(reqOf('merchant', 'tenant-A'), 7);

    expect(tokenService.removeFor).toHaveBeenCalledWith(7, 'tenant-A');
  });
});
