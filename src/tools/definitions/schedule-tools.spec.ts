/**
 * 日程工具测试（List / Create / Update / Complete / Cancel）—— R101-AI-39
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① participants **边界匹配**：`u1` 不得命中 `u12`（mutation：改成无逗号 includes ⇒ 红）
 * ② List **库层三支 OR** + **授予支内容**（mutation：ACL 支清空/收窄 ⇒ 红）
 * ③ List **纵深防御**（桩注入越权行 ⇒ 丢弃；mutation：全放行 ⇒ 红）
 * ④ Create preview 零副作用（mutation：去早返回 ⇒ 红）
 * ⑤ Create 幂等（业务层）⇒ 回放（mutation：去幂等 ⇒ 红）
 * ⑥ Complete **原子条件 status=planned**；已 done ⇒ **回放**（无歧义终态，规范 §2.1）
 * ⑦ Cancel 已 done ⇒ **明确失败**（两终态互斥）
 * ⑧ Update **拒 status**（mutation：允许 ⇒ 红）；仅 planned 可改（mutation：去判定 ⇒ 红）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiScheduleCancelTool } from './ai-schedule-cancel.tool';
import { AiScheduleCompleteTool } from './ai-schedule-complete.tool';
import { AiScheduleCreateTool } from './ai-schedule-create.tool';
import { AiScheduleListTool } from './ai-schedule-list.tool';
import { AiScheduleUpdateTool } from './ai-schedule-update.tool';
import { ScheduleDomainService } from '../../brain/schedule/schedule-domain.service';
import {
  matchesParticipant,
  normalizeParticipants,
} from './schedule-participants.util';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function scheduleOf(over: Partial<AiScheduleEntity> = {}): AiScheduleEntity {
  return {
    id: '12',
    tenantId: 't1',
    title: '季度复盘会',
    startAt: new Date('2026-10-20T06:00:00Z'),
    endAt: null,
    owner: 'user:u-1',
    participants: ',user:u-2,',
    status: 'planned',
    remindAt: null,
    remindedAt: null,
    source: 'ai',
    createdBy: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    // AI-P2-2 新增字段的默认值（PRIVATE：共享与代管为空；单次日程无系列）
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

function aclStub(
  o: { granted?: string[]; access?: string; write?: boolean } = {},
) {
  return {
    aclGrantedIds: jest.fn(() => Promise.resolve(o.granted ?? [])),
    resolveResource: jest.fn(() => Promise.resolve(o.access ?? 'admin')),
    canWriteResource: jest.fn(() => Promise.resolve(o.write ?? true)),
  } as unknown as OfficeAclService;
}

describe('participants 边界匹配（双形态坑）', () => {
  it('① 归一化 + 边界匹配：u1 不命中 u12', () => {
    expect(normalizeParticipants(' u1 , ,u1, u12 ')).toBe(',u1,u12,');
    expect(normalizeParticipants('   ')).toBeNull();
    // 边界正确
    expect(matchesParticipant(',user:u1,user:u12,', 'user:u1')).toBe(true);
    expect(matchesParticipant(',user:u1,user:u12,', 'user:u12')).toBe(true);
    // 🔴 关键：u1 不得因"子串"命中 u12 那一项
    expect(matchesParticipant(',user:u12,', 'user:u1')).toBe(false);
    expect(matchesParticipant(',user:u1,', 'user:u12')).toBe(false);
  });
});

// ══════════ List ══════════
describe('AiScheduleListTool', () => {
  /** AI-P2-2：list 的可见性由领域服务统一负责（find/query 都在领域层） */
  function listHarness(
    o: {
      rows?: AiScheduleEntity[];
      access?: string;
      granted?: string[];
    } = {},
  ) {
    const rows = o.rows ?? [scheduleOf()];
    // 领域服务用 query() 做库层过滤（listVisible）⇒ 这里给 raw 形状
    const query = jest.fn(() =>
      Promise.resolve(
        rows.map((r) => ({
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
      ),
    );
    const acl = aclStub({ access: o.access ?? 'admin', granted: o.granted });
    const domain = new ScheduleDomainService(
      {
        query,
        find: jest.fn(() => Promise.resolve(rows)),
        findOne: jest.fn(),
        save: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
      } as never,
      acl,
    );
    const tool = new AiScheduleListTool(
      { find: jest.fn() } as never,
      acl,
      domain,
    );
    return { tool, query, acl, domain };
  }

  it('② 库层三支 OR + 授予支内容', async () => {
    const h = listHarness({ rows: [scheduleOf()], access: 'admin' });
    const result = await h.tool.execute({}, CTX);
    expect(result.success).toBe(true);
    // AI-P2-2：库层条件由领域服务构造（SQL 断言 ⇒ 仍验证"库层收窄 + 租户"）
    const sql = (h.query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain('s.tenant_id = ?');
    expect(sql).toContain('s.owner = ?');
    expect(sql).toContain('s.participants LIKE ?');
    expect(sql).toContain('s.viewer_user_ids LIKE ?'); // AI-P2-2 新增共享人员支
    expect(sql).toContain('s.manager_user_ids LIKE ?'); // 代管支
    // 参数里含我的 principal（证明收窄以我为锚）
    const params = (h.query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params).toContain('user:u-1');
  });

  it('②b 有角色时追加 viewer_roles 支（共享角色取并集）', async () => {
    const h = listHarness({ rows: [scheduleOf()], access: 'admin' });
    // 带 role 的上下文 ⇒ SQL 必须含共享角色支
    await h.tool.execute({}, { ...CTX, role: 'fin' });
    const sql = (h.query.mock.calls[0] as unknown as [string])[0];
    expect(sql).toContain('s.viewer_roles LIKE ?');
    const params = (h.query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params).toContain('%,fin,%');
  });

  it('③ 纵深防御：桩注入越权行 ⇒ 逐行确认丢弃', async () => {
    const rows = [
      scheduleOf(),
      scheduleOf({ id: '999', owner: 'user:other', participants: null }),
    ];
    // access=none ⇒ 领域服务 resolveAccess 返回 none，但 owner 规则仍会放行本人行
    const h = listHarness({ rows, access: 'none' });
    const result = await h.tool.execute({}, CTX);
    const ids = (
      result.data as { list: Array<{ scheduleId: string }> }
    ).list.map((x) => x.scheduleId);
    expect(ids).toEqual(['12']); // 我是 owner；999 与我无关 ⇒ 丢弃
  });
});

// ══════════ Create ══════════
describe('AiScheduleCreateTool', () => {
  function createHarness(
    o: {
      existing?: AiScheduleEntity | null;
      conflicts?: AiScheduleEntity[];
    } = {},
  ) {
    const findOne = jest.fn(() => {
      return Promise.resolve(o.existing ?? null);
    });
    const find = jest.fn(() => Promise.resolve(o.conflicts ?? []));
    const save = jest.fn((e: Partial<AiScheduleEntity>) =>
      Promise.resolve({ ...e, id: '77' } as AiScheduleEntity),
    );
    const create = jest.fn((e: Partial<AiScheduleEntity>) => e);
    // AI-P2-2：领域服务为**真实实例**（同源承重：预览/落库都由它算）
    const domain = new ScheduleDomainService(
      {
        create,
        save,
        findOne,
        find,
        update: jest.fn(),
        query: jest.fn(() => Promise.resolve([])),
      } as never,
      aclStub(),
    );
    const tool = new AiScheduleCreateTool(
      { findOne, find, save, create } as never,
      domain,
    );
    return { tool, findOne, find, save, domain };
  }

  it('④ preview 零副作用', async () => {
    const h = createHarness();
    const r = await h.tool.execute(
      { title: '季度复盘会', startAt: '2026-10-20T14:00:00+08:00' },
      CTX,
    );
    expect(r.success).toBe(true);
    const d = r.preview?.details as Record<string, unknown>;
    expect(d.owner).toBe('user:u-1');
    expect(String(d.idempotency)).toContain('NOT NULL');
    expect(h.findOne).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it('⑤ 幂等（业务层）⇒ 回放；并做冲突提示（不阻止）', async () => {
    const dup = createHarness({ existing: scheduleOf({ id: '9' }) });
    const r1 = await dup.tool.execute(
      {
        title: '季度复盘会',
        startAt: '2026-10-20T14:00:00+08:00',
        confirm: true,
      },
      CTX,
    );
    expect(r1.idempotent_replay).toBe(true);
    expect(dup.save).not.toHaveBeenCalled();

    const conflict = createHarness({
      conflicts: [scheduleOf({ id: '5', title: '别的会' })],
    });
    const r2 = await conflict.tool.execute(
      { title: '新会', startAt: '2026-10-20T15:00:00+08:00', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(true); // 冲突不阻止
    const d2 = r2.data as { conflicts: unknown[]; warning?: string };
    expect(d2.conflicts).toHaveLength(1);
    expect(String(d2.warning)).toContain('未阻止');
    expect(conflict.save).toHaveBeenCalledTimes(1);
  });
});

// ══════════ Complete / Cancel ══════════
function stateHarness(
  kind: 'complete' | 'cancel',
  o: {
    schedule?: AiScheduleEntity | null;
    affected?: number;
    after?: AiScheduleEntity | null;
  } = {},
) {
  let finds = 0;
  const findOne = jest.fn(() => {
    finds += 1;
    // AI-P2-2：领域服务 getById 也会 findOne ⇒ 前两次必须都返回目标日程，
    // 之后（affected=0 的 after 探测）才返回 o.after
    if (finds <= 2) return Promise.resolve(o.schedule ?? scheduleOf());
    return Promise.resolve(o.after ?? null);
  });
  const update = jest.fn((_w?: unknown, _s?: unknown) =>
    Promise.resolve({ affected: o.affected ?? 1 }),
  );
  // AI-P2-2：状态迁移经**领域服务**（权限判定 + 三作用域都在领域层）
  // AI-P2-2：判定上收领域服务后，owner 场景等价于 ACL 放行（access=admin）
  const acl = aclStub({ write: false, access: 'admin' });
  const domain = new ScheduleDomainService(
    {
      findOne,
      update,
      find: jest.fn(() => Promise.resolve([])),
      query: jest.fn(() => Promise.resolve([])),
      save: jest.fn(),
      create: jest.fn(),
    } as never,
    acl,
  );
  const Ctor =
    kind === 'complete' ? AiScheduleCompleteTool : AiScheduleCancelTool;
  const t = new Ctor({ findOne, update } as never, acl, domain);
  return { tool: t, findOne, update, domain };
}

describe('AiScheduleComplete / Cancel（原子迁移 + 终态语义）', () => {
  it('⑥ Complete：原子条件 status=planned；已 done ⇒ 回放（无歧义终态）', async () => {
    const h = stateHarness('complete');
    const r = await h.tool.execute({ scheduleId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].status).toBe('planned'); // ← 承重：原子条件
    expect(call[1].status).toBe('done');

    const already = stateHarness('complete', {
      schedule: scheduleOf({ status: 'done' }),
    });
    const r2 = await already.tool.execute(
      { scheduleId: '12', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(true);
    expect(r2.idempotent_replay).toBe(true); // 完成无歧义 ⇒ 回放
    expect(already.update).not.toHaveBeenCalled();
  });

  it('⑦ Cancel：已 done ⇒ **明确失败**（两终态互斥，不回放）', async () => {
    const h = stateHarness('cancel', {
      schedule: scheduleOf({ status: 'done' }),
    });
    const r = await h.tool.execute({ scheduleId: '12', confirm: true }, CTX);
    expect(r.success).toBe(false);
    expect(r.error).toContain('done');
    expect(r.idempotent_replay).toBeUndefined();
    expect(h.update).not.toHaveBeenCalled();
  });
});

// ══════════ Update ══════════
describe('AiScheduleUpdateTool', () => {
  function updateHarness(
    o: { schedule?: AiScheduleEntity | null; write?: boolean } = {},
  ) {
    const findOne = jest.fn(() => Promise.resolve(o.schedule ?? scheduleOf()));
    const save = jest.fn((e: AiScheduleEntity) => Promise.resolve(e));
    const update = jest.fn((_where: unknown, _set: unknown) =>
      Promise.resolve({ affected: 1 }),
    );
    const acl = aclStub({ write: o.write ?? true });
    // AI-P2-2：领域服务真实实例（承载权限判定 + 三作用域写入）
    const domain = new ScheduleDomainService(
      {
        findOne,
        save,
        update,
        find: jest.fn(() => Promise.resolve([])),
        query: jest.fn(() => Promise.resolve([])),
      } as never,
      acl,
    );
    const tool = new AiScheduleUpdateTool(
      { findOne, save, update } as never,
      acl,
      domain,
    );
    return { tool, findOne, save, update, domain };
  }

  it('⑧ 拒 status（先于一切）；仅 planned 可改', async () => {
    const h = updateHarness();
    const r1 = await h.tool.execute(
      { scheduleId: '12', status: 'done', confirm: true },
      CTX,
    );
    expect(r1.success).toBe(false);
    expect(r1.error).toContain('不接受 status');
    expect(h.save).not.toHaveBeenCalled();

    const done = updateHarness({ schedule: scheduleOf({ status: 'done' }) });
    const r2 = await done.tool.execute(
      { scheduleId: '12', title: '改', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(false);
    expect(r2.error).toContain('仅未完成');
    expect(done.save).not.toHaveBeenCalled();

    const ok = updateHarness();
    const r3 = await ok.tool.execute(
      { scheduleId: '12', participants: 'u1,u12,u1', confirm: true },
      CTX,
    );
    expect(r3.success).toBe(true);
    // AI-P2-2：写入经**领域服务**（不再由工具层 save）⇒ 断言领域层的 update 调用参数
    const patch = ok.update.mock.calls[0][1] as { participants?: string };
    expect(patch.participants).toBe(',u1,u12,'); // 归一化 + 去重
  });
});
