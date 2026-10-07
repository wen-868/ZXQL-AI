/**
 * AdminController —— 租户隔离端点的多租户隔离测试
 *
 * 背景（2026-10-03 审查发现的 P0）：以下三处均把 tenantId 交给调用方自报
 * （查询参数或路径参数），`AdminGuard` 只校验角色不校验租户归属：
 *   - GET    /api/admin/audit-logs        （读他人审计日志）
 *   - DELETE /api/admin/memory/:tenantId/:sessionId （删他人会话记忆）
 *   - GET    /api/admin/session-archive    （读他人会话归档；且 tenantId 可选，
 *                                           不传时返回**全部租户**归档）
 * 而全项目安全约定（tenant.middleware.ts）明确："tenantId 一律只认 JWT payload"。
 *
 * 阶段2-A1（本次收敛）：三处手写校验统一到 `admin-tenant-scope.ts`，口径改为
 * 读 `req.adminIdentity`（AdminGuard 从 JWT 挂载），不再读 `TenantContext`。
 * 统一后的函数选择（语义归属判断见执行报告）：
 *   - sessionArchive → `resolveOptionalAdminTenantId`（平台未指定 = 查全部，
 *     下游 QueryBuilder 支持跨租户视图）
 *   - clearMemory    → `resolveAdminTenantId`（破坏性写 + tenantId 必填路径参数）
 *   - queryAuditLogs → `resolveAdminTenantId`（下游 queryAuditLogs 恒定
 *     `.where(tenant_id)`，结构上无法查全部）
 *
 * 用Object.create 构造最小对象：只挂被测方法真正用到的依赖，避免为 12 个
 * 构造参数造假。
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Request } from 'express';
import { AdminController } from './admin.controller';

/** 端点查询串（原始 string 形态） */
interface QueryParts {
  startDate?: string;
  endDate?: string;
  intent?: string;
  sessionId?: string;
  page?: string;
  pageSize?: string;
}

