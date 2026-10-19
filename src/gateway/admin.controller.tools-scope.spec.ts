/**
 * AdminController#listTools —— 工具清单口径的**身份区分**测试（R101-AI-44）
 *
 * 🔴 反测目标（安全语义，不是"能跑就行"）：
 *   `/api/admin/tools` 由 `AdminGuard` 放行**两类**身份：商家管理员 + 平台管理员。
 *   若一律用 `list('platform')` 全量口径 ⇒ **商家管理员能看到总台平台级工具清单**
 *   （如 createPlatformAnnouncement）⇒ 越权信息暴露（"看得到"本身即泄漏）。
 *
 * 定案口径：
 *   - platform 身份 ⇒ 全量（list('platform')）
 *   - merchant / 无身份 ⇒ mgmt 口径（list()，排除 platform 工具）
 *
 * 用 Object.create 构造最小对象（同 admin.controller.tenant-scope.spec.ts 风格）：
 * 只挂 listTools 真正用到的依赖（registry + logger），避免为 12 个构造参数造假。
 */
import type { Request } from 'express';
import { AdminController } from './admin.controller';

/** 按 AdminGuard 的挂载形态构造 req；'none' = 绕过守卫直调（无 adminIdentity） */
function reqOf(identityType: 'merchant' | 'platform' | 'none'): Request {
  if (identityType === 'none') return {} as Request;
  return {
    adminIdentity: {
      identityType,
      tenantId: 't1',
      userId: 1,
      username: 'tester',
    },
  } as unknown as Request;
}

interface Harness {
  controller: AdminController;
  registry: { list: jest.Mock };
}

function createHarness(): Harness {
  const registry = {
    // mgmt 口径返回 81 条、platform 口径返回 83 条（相差即 platform 级工具）
    list: jest.fn((scope?: string) =>
      scope === 'platform'
        ? ['platform_tool_a', 'platform_tool_b']
        : ['mgmt_tool'],
    ),
  };
  const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const controller = Object.create(
    AdminController.prototype,
  ) as AdminController;
  Object.assign(controller, {
    registry,
    logger,
  });
  return { controller, registry };
}

describe('AdminController#listTools（R101-AI-44 身份区分口径）', () => {
  it('① 平台身份 ⇒ 全量口径（list("platform")，含总台工具）', () => {
    const { controller, registry } = createHarness();

    const res = controller.listTools(reqOf('platform'));

    expect(registry.list).toHaveBeenCalledWith('platform');
    expect(res.tools).toEqual(['platform_tool_a', 'platform_tool_b']);
    expect(res.total).toBe(2);
  });

  it('② 🔴 商家管理员 ⇒ mgmt 口径（**不得**看到 platform 工具）', () => {
    const { controller, registry } = createHarness();

    const res = controller.listTools(reqOf('merchant'));

    // 关键：不能传 'platform'
    expect(registry.list).toHaveBeenCalledWith();
    expect(res.tools).toEqual(['mgmt_tool']);
    // 🔴 反测信号：若改成一律 list('platform')，这里会拿到 platform_tool_a ⇒ 红
    expect(res.tools).not.toContain('platform_tool_a');
  });

  it('③ 无身份（绕过守卫直调）⇒ getAdminIdentity 抛 403（不降级放行）', () => {
    const { controller } = createHarness();

    // 依赖既有守卫语义：缺失 adminIdentity ⇒ 403（防绕过守卫直调）
    expect(() => controller.listTools(reqOf('none'))).toThrow();
  });

  it('④ total 必须等于实际返回条数（两套账不得再分裂）', () => {
    const { controller } = createHarness();

    const resPlatform = controller.listTools(reqOf('platform'));
    const resMerchant = controller.listTools(reqOf('merchant'));

    expect(resPlatform.total).toBe(resPlatform.tools.length);
    expect(resMerchant.total).toBe(resMerchant.tools.length);
  });
});
