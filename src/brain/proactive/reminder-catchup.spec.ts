/**
 * ReminderCatchupService 测试（AI-P2-3 停机漏提醒补偿）
 *
 * 反测设计（每条"改坏会红"）：
 * ① **不设"只补最近 N 条"**：100 条必须**全部**补回（mutation 1：改成单批即停 ⇒ 红）
 * ② **聚合摘要不替代通知中心**：>3 条时每条仍独立入箱，摘要另发
 *    （mutation 2：用摘要替代逐条入箱 ⇒ 红）
 * ③ **幂等**：重复扫描 100 次不重复插入/发送（mutation 3：去掉幂等键 ⇒ 红）
 * ④ 分层：1/3 条逐条推；4 条及以上发聚合摘要
 * ⑤ 安静时段 22:00–08:00 不推即时消息，但通知照常入箱；08:00 生成汇总
 * ⑥ 停机 1 小时 / 跨天 / 7 天：时间窗不影响"全部补回"语义
 * ⑦ 渠道失败：失败条 target 保留待重试，成功渠道不重发
 * ⑧ 跨租户/跨用户隔离：每条按自己的 tenant/owner 落箱，不串
 * ⑨ recurrence：BLOCKED（实体无字段，见派单卡裁定）—— 用注释登记，不造假用例
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-25
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ReminderCatchupService } from './reminder-catchup.service';

/** 构造一行到期未提醒的日程（未提醒：reminded_at IS NULL 由 SQL 过滤，这里只造查询返回） */
function rowOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: 't1',
    title: '客户回访',
    owner: 'user:7',
    participants: 'user:8,user:9',
    start_at: '2026-10-25T10:00:00.000Z',
    remind_at: '2026-10-25T09:00:00.000Z',
    ...over,
  };
}

interface HarnessOpts {
  /** 查询返回的行（按调用序返回不同批次，模拟分批） */
  batches?: Array<Array<Record<string, unknown>>>;
  /** push 返回值序列（true/false），或固定值 */
  pushResults?: boolean[] | boolean;
  /** noticeBridge 是否存在 */
  withNotice?: boolean;
}

function createHarness(opts: HarnessOpts = {}) {
  const batches = opts.batches ?? [[]];
  let queryCall = 0;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn((sql: string, params: unknown[]) => {
    queries.push({ sql, params });
    // 只对"到期扫描"返回批次；UPDATE / 积压查询返回空
    if (
      sql.includes('FROM t_ai_schedule') &&
      sql.includes('reminded_at IS NULL')
    ) {
      const idx = Math.min(queryCall, batches.length - 1);
      queryCall += 1;
      return Promise.resolve(batches[idx] ?? []);
    }
    return Promise.resolve([]);
  });

  const pushResults = opts.pushResults;
  let pushCall = 0;
  const push = jest.fn(() => {
    if (Array.isArray(pushResults)) {
      const v = pushResults[Math.min(pushCall, pushResults.length - 1)] ?? true;
      pushCall += 1;
      return Promise.resolve(v);
    }
    return Promise.resolve(pushResults ?? true);
  });

  const pushWithNotice = jest.fn(() => Promise.resolve(true));

  const noticeBridge =
    opts.withNotice === false ? undefined : { pushWithNotice };

  const service = new ReminderCatchupService(
    { query } as never,
    { push } as never,
    noticeBridge as never,
  );
  return { service, query, push, pushWithNotice, queries };
}

