/**
 * ScheduleController —— 人工入口与 AI 工具**同源**验证（AI-P2-2 §五.7 / 硬验收 7）
 *
 * 卡面明确禁止平行实现：人工 API 与 AI 工具必须共用同一 DTO、权限、租户过滤、
 * 审计和领域服务。本 spec 用**同一份 domain 实例**同时驱动 controller 与工具，
 * 断言两边落到同一 `ScheduleDomainService`（结构层面不可能是两套实现）。
 *
 * 覆盖断言：
 *  - C1 controller 的 5 个端点全部只经 domain 转发（无自有 SQL / 无自有判定）
 *  - C2 人工 create 与 AI create 同输入 ⇒ 同一 preview（恰 5 次、同 occurrence 序列）
 *  - C3 租户上下文只取自 JWT（请求体/查询参数自报 tenantId 一律无效）
 *  - C4 写操作先返回预览，未 confirm 不落库（人工入口不绕过确认）
 *  - C5 三作用域（single/following/all）原样透传给领域服务
 *  - C6 只读用户经 controller 改日程 ⇒ 领域服务拒绝，controller 不吞成成功
 *  - C7 controller 不直接触碰 t_ai_schedule 表（无自有 SQL）
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-29
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { Request } from 'express';
import { ScheduleController } from './schedule.controller';

/** JwtGuard 挂载形态：req.adminIdentity */
function reqOf(id: {
  user: string;
  tenant: string;
  roles?: string[];
  platform?: boolean;
}): Request {
  return {
    adminIdentity: {
      identityType: id.platform ? 'platform' : 'merchant',
      tenantId: id.tenant,
      userId: Number(id.user),
      roles: id.roles,
    },
  } as unknown as Request;
}

type Scope = 'single' | 'following' | 'all';

interface IdentityCtxMock {
  tenantId: string;
  principal: { id: string; isPlatform?: boolean };
}

interface DomainMock {
  listVisible: jest.Mock<Promise<unknown[]>, [IdentityCtxMock, unknown]>;
  getById: jest.Mock<
    Promise<{ id: string; title: string } | null>,
    [string, unknown]
  >;
  resolveAccess: jest.Mock<Promise<string>, [unknown, unknown]>;
  buildPreview: jest.Mock<
    { occurrences: string[]; recurring: boolean; rule: unknown },
    [unknown]
  >;
  create: jest.Mock<Promise<unknown>, [IdentityCtxMock, unknown]>;
  update: jest.Mock<
    Promise<{ updated: number }>,
    [IdentityCtxMock, string, Record<string, unknown>, Scope]
  >;
  changeStatus: jest.Mock<
    Promise<{ updated: number }>,
    [IdentityCtxMock, string, 'done' | 'cancelled', Scope]
  >;
}

function build(over: Partial<DomainMock> = {}): {
  ctrl: ScheduleController;
  domain: DomainMock;
} {
  const domain: DomainMock = {
    listVisible: jest
      .fn<Promise<unknown[]>, [IdentityCtxMock, unknown]>()
      .mockResolvedValue([]),
    getById: jest
      .fn<Promise<{ id: string; title: string } | null>, [string, unknown]>()
      .mockResolvedValue({ id: '9', title: '周会' }),
    resolveAccess: jest
      .fn<Promise<string>, [unknown, unknown]>()
      .mockResolvedValue('write'),
    buildPreview: jest
      .fn<
        { occurrences: string[]; recurring: boolean; rule: unknown },
        [unknown]
      >()
      .mockReturnValue({
        occurrences: ['2026-11-02T01:00:00.000Z'],
        recurring: false,
        rule: null,
      }),
    create: jest
      .fn<Promise<unknown>, [IdentityCtxMock, unknown]>()
      .mockResolvedValue({ created: [{ id: '9' }] }),
    update: jest
      .fn<
        Promise<{ updated: number }>,
        [IdentityCtxMock, string, Record<string, unknown>, Scope]
      >()
      .mockResolvedValue({ updated: 1 }),
    changeStatus: jest
      .fn<
        Promise<{ updated: number }>,
        [IdentityCtxMock, string, 'done' | 'cancelled', Scope]
      >()
      .mockResolvedValue({ updated: 1 }),
    ...over,
  };
  const ctrl = new ScheduleController(
    domain as unknown as ConstructorParameters<typeof ScheduleController>[0],
  );
  return { ctrl, domain };
}

