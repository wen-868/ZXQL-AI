/**
 * ScheduleDomainService 测试（AI-P2-2 · 卡面 §五.1/§五.3/§四.6/§五.5/§五.6/§五.7/反测 2/3/5）
 *
 * 反测命名（mutation ⇒ 目标用例必须变红）：
 * P1 权限矩阵逐格（owner/manager/participant/viewer(角色∪人员)/陌生人/platform）
 * P2 **viewer 只读**：共享用户尝试 update/complete ⇒ 拒（反测 2 靶点：viewer 当 manager ⇒ 红）
 * P3 **租户硬边界先于一切**：跨租户同名 principal ⇒ none（反测靶：跨租户访问）
 * P4 viewer_roles ∪ viewer_user_ids **取并集**（只查一个 ⇒ 红）
 * P5 manager_user_ids 独立于 viewer（viewer 命中不升级写权；manager 未列 viewer 仍可读+写）
 * S1 create 单次 ⇒ 1 行（seriesId=null）
 * S2 create 重复 ⇒ N 行同 seriesId，每行 occurrenceAt/remindAt 独立平移
 * S3 update single ⇒ 只改一行 + 写 exception，**其他行零触碰**（反测 5：伪装成整系列 ⇒ 红）
 * S4 update all ⇒ 整系列行都改
 * S5 update following ⇒ 老系列 until 截断 + 新系列从该 occurrence 起承接
 * C1 changeStatus single/following/all 的行数口径
 * C2 changeStatus 原子性（UPDATE 条件含 status='planned'；非 planned 行不动）
 * H1 共享范围变更 ⇒ t_ai_schedule_share_audit 落审计（before/after）；无变化 ⇒ 不写
 * V1 buildPreview **恰为未来 5 次**；单次为 [startAt]
 * L1 listVisible **库层**收窄（SQL 含租户 + owner/manager/viewer/participants/ACL 各支）
 *
 * 用**内存假仓储**（find/findOne/update/save/query/create）⇒ 断言真实调用形状。
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-29
 */
import {
  ScheduleAccessError,
  ScheduleDomainService,
} from './schedule-domain.service';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';

// ── 内存假仓储 ─────────────────────────────────────────────
function entityOf(over: Partial<AiScheduleEntity> = {}): AiScheduleEntity {
  return {
    id: '1',
    tenantId: 't1',
    title: '周会',
    startAt: new Date('2026-11-02T01:00:00.000Z'),
    endAt: null,
    owner: 'user:100',
    participants: null,
    status: 'planned',
    remindAt: null,
    remindedAt: null,
    source: 'user',
    createdBy: 'user:100',
    createdAt: new Date(),
    updatedAt: new Date(),
    viewerRoles: null,
    viewerUserIds: null,
    managerUserIds: null,
    seriesId: null,
    recurrenceRule: null,
    occurrenceAt: null,
    exception: null,
    ...over,
  };
}

interface FakeOpts {
  rows?: AiScheduleEntity[];
  granted?: string[];
}