interface Harness {
  controller: AdminController;
  auditLogger: { queryAuditLogs: jest.Mock };
  memoryManager: { clearHistory: jest.Mock };
  archiveQb: {
    orderBy: jest.Mock;
    take: jest.Mock;
    andWhere: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  sessionArchiveRepo: { createQueryBuilder: jest.Mock };
  logger: { warn: jest.Mock; log: jest.Mock };
}

/**
 * 构造挂好 adminIdentity 的 req（AdminGuard 的挂载形态）。
 *
 * `none` 模拟**绕过守卫直调**：`req` 上没有 adminIdentity，统一函数应抛 403。
 */
function reqOf(
  identityType: 'merchant' | 'platform' | 'none',
  tenantId?: string,
): Request {
  if (identityType === 'none') {
    return {} as Request;
  }
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

function createHarness(): Harness {
  const auditLogger = {
    queryAuditLogs: jest.fn().mockResolvedValue({ list: [], total: 0 }),
  };
  const memoryManager = {
    clearHistory: jest.fn().mockResolvedValue(undefined),
  };
  const archiveQb = {
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const sessionArchiveRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(archiveQb),
  };
  const controller = Object.create(
    AdminController.prototype,
  ) as AdminController;
  const logger = { warn: jest.fn(), log: jest.fn() };
  Object.assign(controller, {
    auditLogger,
    memoryManager,
    sessionArchiveRepo,
    logger,
  });
  return {
    controller,
    auditLogger: auditLogger,
    memoryManager: memoryManager,
    archiveQb: archiveQb,
    sessionArchiveRepo: sessionArchiveRepo,
    logger: logger,
  };
}

describe('AdminController.queryAuditLogs 多租户隔离（P0 + 阶段2-A1 收敛）', () => {
  const call = (
    h: Harness,
    tenantId: string,
    extra: QueryParts = {},
  ): Promise<{
    list: unknown[];
    total: number;
    page: number;
    pageSize: number;
  }> =>
    h.controller.queryAuditLogs(
      reqOf('merchant', 'tenant-A'),
      tenantId,
      extra.startDate,
      extra.endDate,
      extra.intent,
      extra.sessionId,
      extra.page,
      extra.pageSize,
    );

  it('商户身份：查询自己租户 → 放行，且强制用自己的 tenantId', async () => {
    const h = createHarness();

    const out = await call(h, 'tenant-A');

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-A',
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
    expect(out.total).toBe(0);
  });

  it('商户身份：不传 tenantId 也放行（用 JWT 租户，不静默返回空）', async () => {
    const h = createHarness();

    await call(h, '');

    // 关键回归：原实现 `if (!tenantId) return {total:0}` —— 静默返回空，
    // 表现为"查不到审计"而非报错，掩盖了参数用错
    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-A',
      expect.anything(),
    );
  });

  it('商户身份：自报别的 tenantId → 403 拒绝（越权修复核心）', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 关键反测：拒绝时绝不能已把查询打出去
    expect(h.auditLogger.queryAuditLogs).not.toHaveBeenCalled();
  });

  it('商户身份：自报别的 tenantId → 记warn 审计痕迹', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('越权拦截'),
    );
  });

  it('平台身份：显式指定目标租户 → 放行（保留运维能力）', async () => {
    const h = createHarness();

    await h.controller.queryAuditLogs(
      reqOf('platform'),
      'tenant-B',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-B',
      expect.anything(),
    );
  });

  /**
   * ⚠️ 断言翻转（阶段2-A1，纪律 4.4典型案例）
   *
   * 这条用例**原本断言「回落自己作用域、不报错」**，固化的是 `:573` 一行
   * `tenantId || ctx.tenantId` 的历史宽松兜底——平台未指定目标租户时静默
   * 就近落到 `ctx.tenantId`。
   *
   * 收敛到 `resolveAdminTenantId` 后该兜底被移除：平台跨租户操作**必须显式
   * 指定目标租户**，缺失即 400（`admin-tenant-scope.ts:61-70` 的既定口径，
   * 注释明确"不允许静默退化"）。
   *
   * 为什么必须翻：下游 `AuditLogger.queryAuditLogs` 恒定
   * `.where('log.tenant_id = :tenantId')`，结构上无法查全部租户；继续保留
   * 兜底只会让「未指定目标」静默落到某个租户上查，掩盖调用方参数用错。
   */
  it('平台身份：未指定目标租户 → 400（不再回落就近作用域，断言已翻转）', async () => {
    const h = createHarness();

    await expect(
      h.controller.queryAuditLogs(
        reqOf('platform'),
        '',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // 收紧方向：拒绝时绝不能已把查询打出去
    expect(h.auditLogger.queryAuditLogs).not.toHaveBeenCalled();
  });

  it('绕过守卫直调（req 无 adminIdentity）→ 403，不再是 400', async () => {
    const h = createHarness();

    // 统一函数把"缺身份"判为鉴权问题（403/AI_010）而非参数问题（400/AI_001）：
    // AdminGuard 已在管道最前端拦掉无 token/无效 JWT，能走到这里的只可能是
    // 绕过守卫直调，报"请携带有效 JWT"是误导性的。
    await expect(
      h.controller.queryAuditLogs(
        reqOf('none'),
        'tenant-A',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_010' }) as unknown,
    });
    expect(h.auditLogger.queryAuditLogs).not.toHaveBeenCalled();
  });

  it('分页与过滤参数透传给AuditLogger', async () => {
    const h = createHarness();

    await call(h, 'tenant-A', {
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      intent: 'chat',
      sessionId: 'sess-1',
      page: '3',
      pageSize: '50',
    });

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith('tenant-A', {
      startDate: '2026-10-01',
      endDate: '2026-10-03',
      intent: 'chat',
      sessionId: 'sess-1',
      page: 3,
      pageSize: 50,
    });
  });
});

/**
 * DELETE /api/admin/memory/:tenantId/:sessionId
 *
 * 原实现直接用路径里的 tenantId 调clearHistory ⇒ 商家超管可删任意租户记忆。
 * 记忆是用户资产，这条比"读审计"更严重。
 *
 * 阶段2-A1：统一到 `resolveAdminTenantId`（**必锁**，不用 optional）。
 * tenantId 是必填路径参数，NestJS 在进入方法体前即拒绝缺失路径参数，
 * 因此平台永远显式指定目标租户，不存在"平台未指定"的场景。
 */
