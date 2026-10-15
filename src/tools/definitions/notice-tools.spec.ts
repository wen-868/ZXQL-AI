/**
 * 通知工具测试（List / MarkRead / Archive / UnreadCount）—— R101-AI-40
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① List 库层条件：**授予支内容** + 每个 principal 一支 `receiver LIKE`（mutation：授予支清空/收窄 ⇒ 红）
 * ② List 纵深防御：桩注入越权通知 ⇒ 逐行确认丢弃（mutation：全放行 ⇒ 红）
 * ③ MarkRead **原子条件 `read_at IS NULL`**（mutation：去掉 `IsNull()` ⇒ 红）
 * ④ MarkRead 已读 ⇒ **回放**（无歧义终态）；afffected=0 竞态 ⇒ 回放
 * ⑤ Archive **原子条件 `archived_at IS NULL`**；已归档 ⇒ 回放
 * ⑥ UnreadCount 库层条件含 `read_at IS NULL AND archived_at IS NULL`；查询失败 ⇒ **降级返回 0 不抛**（角标稳健）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { AiNoticeEntity } from '../../database/entities/ai-notice.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ToolContext } from '../tool.interface';
import { AiNoticeArchiveTool } from './ai-notice-archive.tool';
import { AiNoticeListTool } from './ai-notice-list.tool';
import { AiNoticeMarkReadTool } from './ai-notice-mark-read.tool';
import { AiNoticeUnreadCountTool } from './ai-notice-unread-count.tool';

const CTX: ToolContext = { tenantId: 't1', userId: 'u-1' };

function noticeOf(over: Partial<AiNoticeEntity> = {}): AiNoticeEntity {
  return {
    id: '12',
    tenantId: 't1',
    receiver: ',user:u-1,',
    title: '日程提醒：季度复盘会',
    content: '14:00 开始',
    type: 'system',
    priority: 'reminder',
    readAt: null,
    archivedAt: null,
    source: 'schedule',
    refId: '12',
    dedupeKey: 'schedule:12:2026-10-20T05:30:00.000Z',
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

/** 形状：TypeORM 的 Like 算子 */
function isLike(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: string }).type;
  const raw =
    (v as { value?: unknown; _value?: unknown }).value ??
    (v as { _value?: unknown })._value;
  return t === 'like' && typeof raw === 'string' && raw.includes('%,');
}

/** 取出 Like 算子的原始模式串（用于断言到关键内容） */
function likeValue(v: unknown): string {
  const raw =
    (v as { value?: unknown; _value?: unknown }).value ??
    (v as { _value?: unknown })._value;
  return String(raw);
}

