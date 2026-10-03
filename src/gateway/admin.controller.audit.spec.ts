/**
 * AdminController ——审计日志端点的多租户隔离测试
 *
 * 背景（2026-10-03 审查发现的 P0）：`GET /api/admin/audit-logs` 原实现把
 * `tenantId` 完全交给**查询参数自报**，`AdminGuard` 只校验角色不校验租户归属，
 * 导致任一商家超管可传`?tenantId=其他租户` 读取他人审计日志。
 * 而全项目安全约定（tenant.middleware.ts）明确："tenantId 一律只认 JWT payload"。
 *
 * 本spec 只聚焦该端点的租户口径，不追求AdminController 全文件覆盖
 * （该文件千行以上、此前零测试；全量覆盖应单独立项）。
 *
 * 用Object.create 构造最小对象：只挂被测方法真正用到的两个依赖
 *（auditLogger 与 tenantContext），避免为 12 个构造参数造假。
 */
import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';

/** 端点查询串（原始 string形态） */
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
  tenantContext: {
    getData: jest.Mock;
    isPlatform: jest.Mock;
  };
  logger: { warn: jest.Mock };
}

function createHarness(opts: {
  ctxTenantId?: string;
  isPlatform?: boolean;
}): Harness {
  const auditLogger = {
    queryAuditLogs: jest.fn().mockResolvedValue({ list: [], total: 0 }),
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
  Object.assign(controller, {
    auditLogger,
    tenantContext,
    logger: { warn: jest.fn() },
  });
  return {
    controller,
    auditLogger: auditLogger,
    tenantContext: tenantContext,
    logger: { warn: jest.fn() },
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