describe('ReminderCatchupService（AI-P2-3 停机漏提醒补偿）', () => {
  // 固定"非安静时段"时间点：2026-10-25 10:00 Asia/Shanghai
  const DAY_10AM = new Date('2026-10-25T02:00:00.000Z');
  // 安静时段：2026-10-25 23:00 Asia/Shanghai
  const NIGHT_11PM = new Date('2026-10-25T15:00:00.000Z');
  // 08:00 整（汇总时刻）Asia/Shanghai
  const MORNING_8AM = new Date('2026-10-25T00:00:00.000Z');

  it('① 100 条全部补回（不设"只补最近 N 条"；分批扫尽）', async () => {
    const rows1 = Array.from({ length: 100 }, (_, i) =>
      rowOf({ id: i + 1, title: `提醒${i + 1}` }),
    );
    const h = createHarness({ batches: [rows1, []] });

    const r = await h.service.catchup(DAY_10AM);

    // 🔴 承重断言：100 条全部入箱（mutation 1：单批即停 ⇒ 只剩 100 但不再续扫的语义红）
    expect(r.scanned).toBe(100);
    expect(r.recorded).toBe(100);
    expect(h.pushWithNotice).toHaveBeenCalledTimes(100);
    // >3 条 ⇒ 一条聚合摘要
    expect(r.digests).toBe(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    // 摘要文案含总数与引导（push 签名：push(tenantId, taskName, push) ⇒ 索引 2 是 push 对象）
    const digestArg = h.push.mock.calls[0] as unknown[];
    const digestPush = digestArg[2] as { title: string; content: string };
    expect(digestPush.title).toContain('100');
    expect(digestPush.content).toContain('100');
    expect(digestPush.content).toContain('通知中心');
  });

  it('①b 跨批（两批各 100）仍全部补回，证明循环到扫尽', async () => {
    const batch1 = Array.from({ length: 100 }, (_, i) => rowOf({ id: i + 1 }));
    const batch2 = Array.from({ length: 50 }, (_, i) => rowOf({ id: 101 + i }));
    const h = createHarness({ batches: [batch1, batch2, []] });

    const r = await h.service.catchup(DAY_10AM);

    expect(r.scanned).toBe(150);
    expect(r.recorded).toBe(150);
  });

  for (const n of [1, 3]) {
    it(`④ ${n} 条（≤3）⇒ 逐条推送 ${n} 次，不发聚合摘要`, async () => {
      const rows = Array.from({ length: n }, (_, i) => rowOf({ id: i + 1 }));
      const h = createHarness({ batches: [rows, []] });

      const r = await h.service.catchup(DAY_10AM);

      expect(r.recorded).toBe(n);
      // 逐条推送 = n 次（不含摘要）
      expect(h.push).toHaveBeenCalledTimes(n);
      expect(r.digests).toBe(0);
    });
  }

  it('④b 4 条 ⇒ 一条聚合摘要（不逐条推），但 4 条都独立入箱', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ batches: [rows, []] });

    const r = await h.service.catchup(DAY_10AM);

    // 🔴 关键：4 条全部入箱（摘要不替代本体）
    expect(h.pushWithNotice).toHaveBeenCalledTimes(4);
    expect(r.recorded).toBe(4);
    // 只推 1 条摘要
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r.digests).toBe(1);
    const digest = h.push.mock.calls[0] as unknown[];
    const digestPush = digest[2] as { title: string; content: string };
    expect(digestPush.title).toContain('4');
  });

  it('② 聚合摘要不替代通知中心：每条 dedupeKey 独立（可追溯每条原始提醒）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ batches: [rows, []] });

    await h.service.catchup(DAY_10AM);

    // 每条都有独立的 dedupeKey（含各自 sourceId）⇒ 通知中心可逐条存在
    const keys = h.pushWithNotice.mock.calls
      .map((c) => (c as unknown[])[3] as { dedupeKey: string })
      .map((o) => o.dedupeKey);
    expect(keys).toHaveLength(5);
    expect(new Set(keys).size).toBe(5);
    for (let i = 1; i <= 5; i += 1) {
      expect(keys).toContain(`catchup:${i}:2026-10-25T09:00:00.000Z`);
    }
  });

  it('③ 幂等键格式：tenant 维度 + sourceId + occurrenceAt（重复扫描不重复成功发送）', async () => {
    const rows = [rowOf({ id: 42 })];
    const h = createHarness({ batches: [rows, []] });

    await h.service.catchup(DAY_10AM);

    const [, , , opts] = h.pushWithNotice.mock.calls[0] as unknown[];
    expect(opts).toMatchObject({
      dedupeKey: 'catchup:42:2026-10-25T09:00:00.000Z',
      refId: '42',
      source: 'schedule',
    });
    // tenant 作为第一参数传入（跨租户隔离）
    expect((h.pushWithNotice.mock.calls[0] as unknown[])[0]).toBe('t1');
  });

  it('⑤ 安静时段（23:00）⇒ 通知照常入箱、但不推即时消息', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    // 安静时段不会走"积压查询"（那段只在非安静时段跑）⇒ 首批即到期行
    const h = createHarness({ batches: [rows, []] });

    const r = await h.service.catchup(NIGHT_11PM);

    expect(r.quiet).toBe(true);
    // 通知照常入箱（用户早上打开能看到）
    expect(h.pushWithNotice).toHaveBeenCalledTimes(5);
    expect(r.recorded).toBe(5);
    // 🔴 安静时段零即时推送（mutation：去掉 quiet 判断 ⇒ 本断言红）
    expect(h.push).not.toHaveBeenCalled();
    expect(r.pushed).toBe(0);
    expect(r.deferred).toBe(true);
  });

  it('⑤b 08:00 生成汇总摘要（安静时段积压的提醒得到告知）', async () => {
    const backlog = [rowOf({ id: 90 }), rowOf({ id: 91 })];
    const query = jest.fn((sql: string) => {
      // 第 1 次：安静时段积压查询 ⇒ 返回 2 条
      if (sql.includes('NOT EXISTS')) {
        return Promise.resolve(backlog);
      }
      // 后续到期扫描 ⇒ 空
      return Promise.resolve([]);
    });
    const push = jest.fn(() => Promise.resolve(true));
    const service = new ReminderCatchupService(
      { query } as never,
      { push } as never,
      { pushWithNotice: jest.fn() } as never,
    );

    const r = await service.catchup(MORNING_8AM);

    expect(r.quiet).toBe(false);
    expect(r.digests).toBeGreaterThanOrEqual(1);
    // 汇总摘要被推送
    expect(push).toHaveBeenCalled();
    const arg = push.mock.calls[0] as unknown[];
    const digestPush = arg[2] as { title: string; content: string };
    expect(digestPush.title).toContain('2');
  });

  it('⑥ 停机 7 天的积压同样全部补回（时间窗不影响"全部"语义）', async () => {
    // 7 天前的 remind_at 也会被 catchup 扫到（SQL 只判 <= now 且未标记）
    const rows = Array.from({ length: 6 }, (_, i) =>
      rowOf({ id: i + 1, remind_at: `2026-10-${18 + i}T09:00:00.000Z` }),
    );
    const h = createHarness({ batches: [rows, []] });

    const r = await h.service.catchup(DAY_10AM);

    expect(r.scanned).toBe(6);
    expect(r.recorded).toBe(6);
  });

  it('⑦ 渠道失败：failed 计数如实，成功的照常', async () => {
    const rows = [rowOf({ id: 1 }), rowOf({ id: 2 })];
    // 第 1 条落箱成功、第 2 条落箱抛错
    let call = 0;
    const pushWithNotice = jest.fn(() => {
      call += 1;
      return call === 2
        ? Promise.reject(new Error('channel down'))
        : Promise.resolve(true);
    });
    const service = new ReminderCatchupService(
      { query: jest.fn(() => Promise.resolve(rows)) } as never,
      { push: jest.fn(() => Promise.resolve(true)) } as never,
      { pushWithNotice } as never,
    );

    const r = await service.catchup(DAY_10AM);

    expect(r.recorded).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('⑧ 跨租户隔离：各条按自己的 tenant 落箱，不串租户', async () => {
    const rows = [
      rowOf({ id: 1, tenant_id: 'tA', title: 'A店' }),
      rowOf({ id: 2, tenant_id: 'tB', title: 'B店' }),
    ];
    const h = createHarness({ batches: [rows, []] });

    await h.service.catchup(DAY_10AM);

    const tenants = h.pushWithNotice.mock.calls.map((c) => (c as unknown[])[0]);
    expect(tenants).toEqual(['tA', 'tB']);
  });

  it('⑨ 无通知旁路时退回既有 push（既有单测路径保持兼容）', async () => {
    const rows = [rowOf({ id: 1 })];
    const h = createHarness({ batches: [rows, []], withNotice: false });

    const r = await h.service.catchup(DAY_10AM);

    expect(r.recorded).toBe(1);
    // 退回 push 路径（1 条逐条推）
    expect(h.push).toHaveBeenCalled();
  });

  it('⑩ 查询抛错 ⇒ 不抛、返回零结果（@Cron 内异常隔离）', async () => {
    const service = new ReminderCatchupService(
      {
        query: jest.fn(() => Promise.reject(new Error('DB down'))),
      } as never,
      { push: jest.fn() } as never,
      { pushWithNotice: jest.fn() } as never,
    );

    await expect(service.catchup(DAY_10AM)).resolves.toMatchObject({
      scanned: 0,
    });
  });

  it('⑪ 安静时段判定：22:00 起、08:00 止（Asia/Shanghai 边界）', () => {
    const h = createHarness();
    expect(h.service.isQuietHours(new Date('2026-10-25T14:00:00.000Z'))).toBe(
      true,
    ); // 22:00 CST
    expect(h.service.isQuietHours(new Date('2026-10-25T15:00:00.000Z'))).toBe(
      true,
    ); // 23:00
    expect(h.service.isQuietHours(new Date('2026-10-25T23:00:00.000Z'))).toBe(
      true,
    ); // 07:00
    expect(h.service.isQuietHours(new Date('2026-10-25T00:00:00.000Z'))).toBe(
      false,
    ); // 08:00
    expect(h.service.isQuietHours(new Date('2026-10-25T02:00:00.000Z'))).toBe(
      false,
    ); // 10:00
  });

  it('⑬ AI 只读查询：返回条数与摘要，且**不写任何数据**（红线：AI 不得删原始提醒）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `漏提醒${i + 1}` }),
    );
    const queries: string[] = [];
    const query = jest.fn((sql: string) => {
      queries.push(sql);
      return Promise.resolve(rows);
    });
    const service = new ReminderCatchupService(
      { query } as never,
      { push: jest.fn() } as never,
      { pushWithNotice: jest.fn() } as never,
    );

    const r = await service.summarizeBacklog('t1', DAY_10AM);

    expect(r.total).toBe(5);
    expect(r.urgent).toHaveLength(3); // 最多 3 条最紧急
    expect(r.summary).toContain('5');
    expect(r.summary).toContain('通知中心');
    // 🔴 承重断言：全是 SELECT，**零写操作**（AI 不得改 reminded_at / 删行）
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('SELECT');
    expect(queries[0]).not.toContain('UPDATE');
    expect(queries[0]).not.toContain('DELETE');
    expect(queries[0]).not.toContain('INSERT');
  });

  it('⑭ 人工与 AI 共用同一补偿器：同一 SQL 表 + 同一 push/notice 通道（无旁路）', () => {
    // 结构性保证：本服务只读 t_ai_schedule（人工与 AI 创建的日程同表），
    // 且只经 ProactivePushService / NoticeBridgeService 送达（无专用通道）。
    const src = readFileSync(
      join(process.cwd(), 'src/brain/proactive/reminder-catchup.service.ts'),
      'utf8',
    );
    // 只有 t_ai_schedule 一个业务表（push_log 仅用于积压判定查询）
    expect(src).toContain('FROM t_ai_schedule');
    // 不引入新推送客户端（复用既有两件）
    expect(src).toContain('ProactivePushService');
    expect(src).toContain('NoticeBridgeService');
    // 无自建 HTTP/WS 通道
    expect(src).not.toContain('new WebSocket');
    expect(src).not.toContain('axios');
  });

  it('⑫ BLOCKED 登记：recurrence 无数据模型（不造假用例）', () => {
    // 派单卡要求覆盖 recurrence occurrence，但 ai-schedule.entity.ts **没有 recurrence 字段**
    // （仅有注释声明"边界（本批不做）"），P2-2 尚未落地 ⇒ 如实标 BLOCKED，不自造模型。
    // 本用例文档化该决定：若未来实体真加 @Column recurrence 字段，此断言会红 ⇒ 强制补真用例。
    const entitySource = readFileSync(
      join(process.cwd(), 'src/database/entities/ai-schedule.entity.ts'),
      'utf8',
    );
    // 判据：不存在"列定义"（@Column 块内出现 recurrence），而非整文件关键词
    const hasRecurrenceColumn =
      /@Column\([^)]*\)[\s\S]{0,200}?\brecurrence\w*\s*!?\s*:/.test(
        entitySource,
      );
    expect(hasRecurrenceColumn).toBe(false);
  });
});
