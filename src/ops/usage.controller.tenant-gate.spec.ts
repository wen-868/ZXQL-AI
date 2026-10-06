/**
 * UsageController 跨租户用量概览门禁测试（阶段0 B-5 返工 2026-10-07）
 *
 * 阻断缺陷 B-5 回归：GET /api/admin/usage/tenants 聚合全部租户的费用与
 * Token 汇总，此前任何商户管理角色（含仓库/财务管理员）都可读。
 * 修复后仅限平台身份；商户身份 → 403。
 */
import { ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { UsageController } from './usage.controller';

function reqOf(
  identityType: 'merchant' | 'platform',
  tenantId?: string,
): Request {
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

function createController(): {
  controller: UsageController;
  usageStats: { listTenantUsage: jest.Mock };
} {
  const usageStats = {
    listTenantUsage: jest.fn().mockResolvedValue([{ tenantId: 't1' }]),
  };
  const controller = Object.create(
    UsageController.prototype,
  ) as UsageController;
  Object.defineProperty(controller, 'usageStats', { value: usageStats });
  return { controller, usageStats };
}

describe('UsageController /tenants 平台门禁（B-5）', () => {
  it('商户管理角色 → 403（跨租户费用/Token 汇总不可读）', async () => {
    const { controller, usageStats } = createController();

    await expect(
      controller.tenants(reqOf('merchant', 'tenant-A')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(usageStats.listTenantUsage).not.toHaveBeenCalled();
  });

  it('平台身份 → 放行并委托查询', async () => {
    const { controller, usageStats } = createController();

    const out = await controller.tenants(
      reqOf('platform'),
      '2026-10-01',
      '2026-10-07',
    );
    expect(out.list).toHaveLength(1);
    expect(usageStats.listTenantUsage).toHaveBeenCalledWith(
      '2026-10-01',
      '2026-10-07',
    );
  });
});