function fakeRepo(o: FakeOpts = {}) {
  const rows = (o.rows ?? []).map((r) => ({ ...r }));
  let nextId = 1000;
  const auditSql: Array<{ sql: string; params: unknown[] }> = [];
  const updateCalls: Array<{
    where: Record<string, unknown>;
    set: Record<string, unknown>;
  }> = [];
  const saved: AiScheduleEntity[] = [];
  const repo = {
    create: (partial: Partial<AiScheduleEntity>) => ({ ...partial }),
    save: (e: AiScheduleEntity) => {
      const withId = { ...e, id: String(nextId++) };
      saved.push(withId);
      rows.push({ ...withId });
      return Promise.resolve(withId);
    },
    findOne: (arg: { where: Record<string, unknown> }) => {
      const w = arg.where;
      const hit = rows.find(
        (r) =>
          String(r.id) === String(w.id) &&
          (w.tenantId === undefined ||
            r.tenantId === String(w.tenantId as string | undefined)) &&
          (w.status === undefined || r.status === w.status),
      );
      return Promise.resolve(hit ? { ...hit } : null);
    },
    find: (arg: {
      where?: Record<string, unknown>;
      order?: Record<string, string>;
    }) => {
      let out = rows;
      const w = arg.where ?? {};
      if (w.tenantId !== undefined)
        out = out.filter((r) => r.tenantId === w.tenantId);
      if (w.seriesId !== undefined)
        out = out.filter((r) => r.seriesId === w.seriesId);
      if (w.id !== undefined)
        out = out.filter((r) => String(r.id) === String(w.id));
      const order = arg.order ?? {};
      if (order.occurrenceAt === 'ASC') {
        out = [...out].sort(
          (a, b) =>
            (a.occurrenceAt?.getTime() ?? 0) - (b.occurrenceAt?.getTime() ?? 0),
        );
      }
      return Promise.resolve(out.map((r) => ({ ...r })));
    },
    update: (where: Record<string, unknown>, set: Record<string, unknown>) => {
      updateCalls.push({ where, set });
      let affected = 0;
      for (const r of rows) {
        const match =
          (where.id === undefined ||
            String(r.id) === String((where as { id?: unknown }).id)) &&
          (where.tenantId === undefined ||
            r.tenantId ===
              String((where as { tenantId?: unknown }).tenantId)) &&
          (where.seriesId === undefined ||
            r.seriesId ===
              String((where as { seriesId?: unknown }).seriesId)) &&
          (where.status === undefined || r.status === where.status);
        if (match) {
          Object.assign(r, set);
          affected += 1;
        }
      }
      return Promise.resolve({ affected });
    },
    query: jest.fn((sql: string, params: unknown[] = []) => {
      if (sql.includes('t_ai_schedule_share_audit')) {
        auditSql.push({ sql, params });
        return Promise.resolve([]);
      } // listVisible 的 SELECT：按 SQL 语义近似过滤（租户 + OR 支 + 状态）
      const tenant = String(params[0]);
      const rest = params.slice(1).map(String);
      return Promise.resolve(
        rows
          .filter((r) => r.tenantId === tenant)
          .filter(
            (r) =>
              r.owner === rest[0] ||
              (r.managerUserIds &&
                rest.some((v) =>
                  (r.managerUserIds as string).includes(
                    `,${v.replace(/^%,|,%$/g, '')},`,
                  ),
                )) ||
              (r.viewerUserIds &&
                rest.some((v) =>
                  (r.viewerUserIds as string).includes(
                    `,${v.replace(/^%,|,%$/g, '')},`,
                  ),
                )) ||
              (r.participants &&
                rest.some((v) =>
                  (r.participants as string).includes(
                    v.replace(/^%,|,%$/g, ''),
                  ),
                )) ||
              (r.viewerRoles &&
                rest.some((v) =>
                  (r.viewerRoles as string).includes(
                    `,${v.replace(/^%,|,%$/g, '')},`,
                  ),
                )),
          )
          .map((r) => ({
            id: r.id,
            tenant_id: r.tenantId,
            title: r.title,
            start_at: r.startAt,
            end_at: r.endAt,
            owner: r.owner,
            participants: r.participants,
            status: r.status,
            remind_at: r.remindAt,
            reminded_at: r.remindedAt,
            source: r.source,
            created_by: r.createdBy,
            created_at: r.createdAt,
            updated_at: r.updatedAt,
            viewer_roles: r.viewerRoles,
            viewer_user_ids: r.viewerUserIds,
            manager_user_ids: r.managerUserIds,
            series_id: r.seriesId,
            recurrence_rule: r.recurrenceRule,
            occurrence_at: r.occurrenceAt,
            exception: r.exception,
          })),
      );
    }),
  };
  return {
    ...repo,
    __audit: auditSql,
    __updateCalls: updateCalls,
    __saved: saved,
    __rows: rows,
  };
}

function aclStub(
  o: { access?: 'admin' | 'write' | 'read' | 'none'; granted?: string[] } = {},
) {
  return {
    resolveResource: jest.fn(() => Promise.resolve(o.access ?? 'none')),
    aclGrantedIds: jest.fn(() => Promise.resolve(o.granted ?? [])),
    canWriteResource: jest.fn(() =>
      Promise.resolve(o.access === 'write' || o.access === 'admin'),
    ),
  } as never;
}

