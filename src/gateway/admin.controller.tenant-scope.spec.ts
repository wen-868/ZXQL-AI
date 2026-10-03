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
 * 本 spec 只聚焦这三个端点的租户口径，不追求 AdminController 全文件覆盖
 * （该文件千行以上、此前零测试；全量覆盖应单独立项）。
 *
 * 用 Object.create 构造最小对象：只挂被测方法真正用到的依赖，避免为 12 个
 * 构造参数造假。
 */
import { ForbiddenException } from '@nestjs/common';
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
  tenantContext: {
    getData: jest.Mock;
    isPlatform: jest.Mock;
  };
  logger: { warn: jest.Mock; log: jest.Mock };
}

function createHarness(opts: {
  ctxTenantId?: string;
  isPlatform?: boolean;
}): Harness {
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
  const tenantContext = {
    getData: jest
      .fn()
      .mockReturnValue(
        opts.ctxTenantId === undefined
          ? undefined
          : { tenantId: opts.ctxTenantId },
      ),
    isPlatform: jest.fn().mockReturnValue(opts.isPlatform ?? false),
  };
  const controller = Object.create(
    AdminController.prototype,
  ) as AdminController;
  const logger = { warn: jest.fn(), log: jest.fn() };
  Object.assign(controller, {
    auditLogger,
    tenantContext,
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
    tenantContext: tenantContext,
    logger: logger,
  };
}

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
    tenantId,
    extra.startDate,
    extra.endDate,
    extra.intent,
    extra.sessionId,
    extra.page,
    extra.pageSize,
  );

describe('AdminController.queryAuditLogs 多租户隔离（P0）', () => {
  it('商家身份：查询自己租户 → 放行，且强制用自己的 tenantId', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    const out = await call(h, 'tenant-A');

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-A',
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
    expect(out.total).toBe(0);
  });

  it('商家身份：不传 tenantId 也放行（不再返回空列表）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await call(h, '');

    // 关键回归：原实现 `if (!tenantId) return {total:0}` —— 静默返回空，
    // 表现为"查不到审计"而非报错，掩盖了参数用错
    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-A',
      expect.anything(),
    );
  });

  it('商家身份：自报别的 tenantId → 403 拒绝（越权修复核心）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 关键反测：拒绝时绝不能已把查询打出去
    expect(h.auditLogger.queryAuditLogs).not.toHaveBeenCalled();
  });

  it('商家身份：自报别的 tenantId → 记warn 审计痕迹', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });
    const warnSpy = jest.fn();
    (h.controller as unknown as { logger: { warn: unknown } }).logger = {
      warn: warnSpy,
    };

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('越权拦截'));
  });

  it('平台身份：可跨租户查询（保留运维能力）', async () => {
    const h = createHarness({
      ctxTenantId: 'platform-scope',
      isPlatform: true,
    });

    await call(h, 'tenant-B');

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'tenant-B',
      expect.anything(),
    );
  });

  it('平台身份：未指定目标租户 → 回落自己作用域，不报错', async () => {
    const h = createHarness({
      ctxTenantId: 'platform-scope',
      isPlatform: true,
    });

    await call(h, '');

    expect(h.auditLogger.queryAuditLogs).toHaveBeenCalledWith(
      'platform-scope',
      expect.anything(),
    );
  });

  it('无租户上下文（缺 JWT） → 400 拒绝，不静默返回空', async () => {
    const h = createHarness({ ctxTenantId: undefined });

    // Nest 异常的message 是对象（响应体），正则匹配不到，改断言错误码
    await expect(call(h, 'tenant-A')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_001' }) as unknown,
    });
    expect(h.auditLogger.queryAuditLogs).not.toHaveBeenCalled();
  });

  it('分页与过滤参数透传给AuditLogger', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

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
 */
describe('AdminController.clearMemory 多租户隔离', () => {
  const call = (h: Harness, tenantId: string, sessionId: string) =>
    h.controller.clearMemory(tenantId, sessionId);

  it('商家身份清自己租户 → 放行', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    const out = await call(h, 'tenant-A', 'sess-1');

    expect(out.success).toBe(true);
    expect(h.memoryManager.clearHistory).toHaveBeenCalledWith(
      'tenant-A',
      'sess-1',
    );
  });

  it('商家身份清别人租户 → 403（越权修复核心）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await expect(call(h, 'tenant-B', 'sess-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // 关键反测：拒绝时绝不能已经把删除打出去
    expect(h.memoryManager.clearHistory).not.toHaveBeenCalled();
  });

  it('商家身份清别人租户 → 记 warn 审计痕迹', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await expect(call(h, 'tenant-B', 'sess-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('越权拦截'),
    );
  });

  it('平台身份可跨租户清除（保留运维能力）', async () => {
    const h = createHarness({
      ctxTenantId: 'platform-scope',
      isPlatform: true,
    });

    await call(h, 'tenant-B', 'sess-9');

    expect(h.memoryManager.clearHistory).toHaveBeenCalledWith(
      'tenant-B',
      'sess-9',
    );
  });

  it('无租户上下文 → 400 拒绝，不执行删除', async () => {
    const h = createHarness({ ctxTenantId: undefined });

    await expect(call(h, 'tenant-A', 'sess-1')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_001' }) as unknown,
    });
    expect(h.memoryManager.clearHistory).not.toHaveBeenCalled();
  });
});

/**
 * GET /api/admin/session-archive
 *
 * 原实现 tenantId 可选且不校验归属 ⇒① 不传时返回**全部租户**的会话归档
 * （比越权读更糟：一次请求拖走所有租户数据）；② 传了也可读他人租户。
 */
describe('AdminController.sessionArchive 多租户隔离', () => {
  const call = (h: Harness, tenantId?: string, sessionId?: string) =>
    h.controller.sessionArchive(tenantId, sessionId, '20');

  it('商家身份不传 tenantId → 仍强制按自己租户过滤（不返回全租户）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await call(h);

    // 关键回归：原实现 tenantId 缺省时压根不加 where，等于返回全部租户归档
    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-A' },
    );
  });

  it('商家身份传自己租户 → 用自己租户', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await call(h, 'tenant-A');

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-A' },
    );
  });

  it('商家身份传别人租户 → 403（越权修复核心）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await expect(call(h, 'tenant-B')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.sessionArchiveRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('平台身份不指定租户 → 保持跨租户查询（运维场景）', async () => {
    const h = createHarness({
      ctxTenantId: 'platform-scope',
      isPlatform: true,
    });

    await call(h);

    // 未指定目标租户时不加租户条件，保留全局运维视图
    expect(h.archiveQb.andWhere).not.toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      expect.anything(),
    );
  });

  it('平台身份指定租户 → 按指定租户过滤', async () => {
    const h = createHarness({
      ctxTenantId: 'platform-scope',
      isPlatform: true,
    });

    await call(h, 'tenant-B');

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.tenant_id = :scopedTenantId',
      { scopedTenantId: 'tenant-B' },
    );
  });

  it('sessionId 过滤条件仍生效（叠加在租户约束之上）', async () => {
    const h = createHarness({ ctxTenantId: 'tenant-A' });

    await call(h, 'tenant-A', 'sess-7');

    expect(h.archiveQb.andWhere).toHaveBeenCalledWith(
      'a.session_id = :sessionId',
      { sessionId: 'sess-7' },
    );
  });

  it('无租户上下文 → 400 拒绝', async () => {
    const h = createHarness({ ctxTenantId: undefined });

    await expect(call(h)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_001' }) as unknown,
    });
    expect(h.sessionArchiveRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