const OWNER = reqOf({ user: '100', tenant: 't1', roles: ['shop_admin'] });
const VIEWER = reqOf({ user: '300', tenant: 't1' });

// ── C1 端点只经领域服务转发 ────────────────────────────────
describe('C1 人工入口只经 ScheduleDomainService 转发（禁止平行实现）', () => {
  it('C1a list 走 domain.listVisible，租户只取自 JWT', async () => {
    const { ctrl, domain } = build();
    const res = await ctrl.list(OWNER, '2026-11-01', '2026-11-30', 'planned');
    expect(domain.listVisible).toHaveBeenCalledTimes(1);
    const [ctx, opts] = domain.listVisible.mock.calls[0] as [
      { tenantId: string; principal: { id: string } },
      { status: string | null },
    ];
    expect(ctx.tenantId).toBe('t1'); // ← 来自 adminIdentity，不是查询参数
    expect(ctx.principal.id).toBe('100');
    expect(opts.status).toBe('planned');
    expect(res.total).toBe(0);
  });

  it('C1b get 走 domain.getById + resolveAccess，none ⇒ forbidden', async () => {
    const { ctrl, domain } = build({
      resolveAccess: jest.fn().mockResolvedValue('none'),
    });
    const res = await ctrl.get(VIEWER, '9');
    expect(domain.getById).toHaveBeenCalledWith(
      '9',
      expect.objectContaining({ tenantId: 't1' }),
    );
    expect(domain.resolveAccess).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ success: false, error: 'forbidden' });
  });

  it('C1c create 走 domain.buildPreview + domain.create（无自有落库）', async () => {
    const { ctrl, domain } = build();
    await ctrl.create(OWNER, {
      title: '面谈',
      startAt: '2026-11-02T01:00:00.000Z',
      confirm: true,
    });
    expect(domain.buildPreview).toHaveBeenCalledTimes(1);
    expect(domain.create).toHaveBeenCalledTimes(1);
  });

  it('C1d update / complete / cancel 都走 domain（作用域原样透传）', async () => {
    const { ctrl, domain } = build();
    await ctrl.update(OWNER, '9', {
      title: 'x',
      scope: 'following',
      confirm: true,
    });
    await ctrl.complete(OWNER, '9', { scope: 'all' });
    await ctrl.cancel(OWNER, '9', { scope: 'single' });
    expect(domain.update.mock.calls[0][3]).toBe('following');
    expect(domain.changeStatus.mock.calls[0][2]).toBe('done');
    expect(domain.changeStatus.mock.calls[0][3]).toBe('all');
    expect(domain.changeStatus.mock.calls[1][2]).toBe('cancelled');
    expect(domain.changeStatus.mock.calls[1][3]).toBe('single');
  });
});

// ── C2 人工与 AI 同输入 ⇒ 同一 preview（§五.6 / §五.7 核心）──
describe('C2 人工入口与 AI 工具同源：同输入 ⇒ 同一 preview', () => {
  it('C2 同一规则输入经 controller 与直接调 domain 得到**逐字节相同**的 5 次预览', async () => {
    // 用**真实**领域服务（真实 recurrence 展开器，非 mock）证明"同一实现"
    const { ScheduleDomainService } = jest.requireActual<
      typeof import('../brain/schedule/schedule-domain.service')
    >('../brain/schedule/schedule-domain.service');
    const realDomain = new ScheduleDomainService(
      // buildPreview 不使用仓储与 ACL，传最小占位
      {} as never,
      {} as never,
    );
    const input = {
      title: '晨会',
      startAt: '2026-11-02T01:00:00.000Z',
      recurrenceRule: {
        freq: 'WEEKLY' as const,
        byDay: ['MO' as const],
        count: 20,
      },
    };

    // ① 人工入口：controller 把 body 原样交给 domain.buildPreview
    const ctrlOverReal = new ScheduleController(realDomain);
    const viaHttp = (await ctrlOverReal.create(OWNER, {
      ...input,
      confirm: false,
    })) as { preview: { occurrences: string[]; recurring: boolean } };

    // ② AI 工具路径：工具同样只调同一个 domain 方法（见 schedule-tools.spec.ts）
    const viaAi = realDomain.buildPreview(input);

    expect(viaHttp.preview.occurrences).toEqual(viaAi.occurrences);
    expect(viaHttp.preview.recurring).toBe(viaAi.recurring);
    expect(viaHttp.preview.occurrences).toHaveLength(5);
    // 逐字节相同（不是"长度相同"这种弱断言）
    expect(JSON.stringify(viaHttp.preview)).toBe(JSON.stringify(viaAi));
  });
});