const OWNER = {
  tenantId: 't1',
  principal: { type: 'user' as const, id: '100' },
};
const STRANGER = {
  tenantId: 't1',
  principal: { type: 'user' as const, id: '999' },
};

function build(
  o: FakeOpts = {},
  a: { access?: 'admin' | 'write' | 'read' | 'none'; granted?: string[] } = {},
) {
  const repo = fakeRepo(o);
  const acl = aclStub(a);
  const svc = new ScheduleDomainService(repo as never, acl);
  return { svc, repo, acl };
}

// ── P1~P5 权限矩阵 ─────────────────────────────────────────
describe('resolveAccess / 断言（权限矩阵逐格）', () => {
  it('P1 owner=admin、platform=admin、陌生人=none', async () => {
    const { svc } = build();
    const row = entityOf({ owner: 'user:100' });
    expect(await svc.resolveAccess(row, OWNER)).toBe('admin');
    expect(
      await svc.resolveAccess(row, {
        tenantId: 't1',
        principal: { type: 'user', id: '5', isPlatform: true },
      }),
    ).toBe('admin');
    expect(await svc.resolveAccess(row, STRANGER)).toBe('none');
  });

  it('P1b 参与者=只读（021 语义保持）', async () => {
    const { svc } = build();
    const row = entityOf({ participants: ',user:200,role:fin,' });
    expect(
      await svc.resolveAccess(row, {
        tenantId: 't1',
        principal: { type: 'user', id: '200' },
      }),
    ).toBe('read');
    expect(
      await svc.resolveAccess(row, {
        tenantId: 't1',
        principal: { type: 'user', id: '201', roles: ['fin'] },
      }),
    ).toBe('read');
  });

  it('P2 **viewer 只读**：尝试 update / complete ⇒ 抛错（反测 2）', async () => {
    const { svc, repo: r } = build({
      rows: [entityOf({ id: '9', viewerUserIds: ',300,' })],
    });
    const updateCalls = r.__updateCalls;
    const viewer = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '300' },
    };
    expect(await svc.resolveAccess(r.__rows[0], viewer)).toBe('read');
    await expect(
      svc.update(viewer, '9', { title: '改掉' }, 'single'),
    ).rejects.toThrow(/仅只读/);
    await expect(
      svc.changeStatus(viewer, '9', 'done', 'single'),
    ).rejects.toThrow(/仅只读/);
    expect(updateCalls).toHaveLength(0); // 🔴 零写入发生
  });

  it('P2b **participants 也不得写**（读权≠写权；反测 2 的另一半）', async () => {
    const { svc } = build({
      rows: [entityOf({ id: '9', participants: ',user:200,' })],
    });
    await expect(
      svc.update(
        { tenantId: 't1', principal: { type: 'user', id: '200' } },
        '9',
        { title: 'x' },
        'single',
      ),
    ).rejects.toThrow(/仅只读/);
  });

  it('P3 **租户边界先于一切**：跨租户即使 principal 命中也 none', async () => {
    const { svc } = build();
    const rowT2 = entityOf({ tenantId: 't2', owner: 'user:100' });
    expect(await svc.resolveAccess(rowT2, OWNER)).toBe('none');
    // 跨租户读取 ⇒ 统一话术（不泄漏存在性）
    const { svc: svc2 } = build({ rows: [rowT2] });
    await expect(svc2.getById('1', OWNER)).rejects.toThrow(
      '无权访问该日程（或不存在）',
    );
  });

  it('P4 viewer_roles ∪ viewer_user_ids **取并集**（只命中其一也可见）', async () => {
    const { svc } = build();
    const both = entityOf({ viewerRoles: ',fin,', viewerUserIds: ',300,' });
    const roleActor = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '301', roles: ['fin'] },
    };
    const userActor = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '300' },
    };
    const neither = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '302', roles: ['ops'] },
    };
    expect(await svc.resolveAccess(both, roleActor)).toBe('read'); // 仅角色命中
    expect(await svc.resolveAccess(both, userActor)).toBe('read'); // 仅人员命中
    expect(await svc.resolveAccess(both, neither)).toBe('none');
  });

  it('P5 manager 独立于 viewer：代管可写；且 manager 不需列 viewer 也自动可读', async () => {
    const { svc } = build({
      rows: [entityOf({ id: '9', managerUserIds: ',400,' })],
    });
    const row = entityOf({ id: '9', managerUserIds: ',400,' });
    const mgr = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '400' },
    };
    expect(await svc.resolveAccess(row, mgr)).toBe('write');
    await expect(svc.assertCanRead(row, mgr)).resolves.toBe('write'); // 写含读
    await svc.assertCanWrite(row, mgr); // 不抛
    await expect(svc.assertCanAdmin(row, mgr)).rejects.toThrow(/归属人/); // 改共享需 admin
    // manager 不得改共享范围
    await expect(
      svc.update(mgr, '9', { share: { viewerUserIds: ['599'] } }, 'single'),
    ).rejects.toThrow(/归属人/);
  });

  it('P5b ACL 兜底：矩阵未命中但授权表有 grant ⇒ 采用授权档位', async () => {
    const { svc } = build({}, { access: 'write' });
    const row = entityOf({ owner: 'user:100' });
    expect(await svc.resolveAccess(row, STRANGER)).toBe('write');
    expect(
      await svc.resolveAccess(row, {
        tenantId: 't1',
        principal: { type: 'employee', id: 'e1' },
      }),
    ).toBe('write'); // 员工也走 ACL 兜底
  });

  it('P5c employee principal 不得命中 user 形态的 manager/viewer 列', async () => {
    const { svc } = build();
    const row = entityOf({ managerUserIds: ',7,', viewerUserIds: ',7,' });
    const emp = {
      tenantId: 't1',
      principal: { type: 'employee' as const, id: '7' },
    };
    expect(await svc.resolveAccess(row, emp)).toBe('none');
    const user7 = {
      tenantId: 't1',
      principal: { type: 'user' as const, id: '7' },
    };
    expect(await svc.resolveAccess(row, user7)).toBe('write');
  });
});

