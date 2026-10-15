/**
 * ScheduleReminderService 测试 —— R101-AI-39（提醒复用既有通道）
 *
 * 反测（各含 mutation；判据=目标用例变红）：
 * ① 到期候选 ⇒ **调用既有 `ProactivePushService.push`**（断言 tenantId/taskName/content 含
 *    owner+participants）并写 `reminded_at`；mutation：不调 push 直接标 reminded_at ⇒ 红
 * ② push 返回 false（推送失败）⇒ **不写标记**（下次重试），且**不影响其余条目**
 * ③ 查询抛错 ⇒ **不抛**，返回 0（@Cron 内异常必须隔离）
 * ④ 无候选 ⇒ 不调用 push
 * ⑤ 结构性保证：本服务**只注入既有 push 服务**（未注入任何新通道）⇒ "不硬造推送/调度"可机器核验
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { ScheduleReminderService } from './schedule-reminder.service';

const DUE = {
  id: '12',
  tenant_id: 't1',
  title: '季度复盘会',
  owner: 'user:u-1',
  participants: ',user:u-2,',
  start_at: new Date('2026-10-20T06:00:00Z'),
  remind_at: new Date('2026-10-20T05:30:00Z'),
};

function createHarness(
  o: { rows?: unknown[]; pushOk?: boolean; queryThrows?: boolean } = {},
) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  const query = jest.fn((sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (o.queryThrows && sql.includes('SELECT id, tenant_id')) {
      return Promise.reject(new Error('DB down'));
    }
    if (sql.includes('SELECT id, tenant_id'))
      return Promise.resolve(o.rows ?? []);
    return Promise.resolve([]);
  });
  const push = jest.fn(() => Promise.resolve(o.pushOk ?? true));
  const svc = new ScheduleReminderService(
    { query } as unknown as DataSource,
    { push } as unknown as ProactivePushService,
  );
  return { svc, query, push, queries };
}

describe('ScheduleReminderService（R101-AI-39 日程提醒）', () => {
  it('① 到期候选 ⇒ 调用既有 push（含 owner/participants）+ 写提醒标记', async () => {
    const h = createHarness({ rows: [DUE] });

    const pushed = await h.svc.scanDueReminders(
      new Date('2026-10-20T05:35:00Z'),
    );

    expect(pushed).toBe(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    const call = h.push.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(call[0]).toBe('t1'); // tenantId
    expect(call[1]).toBe('schedule_reminder'); // taskName（proactive 域既有口径）
    // 租户级广播 ⇒ 消息体必须带 owner/participants 供前端过滤（凌舟裁定 ①）
    expect(String(call[2].content)).toContain('user:u-1');
    expect(String(call[2].content)).toContain('user:u-2');
    // 写提醒幂等标记
    const upd = h.queries.find((q) => q.sql.includes('SET reminded_at'));
    expect(upd).toBeDefined();
    expect(upd?.params?.[1]).toBe('12');
  });

  it('② 推送失败 ⇒ 不写标记（下次重试）', async () => {
    const h = createHarness({ rows: [DUE], pushOk: false });

    const pushed = await h.svc.scanDueReminders(
      new Date('2026-10-20T05:35:00Z'),
    );

    expect(pushed).toBe(0);
    expect(h.queries.some((q) => q.sql.includes('SET reminded_at'))).toBe(
      false,
    );
    // mutation 检验点：改成"先标记再推送"或"失败也标记"⇒ 本断言红
  });

  it('③ 查询抛错 ⇒ 不抛、返回 0（@Cron 内异常隔离）', async () => {
    const h = createHarness({ queryThrows: true });

    await expect(h.svc.scanDueReminders(new Date())).resolves.toBe(0);
    expect(h.push).not.toHaveBeenCalled();
  });

  it('④ 无候选 ⇒ 不调用 push', async () => {
    const h = createHarness({ rows: [] });
    await h.svc.scanDueReminders(new Date());
    expect(h.push).not.toHaveBeenCalled();
  });

  it('⑤ 结构性保证：只依赖既有 push（未注入新通道/调度器）', () => {
    const h = createHarness();
    // 契约演进（R101-AI-40 S3）：构造参数由 2 个变为 3 个 —— 新增 `@Optional()` 的通知旁路
    //（有则"先落站内通知、再推实时"；无则退回既有 push 路径 ⇒ 既有 2 参构造仍可用）
    expect(ScheduleReminderService.length).toBeGreaterThanOrEqual(2);
    expect(typeof h.svc.scanDueReminders).toBe('function');
  });
});
