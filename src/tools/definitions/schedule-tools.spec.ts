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

function opValue(v: unknown): unknown[] | null {
  if (v && typeof v === 'object') {
    const o = v as { value?: unknown; _value?: unknown; type?: string };
    const raw = o.value ?? o._value;
    if (o.type === 'in' && Array.isArray(raw)) return raw as unknown[];
  }
  return null;
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
  it('② 库层三支 OR + 授予支内容', async () => {
    const find = jest.fn(() => Promise.resolve([scheduleOf()]));
    const tool = new AiScheduleListTool(
      { find } as never,
      aclStub({ granted: ['7'] }),
    );
    const result = await tool.execute({}, CTX);
    expect(result.success).toBe(true);
    const where = (find.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    const branches = where as Array<Record<string, unknown>>;
    expect(Array.isArray(where)).toBe(true);
    expect(branches).toHaveLength(3);
    expect(branches.every((b) => b.tenantId === 't1')).toBe(true);
    expect(opValue(branches[0].id)).toEqual(['7']); // 授予支内容（不只断言"有三支"）
    expect(branches[1].owner).toBe('user:u-1');
    expect(branches[2].participants).toBeDefined(); // LIKE 模式
  });

  it('③ 纵深防御：桩注入越权行 ⇒ 逐行确认丢弃', async () => {
    const find = jest.fn(() =>
      Promise.resolve([
        scheduleOf(),
        scheduleOf({ id: '999', owner: 'user:other', participants: null }),
      ]),
    );
    const tool = new AiScheduleListTool(
      { find } as never,
      aclStub({ access: 'none' }),
    );
    const result = await tool.execute({}, CTX);
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
    const tool = new AiScheduleCreateTool({
      findOne,
      find,
      save,
      create,
    } as never);
    return { tool, findOne, find, save };
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
  tool: AiScheduleCompleteTool | AiScheduleCancelTool,
  o: {
    schedule?: AiScheduleEntity | null;
    affected?: number;
    after?: AiScheduleEntity | null;
  } = {},
) {
  let finds = 0;
  const findOne = jest.fn(() => {
    finds += 1;
    return Promise.resolve(
      finds === 1 ? (o.schedule ?? scheduleOf()) : (o.after ?? null),
    );
  });
  const update = jest.fn(() => Promise.resolve({ affected: o.affected ?? 1 }));
  const t = new (
    tool.constructor as new (r: unknown, a: unknown) => typeof tool
  )({ findOne, update }, aclStub({ write: false }));
  return { tool: t, findOne, update };
}

describe('AiScheduleComplete / Cancel（原子迁移 + 终态语义）', () => {
  it('⑥ Complete：原子条件 status=planned；已 done ⇒ 回放（无歧义终态）', async () => {
    const h = stateHarness(new AiScheduleCompleteTool({} as never, aclStub()));
    const r = await h.tool.execute({ scheduleId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].status).toBe('planned'); // ← 承重：原子条件
    expect(call[1].status).toBe('done');

    const already = stateHarness(
      new AiScheduleCompleteTool({} as never, aclStub()),
      {
        schedule: scheduleOf({ status: 'done' }),
      },
    );
    const r2 = await already.tool.execute(
      { scheduleId: '12', confirm: true },
      CTX,
    );
    expect(r2.success).toBe(true);
    expect(r2.idempotent_replay).toBe(true); // 完成无歧义 ⇒ 回放
    expect(already.update).not.toHaveBeenCalled();
  });

  it('⑦ Cancel：已 done ⇒ **明确失败**（两终态互斥，不回放）', async () => {
    const h = stateHarness(new AiScheduleCancelTool({} as never, aclStub()), {
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
    const tool = new AiScheduleUpdateTool(
      { findOne, save } as never,
      aclStub({ write: o.write ?? true }),
    );
    return { tool, findOne, save };
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
    const saved = ok.save.mock.calls[0][0];
    expect(saved.participants).toBe(',u1,u12,'); // 归一化 + 去重
  });
});