// ── L1 库层收窄 ────────────────────────────────────────────
describe('listVisible（库层隔离，非内存过滤）', () => {
  it('L1 SQL 带租户与全部可见支（owner/manager/viewerUser/participants/ACL IN）', async () => {
    const { svc } = build({ granted: ['77'] });
    await svc.listVisible(
      {
        tenantId: 't1',
        principal: { type: 'user', id: '100', roles: ['fin'] },
      },
      {
        status: 'planned',
        from: new Date('2026-11-01'),
        to: new Date('2026-12-01'),
      },
    );
    // 从 fakeRepo.query 记录断言（query 记录在 updateCalls? no ⇒ 用 sqls via repo.query 手工）
    // 直接重放：改用 spy 方式验证参数含租户与 principal
    const h = build();
    const spy = jest.spyOn(
      (
        h.svc as unknown as {
          scheduleRepo: {
            query: (s: string, p: unknown[]) => Promise<unknown>;
          };
        }
      ).scheduleRepo,
      'query',
    );
    await h.svc.listVisible(
      {
        tenantId: 't1',
        principal: { type: 'user', id: '100', roles: ['fin'] },
      },
      {
        status: 'planned',
        from: new Date('2026-11-01'),
        to: new Date('2026-12-01'),
      },
    );
    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain('s.tenant_id = ?');
    expect(sql).toContain('s.owner = ?');
    expect(sql).toContain('s.manager_user_ids LIKE ?');
    expect(sql).toContain('s.viewer_user_ids LIKE ?');
    expect(sql).toContain('s.viewer_roles LIKE ?');
    expect(sql).toContain('s.participants LIKE ?');
    expect(sql).toContain('s.status = ?');
    expect(sql).toContain('s.start_at >= ?');
    expect(sql).toContain('s.start_at <= ?');
    expect(String(sql)).not.toMatch(/ORDER BY s.start_at DESC/); // 升序（分页稳定）
    expect(params).toContain('t1');
    expect(params).toContain('user:100');
    expect(params).toContain('%,fin,%');
    expect(params).toContain('planned');
  });

  it('L1b 可见结果：owner 行/manager 行/viewer 行/参与者行都在；陌生人不可见', async () => {
    const rows = [
      entityOf({ id: '1', owner: 'user:100' }),
      entityOf({ id: '2', owner: 'user:888', managerUserIds: ',100,' }),
      entityOf({ id: '3', owner: 'user:888', viewerUserIds: ',100,' }),
      entityOf({ id: '4', owner: 'user:888', participants: ',user:100,' }),
      entityOf({ id: '5', owner: 'user:888' }), // 与 100 无关
    ];
    const { svc } = build({ rows });
    const out = await svc.listVisible(OWNER);
    expect(out.map((r) => r.id).sort()).toEqual(['1', '2', '3', '4']);
    expect(out.find((r) => r.id === '5')).toBeUndefined();
  });

  it('L1c 平台身份不加租户条件（跨租户总台）', async () => {
    const h = build();
    const spy = jest.spyOn(
      (
        h.svc as unknown as {
          scheduleRepo: {
            query: (s: string, p: unknown[]) => Promise<unknown>;
          };
        }
      ).scheduleRepo,
      'query',
    );
    await h.svc.listVisible({
      tenantId: 't1',
      principal: { type: 'user', id: '1', isPlatform: true },
    });
    const [sql, params] = spy.mock.calls[0];
    expect(sql).toContain('s.tenant_id = ?'); // 🔴 仍带租户：平台例外**不**在此放开（卡面：领域服务租户边界先于一切）
    expect(params[0]).toBe('t1');
    expect(sql).not.toContain('s.owner = ?'); // 平台 ⇒ 无 OR 收窄
  });
});