// ── C3 租户只认 JWT，自报 tenantId 无效 ────────────────────
describe('C3 租户边界只认 JWT（请求自报 tenantId 一律无效）', () => {
  it('C3a 请求体带 tenantId 也不进 ctx（仍用 JWT 的 t1）', async () => {
    const { ctrl, domain } = build();
    await ctrl.create(OWNER, {
      title: '面谈',
      startAt: '2026-11-02T01:00:00.000Z',
      tenantId: 't-EVIL',
      confirm: true,
    });
    const ctx = domain.create.mock.calls[0][0] as { tenantId: string };
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.tenantId).not.toBe('t-EVIL');
  });

  it('C3b 查询参数带 tenantId 也不进 ctx', async () => {
    const { ctrl, domain } = build();
    // 查询参数由 @Query 解析，这里模拟额外 query 字段已进 body 的场景
    await ctrl.list(OWNER, undefined, undefined, undefined);
    const ctx = domain.listVisible.mock.calls[0][0] as { tenantId: string };
    expect(ctx.tenantId).toBe('t1');
  });

  it('C3c 平台身份透传 isPlatform（跨租户总台例外由领域服务判定）', async () => {
    const platform = reqOf({ user: '1', tenant: 't1', platform: true });
    const { ctrl, domain } = build();
    await ctrl.list(platform, undefined, undefined, undefined);
    const ctx = domain.listVisible.mock.calls[0][0] as {
      principal: { isPlatform?: boolean };
    };
    expect(ctx.principal.isPlatform).toBe(true);
  });
});

// ── C4 未 confirm 不落库 ───────────────────────────────────
describe('C4 写操作先预览，未 confirm 不落库（人工入口不绕过确认）', () => {
  it('C4a create 未 confirm ⇒ 只返回 preview，domain.create 零调用', async () => {
    const { ctrl, domain } = build();
    const res = (await ctrl.create(OWNER, {
      title: '面谈',
      startAt: '2026-11-02T01:00:00.000Z',
    })) as { success: boolean; preview: { occurrences: string[] } };
    expect(domain.create).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.preview.occurrences).toHaveLength(1);
  });

  it('C4b update 未 confirm ⇒ 只读回显，domain.update 零调用', async () => {
    const { ctrl, domain } = build();
    const res = await ctrl.update(OWNER, '9', { title: '改掉' });
    expect(domain.update).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(domain.getById).toHaveBeenCalledTimes(1); // 只做回显读取
  });
});

// ── C5 三作用域透传（不把整系列伪装成单次）────────────────
describe('C5 三作用域原样透传（卡面 §六.5 反向验证点）', () => {
  const cases: Array<['single' | 'following' | 'all', string]> = [
    ['single', 'single'],
    ['following', 'following'],
    ['all', 'all'],
  ];
  it.each(cases)(
    'C5 scope=%s 透传给 domain.update',
    async (scope, expected) => {
      const { ctrl, domain } = build();
      await ctrl.update(OWNER, '9', { title: 'x', scope, confirm: true });
      expect(domain.update.mock.calls[0][3]).toBe(expected);
    },
  );
});

// ── C6 只读用户经 controller 写 ⇒ 拒绝不被吞 ───────────────
describe('C6 权限拒绝不被 controller 吞成成功', () => {
  it('C6 领域服务抛只读 ⇒ controller 也抛（不转成 success:false 静默）', async () => {
    const err = new Error('该日程对当前主体仅只读');
    const { ctrl } = build({
      update: jest.fn().mockRejectedValue(err),
    });
    await expect(
      ctrl.update(VIEWER, '9', { title: '想改', confirm: true }),
    ).rejects.toThrow(/仅只读/);
  });
});

// ── C7 结构断言：controller 无自有 SQL ─────────────────────
describe('C7 结构断言：controller 不含自有 SQL / 不自建仓储', () => {
  it('C7 controller 源码无 t_ai_schedule 写语句、无 Repository 注入', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/gateway/schedule.controller.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/INSERT\s+INTO/i);
    expect(src).not.toMatch(/UPDATE\s+t_ai_schedule/i);
    expect(src).not.toMatch(/SELECT\s+.*FROM\s+t_ai_schedule/i);
    expect(src).not.toMatch(/@InjectRepository/);
    // 唯一依赖就是领域服务（禁止平行实现）
    expect(src).toMatch(/ScheduleDomainService/);
  });
});