describe('AdminController.clearMemory 多租户隔离', () => {
  const call = (h: Harness, tenantId: string, sessionId: string) =>
    h.controller.clearMemory(
      reqOf('merchant', 'tenant-A'),
      tenantId,
      sessionId,
    );

  it('商户身份清自己租户 → 放行', async () => {
    const h = createHarness();

    const out = await call(h, 'tenant-A', 'sess-1');

    expect(out.success).toBe(true);
    expect(h.memoryManager.clearHistory).toHaveBeenCalledWith(
      'tenant-A',
      'sess-1',
      undefined,
    );
  });

  it('商户身份清别人租户 → 403（越权修复核心）', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B', 'sess-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 关键反测：拒绝时绝不能已经把删除打出去
    expect(h.memoryManager.clearHistory).not.toHaveBeenCalled();
  });

  it('商户身份清别人租户 → 记 warn 审计痕迹', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B', 'sess-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('越权拦截'),
    );
  });

  it('平台身份显式指定租户 → 可跨租户清除（保留运维能力）', async () => {
    const h = createHarness();

    await h.controller.clearMemory(
      reqOf('platform'),
      'tenant-B',
      'sess-9',
      undefined,
    );

    expect(h.memoryManager.clearHistory).toHaveBeenCalledWith(
      'tenant-B',
      'sess-9',
      undefined,
    );
  });

  it('绕过守卫直调（req 无 adminIdentity）→ 403，不再是 400', async () => {
    const h = createHarness();

    await expect(
      h.controller.clearMemory(reqOf('none'), 'tenant-A', 'sess-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_010' }) as unknown,
    });
    expect(h.memoryManager.clearHistory).not.toHaveBeenCalled();
  });
});

/**
 * GET /api/admin/session-archive
 *
 * 原实现 tenantId 可选且不校验归属 ⇒① 不传时返回**全部租户**的会话归档
 * （比越权读更糟：一次请求拖走所有租户数据）；② 传了也可读他人租户。
 *
 * 阶段2-A1：统一到 `resolveOptionalAdminTenantId`（**可跨租户运维**）——
 * 下游仅在 scopedTenantId 非空时才追加 where，故平台未指定 = 查全部。
 */
describe('AdminController.sessionArchive 多租户隔离', () => {
  const call = (h: Harness, tenantId?: string, sessionId?: string) =>
    h.controller.sessionArchive(
      reqOf('merchant', 'tenant-A'),
      tenantId,
      sessionId,
      '20',
    );

  it('商户身份不传 tenantId → 仍强制按自己租户过滤（不返回全租户）', async () => {
    const h = createHarness();

    await call(h);

    // 关键回归：原实现 tenantId 缺省时压根不加 where，等于返回全部租户归档
    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-A' },
    );
  });

  it('商户身份传自己租户 → 用自己租户', async () => {
    const h = createHarness();

    await call(h, 'tenant-A');

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-A' },
    );
  });

  it('商户身份传别人租户 → 403（越权修复核心）', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.sessionArchiveRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('商户身份传别人租户 → 记 warn 审计痕迹', async () => {
    const h = createHarness();

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('越权拦截'),
    );
  });

  it('平台身份不指定租户 → 保持跨租户查询（运维场景，本端点语义）', async () => {
    const h = createHarness();

    await h.controller.sessionArchive(
      reqOf('platform'),
      undefined,
      undefined,
      '20',
    );

    // 未指定目标租户时不加租户条件，保留全局运维视图
    expect(h.archiveQb.andWhere).not.toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      expect.anything(),
    );
  });

  it('平台身份指定租户 → 按指定租户过滤', async () => {
    const h = createHarness();

    await h.controller.sessionArchive(
      reqOf('platform'),
      'tenant-B',
      undefined,
      '20',
    );

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-B' },
    );
  });

  it('sessionId 过滤条件仍生效（叠加在租户约束之上）', async () => {
    const h = createHarness();

    await call(h, 'tenant-A', 'sess-7');

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.session_id = :sessionId',
      { sessionId: 'sess-7' },
    );
  });

  it('绕过守卫直调（req 无 adminIdentity）→ 403，不再是 400', async () => {
    const h = createHarness();

    await expect(
      h.controller.sessionArchive(reqOf('none'), undefined, undefined, '20'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_010' }) as unknown,
    });
    expect(h.sessionArchiveRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