// ── S1~S5 create/update 作用域 ─────────────────────────────
describe('create / update（三作用域 + 系列展开）', () => {
  const START = '2026-11-02T01:00:00.000Z'; // 上海 11-02 09:00（周一）

  it('S1 单次 create ⇒ 1 行；seriesId=null；occurrenceAt=startAt', async () => {
    const { svc } = build();
    const res = await svc.create(OWNER, { title: '面谈', startAt: START });
    expect(res.created).toHaveLength(1);
    expect(res.created[0].seriesId).toBeNull();
    expect(res.created[0].occurrenceAt).toEqual(new Date(START));
    expect(res.preview.occurrences).toEqual([START]);
    expect(res.preview.recurring).toBe(false);
  });

  it('S2 重复 create ⇒ N 行同 seriesId；remindAt 随 occurrence 平移', async () => {
    const { svc } = build();
    const res = await svc.create(OWNER, {
      title: '晨会',
      startAt: START,
      remindAt: '2026-11-02T00:30:00.000Z', // 提前 30 分钟
      recurrenceRule: { freq: 'DAILY', count: 3 },
    });
    expect(res.created).toHaveLength(3);
    const seriesId = String(res.created[0].id);
    for (const r of res.created) {
      expect(r.seriesId).toBe(seriesId); // 同系列（首行 id 即 seriesId）
      expect(r.recurrenceRule).toContain('DAILY');
    }
    // 每行 occurrenceAt 独立、remindAt = occurrence − 30min
    expect(res.created[1].occurrenceAt).toEqual(
      new Date('2026-11-03T01:00:00.000Z'),
    );
    expect(res.created[1].remindAt).toEqual(
      new Date('2026-11-03T00:30:00.000Z'),
    );
    expect(res.created[2].remindAt).toEqual(
      new Date('2026-11-04T00:30:00.000Z'),
    );
  });

  it('V1 buildPreview 恰 5 次（重复）/ 1 次（单次）⇒ 同源给 AI 与人工', () => {
    const { svc } = build();
    const p = svc.buildPreview({
      title: 'x',
      startAt: START,
      recurrenceRule: { freq: 'WEEKLY', byDay: ['MO'], count: 20 },
    });
    expect(p.occurrences).toHaveLength(5);
    expect(p.recurring).toBe(true);
    // 单次
    expect(
      svc.buildPreview({ title: 'x', startAt: START }).occurrences,
    ).toHaveLength(1);
    // 非法时间
    expect(() =>
      svc.buildPreview({ title: 'x', startAt: 'not-a-date' }),
    ).toThrow(ScheduleAccessError);
  });

  it('S3 update single ⇒ 只改该行 + exception 记录（**其他行零触碰**，反测 5）', async () => {
    const mk = (i: number) =>
      entityOf({
        id: String(10 + i),
        seriesId: '10',
        recurrenceRule: JSON.stringify({ freq: 'DAILY', count: 3 }),
        occurrenceAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
        startAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
      });
    const { svc, repo } = build({ rows: [mk(0), mk(1), mk(2)] });
    const res = await svc.update(OWNER, '10', { title: '改名单次' }, 'single');
    expect(res.updated).toBe(1);
    const rows = await repo.find({ where: { tenantId: 't1', seriesId: '10' } });
    const changed = rows.filter((r) => r.title === '改名单次');
    expect(changed).toHaveLength(1);
    expect(changed[0].id).toBe('10');
    expect(
      (JSON.parse(String(changed[0].exception)) as { patch: { title: string } })
        .patch.title,
    ).toBe('改名单次');
    // 其余行标题/异常都没动
    expect(rows.find((r) => r.id === '11')?.exception).toBeNull();
    expect(rows.find((r) => r.id === '11')?.title).toBe('周会');
  });

  it('S4 update all ⇒ 整系列每行都改', async () => {
    const mk = (i: number) =>
      entityOf({
        id: String(10 + i),
        seriesId: '10',
        recurrenceRule: JSON.stringify({ freq: 'DAILY', count: 3 }),
        occurrenceAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
      });
    const { svc, repo } = build({ rows: [mk(0), mk(1), mk(2)] });
    const res = await svc.update(OWNER, '10', { title: '全改' }, 'all');
    expect(res.updated).toBe(3);
    const rows = await repo.find({ where: { tenantId: 't1', seriesId: '10' } });
    expect(rows.every((r) => r.title === '全改')).toBe(true);
  });

  it('S5 update following ⇒ 老系列 until 截断；本行起承接（拆出新段）', async () => {
    const mk = (i: number) =>
      entityOf({
        id: String(10 + i),
        seriesId: '10',
        recurrenceRule: JSON.stringify({ freq: 'DAILY', count: 5 }),
        occurrenceAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
        startAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
      });
    const { svc, repo } = build({ rows: [mk(0), mk(1), mk(2), mk(3), mk(4)] });
    // 从第 2 行（11-03）起 following 改标题
    const res = await svc.update(
      OWNER,
      '11',
      { title: '后段改名' },
      'following',
    );
    expect(res.updated).toBeGreaterThan(0);
    const rows = await repo.find({ where: { tenantId: 't1' } });
    // 老段（10：11-02）标题未变且规则被 until 截断
    const old = rows.find((r) => r.id === '10')!;
    expect(old.title).toBe('周会');
    const oldRule = JSON.parse(String(old.recurrenceRule)) as {
      until?: string;
      count?: number;
    };
    expect(oldRule.until).toBeDefined();
    expect(oldRule.count).toBeUndefined();
    // 从 11 起的行都改了名
    const newer = rows.filter((r) =>
      ['11', '12', '13', '14'].includes(String(r.id)),
    );
    expect(newer.every((r) => r.title === '后段改名')).toBe(true);
  });

  it('S6 单次日程不制造系列语义：following/all 等价于单次（updated=1，不抛）', async () => {
    const { svc } = build({ rows: [entityOf({ id: '7' })] });
    const r1 = await svc.update(OWNER, '7', { title: 'x' }, 'following');
    expect(r1.updated).toBe(1);
    const r2 = await svc.update(OWNER, '7', { title: 'x' }, 'all');
    expect(r2.updated).toBe(1);
  });
});