describe('AiNoticeListTool（R101-AI-40 通知列表 · 库层隔离）', () => {
  it('① 库层条件：授予支内容 + 每个 principal 一支 receiver LIKE', async () => {
    const find = jest.fn(() => Promise.resolve([noticeOf()]));
    const tool = new AiNoticeListTool(
      { find } as never,
      aclStub({ granted: ['7'] }),
    );

    const result = await tool.execute({ unreadOnly: true }, CTX);

    expect(result.success).toBe(true);
    const where = (find.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    const branches = where as Array<Record<string, unknown>>;
    expect(Array.isArray(where)).toBe(true);
    // 支 1 = 授予支；支 2 = user:u-1 的 receiver LIKE
    expect(opValue(branches[0].id)).toEqual(['7']);
    expect(isLike(branches[1].receiver)).toBe(true);
    // 形状断言断言到关键内容：这一支必须带我的 principal 值（不只是有 LIKE）
    expect(likeValue(branches[1].receiver)).toContain('user:u-1');
    // 未读 + 未归档条件在每支上（库层过滤）
    expect(branches.every((b) => b.tenantId === 't1')).toBe(true);
    expect(Object.keys(branches[0])).toContain('readAt');
    expect(Object.keys(branches[0])).toContain('archivedAt');
    // mutation 检验点：授予支清空 ⇒ opValue 断言红
  });

  it('② 纵深防御：无关通知（receiver 不含我）⇒ 逐行确认丢弃', async () => {
    const find = jest.fn(() =>
      Promise.resolve([
        noticeOf(),
        noticeOf({ id: '999', receiver: ',user:other,' }),
      ]),
    );
    const tool = new AiNoticeListTool(
      { find } as never,
      aclStub({ access: 'none' }),
    );

    const result = await tool.execute({}, CTX);

    const ids = (result.data as { list: Array<{ noticeId: string }> }).list.map(
      (x) => x.noticeId,
    );
    expect(ids).toEqual(['12']);
    // mutation 检验点：逐行确认全放行 ⇒ 999 出现 ⇒ 红
  });
});

describe('AiNoticeMarkReadTool（原子 + 回放）', () => {
  function harness(
    o: {
      notice?: AiNoticeEntity | null;
      affected?: number;
      after?: AiNoticeEntity | null;
    } = {},
  ) {
    let finds = 0;
    const findOne = jest.fn(() => {
      finds += 1;
      return Promise.resolve(
        finds === 1 ? (o.notice ?? noticeOf()) : (o.after ?? null),
      );
    });
    const update = jest.fn(() =>
      Promise.resolve({ affected: o.affected ?? 1 }),
    );
    const tool = new AiNoticeMarkReadTool(
      { findOne, update } as never,
      aclStub(),
    );
    return { tool, findOne, update };
  }

  it('③ 原子条件含 read_at IS NULL（不是无条件 UPDATE）', async () => {
    const h = harness();
    const r = await h.tool.execute({ noticeId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = h.update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].id).toBe('12');
    expect(call[0].readAt).toBeDefined(); // IsNull() 算子（非 undefined）
    expect(call[1].readAt).toBeInstanceOf(Date);
    // mutation 检验点：条件去掉 readAt ⇒ 本断言红
  });

  it('④ 已读 ⇒ 回放（无歧义终态）；竞态 affected=0 ⇒ 回放', async () => {
    const already = harness({ notice: noticeOf({ readAt: new Date() }) });
    const r1 = await already.tool.execute(
      { noticeId: '12', confirm: true },
      CTX,
    );
    expect(r1.success).toBe(true);
    expect(r1.idempotent_replay).toBe(true);
    expect(already.update).not.toHaveBeenCalled();

    const race = harness({
      affected: 0,
      after: noticeOf({ readAt: new Date() }),
    });
    const r2 = await race.tool.execute({ noticeId: '12', confirm: true }, CTX);
    expect(r2.success).toBe(true);
    expect(r2.idempotent_replay).toBe(true);
  });
});

describe('AiNoticeArchiveTool（原子 + 回放）', () => {
  it('⑤ 原子条件含 archived_at IS NULL；已归档 ⇒ 回放', async () => {
    const findOne = jest.fn(() => Promise.resolve(noticeOf()));
    const update = jest.fn(() => Promise.resolve({ affected: 1 }));
    const tool = new AiNoticeArchiveTool(
      { findOne, update } as never,
      aclStub(),
    );

    const r = await tool.execute({ noticeId: '12', confirm: true }, CTX);
    expect(r.success).toBe(true);
    const call = update.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(call[0].archivedAt).toBeDefined();
    expect(call[1].archivedAt).toBeInstanceOf(Date);

    const done = new AiNoticeArchiveTool(
      {
        findOne: jest.fn(() =>
          Promise.resolve(noticeOf({ archivedAt: new Date() })),
        ),
        update,
      } as never,
      aclStub(),
    );
    const r2 = await done.execute({ noticeId: '12', confirm: true }, CTX);
    expect(r2.idempotent_replay).toBe(true);
  });
});

describe('AiNoticeUnreadCountTool（角标）', () => {
  it('⑥ 条件含未读+未归档；查询失败 ⇒ 降级返回 0 且不抛', async () => {
    const count = jest.fn(() => Promise.resolve(3));
    const tool = new AiNoticeUnreadCountTool({ count } as never, aclStub());
    const r = await tool.execute({}, CTX);
    expect((r.data as { unread: number }).unread).toBe(3);
    const where = (count.mock.calls[0] as unknown as [{ where: unknown }])[0]
      .where;
    const branches = where as Array<Record<string, unknown>>;
    expect(Object.keys(branches[0])).toContain('readAt');
    expect(Object.keys(branches[0])).toContain('archivedAt');

    const broken = new AiNoticeUnreadCountTool(
      { count: jest.fn(() => Promise.reject(new Error('DB down'))) } as never,
      aclStub(),
    );
    const r2 = await broken.execute({}, CTX);
    expect(r2.success).toBe(true); // 角标稳健：不抛
    expect((r2.data as { unread: number; degraded?: boolean }).unread).toBe(0);
    expect((r2.data as { degraded?: boolean }).degraded).toBe(true);
  });
});