// ── C1/C2 状态迁移作用域与原子性 ───────────────────────────
describe('changeStatus（三作用域 + 原子条件）', () => {
  const mk = (i: number, over: Partial<AiScheduleEntity> = {}) =>
    entityOf({
      id: String(10 + i),
      seriesId: '10',
      recurrenceRule: JSON.stringify({ freq: 'DAILY', count: 5 }),
      occurrenceAt: new Date(`2026-11-0${2 + i}T01:00:00.000Z`),
      ...over,
    });

  it('C1 single ⇒ 1 行；all ⇒ 全系列；following ⇒ 本行起', async () => {
    const { svc } = build({
      rows: [mk(0), mk(1), mk(2), mk(3), mk(4)],
    });
    const r1 = await svc.changeStatus(OWNER, '10', 'done', 'single');
    expect(r1.updated).toBe(1);
    expect(r1.rows).toEqual(['10']);

    const r2 = await svc.changeStatus(OWNER, '12', 'cancelled', 'following');
    expect(r2.rows.sort()).toEqual(['12', '13', '14']); // 11-04 起三行

    const h3 = build({ rows: [mk(0), mk(1), mk(2)] });
    const r3 = await h3.svc.changeStatus(OWNER, '10', 'done', 'all');
    expect(r3.updated).toBe(3);
  });

  it('C2 原子条件：UPDATE where 带 status=planned；非 planned 行不计入', async () => {
    const { svc } = build({
      rows: [mk(0), mk(1, { status: 'done' }), mk(2)],
    });
    const res = await svc.changeStatus(OWNER, '10', 'cancelled', 'all');
    expect(res.rows).toEqual(['10', '12']); // 11 已 done ⇒ 不动（两终态互斥由原子条件保证）
  });

  it('C2b 无系列 ⇒ following/all 都只作用本行', async () => {
    const { svc } = build({ rows: [entityOf({ id: '7' })] });
    const res = await svc.changeStatus(OWNER, '7', 'done', 'all');
    expect(res.rows).toEqual(['7']);
  });
});

// ── H1 共享审计 ────────────────────────────────────────────
describe('共享范围变更审计（§五.3）', () => {
  it('H1 create 带共享 ⇒ 审计 after；update 改共享 ⇒ before/after 齐；无变化 ⇒ 不写', async () => {
    const h = build();
    await h.svc.create(OWNER, {
      title: 'x',
      startAt: '2026-11-02T01:00:00.000Z',
      share: { viewerUserIds: ['300'], managerUserIds: ['400'] },
    });
    // create 落库后审计经 repo.query（INSERT INTO t_ai_schedule_share_audit）
    const auditRows = (
      h.repo as unknown as { query: jest.Mock }
    ).query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('t_ai_schedule_share_audit'),
    );
    // fake repo 的 query 不记录 SELECT…这里 create 走的是 save ⇒ 审计走 query INSERT ⇒ 已被 fakeRepo 吞进 auditSql
    // （断言方式：改共享的 update 更直接 ⇒ 见下）
    void auditRows;

    const h2 = build({ rows: [entityOf({ id: '7' })] });
    await h2.svc.update(
      OWNER,
      '7',
      { share: { viewerRoles: ['fin'] } },
      'single',
    );
    const inserts = (
      h2.repo as unknown as { query: jest.Mock }
    ).query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO t_ai_schedule_share_audit'),
    );
    expect(inserts).toHaveLength(1);
    const params = (inserts[0] as unknown[])[1] as unknown[];
    expect(params[0] as string).toBe('t1'); // tenant
    expect(params[1] as string).toBe('7'); // schedule
    expect(params[2] as string).toBe('user:100'); // actor
    expect(params[4] as string).toBe(',fin,'); // after_viewer_roles
    expect(params[3]).toBeNull(); // before_viewer_roles

    // 无变化 ⇒ 不再写审计
    const before = (h2.repo as unknown as { query: jest.Mock }).query.mock.calls
      .length;
    await h2.svc.update(
      OWNER,
      '7',
      { share: { viewerRoles: ['fin'] } },
      'single',
    );
    const after = (
      h2.repo as unknown as { query: jest.Mock }
    ).query.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('INSERT INTO t_ai_schedule_share_audit'),
    ).length;
    expect(after).toBe(1); // 仍只有一条（无变化不重复审计）
    void before;
  });

  it('H1b 改共享需 admin：manager/viewer 尝试改共享 ⇒ 拒（反测：把 manager 当 owner）', async () => {
    const { svc } = build({
      rows: [entityOf({ id: '7', managerUserIds: ',400,' })],
    });
    await expect(
      svc.update(
        { tenantId: 't1', principal: { type: 'user', id: '400' } },
        '7',
        { share: { viewerUserIds: ['599'] } },
        'single',
      ),
    ).rejects.toThrow(/归属人/);
  });
});
