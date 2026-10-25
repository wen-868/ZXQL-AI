/**
 * ReminderCatchupService 测试（AI-P2-3F2 · 摘要投递闭合与安静时段收口）
 *
 * 保真原则（F1 B5 的延续）：harness 用**真实 NoticeBridgeService 实例**
 * + mock NoticeService.record + mock ProactivePushService.push ⇒ 断言真实调用链。
 *
 * F2 覆盖（中央卡 §六 反测靶点一一命名）：
 * ①  >3 摘要成功后下轮扫到 0（返工点 1；M1 靶点）
 * ②  两 owner 摘要隔离 + targetUserId 定向（返工点 2；M2 靶点）
 * ③  quiet 后 1/3/4 条各只一条汇总（返工点 4；M3 靶点）
 * ④  同批连续 cron 只发一次；新批不含旧条目
 * ⑤  notice success + reminded_at=null 幂等补写（返工点 5；M4 靶点）
 * ⑥  不可定向 owner ⇒ skipped 收口（不广播、不重扫）
 * ⑦~⑪ B1/B2/B3/B5 保留行为
 * ⑫⑬ 100 条闭合 + 跨租户分组隔离
 * ⑭ AI 只读零写；⑮ recurrence BLOCKED；⑯ 结构禁 pushWithNotice
 * ⑰ 精确身份 dedupeKey；⑱ 摘要失败不假成功
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-26
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { NoticeBridgeService } from './notice-bridge.service';
import { ReminderCatchupService } from './reminder-catchup.service';

function rowOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenant_id: 't1',
    title: '客户回访',
    owner: 'user:7',
    participants: 'user:8',
    start_at: '2026-10-25T10:00:00.000Z',
    remind_at: '2026-10-25T09:00:00.000Z',
    ...over,
  };
}

const DAY_10AM = new Date('2026-10-25T02:00:00.000Z'); // 10:00 CST 非安静
const NIGHT_11PM = new Date('2026-10-25T15:00:00.000Z'); // 23:00 CST 安静

interface HarnessOpts {
  rows?: Array<Record<string, unknown>>;
  notice?: 'ok' | 'fail' | 'dedupe';
  pushOk?: boolean;
  realBridge?: boolean;
  /** 初始 reminded_at（null=模拟"入箱后崩溃窗口"未写标记） */
  remindedAt?: Date | null;
}

/**
 * 真实组合保真 harness：
 * - 真实 NoticeBridgeService（recordNoticeOnly ⇒ 内部调 mock notice.record）
 * - mock ProactivePushService.push
 * - 内存化投递表 + reminded_at 状态（可中途篡改以模拟崩溃窗口）
 */
function createHarness(opts: HarnessOpts = {}) {
  const rows = opts.rows ?? [];
  const noticeMode = opts.notice ?? 'ok';
  const pushOk = opts.pushOk ?? true;

  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const delivery = new Map<string, string>(); // 身份键 -> status
  const digestSent = new Set<string>();
  const reminded = new Map<string, boolean>();
  rows.forEach((r) => reminded.set(String(r.id), opts.remindedAt !== null));

  const occOf = (r: Record<string, unknown>): string =>
    new Date(String(r.remind_at)).toISOString();
  const dKey = (r: Record<string, unknown>, kind: string): string =>
    `${String(r.tenant_id)}:${String(r.id)}:${occOf(r)}:${kind}`;
  /** push 终态 = success 或 skipped（F2 收口：skipped 不再被扫描） */
  const pushDone = (st: string | undefined): boolean =>
    st === 'success' || st === 'skipped';

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    sqls.push({ sql, params });
    // 阶段 0：崩溃窗口补写（SELECT s.id ... WHERE EXISTS ... reminded_at IS NULL）
    if (
      sql.includes('SELECT s.id') &&
      sql.includes('WHERE EXISTS') &&
      sql.includes('reminded_at IS NULL')
    ) {
      const orphans = rows.filter(
        (r) =>
          delivery.get(dKey(r, 'notice')) === 'success' &&
          reminded.get(String(r.id)) !== true,
      );
      return Promise.resolve(orphans.map((r) => ({ id: r.id })));
    }
    if (sql.includes('FROM t_ai_schedule s') && sql.includes('NOT EXISTS')) {
      return Promise.resolve(
        rows.filter((r) => {
          const noticeOk = delivery.get(dKey(r, 'notice')) === 'success';
          return !noticeOk || !pushDone(delivery.get(dKey(r, 'push')));
        }),
      );
    }
    if (sql.includes('FROM t_ai_reminder_delivery') && sql.includes('COUNT')) {
      const [tenant, sid, occ, kind] = params as string[];
      const st = delivery.get(
        `${tenant}:${sid}:${new Date(occ).toISOString()}:${kind}`,
      );
      const done = kind === 'push' ? pushDone(st) : st === 'success';
      return Promise.resolve([{ c: done ? 1 : 0 }]);
    }
    if (sql.includes('FROM t_ai_reminder_digest_sent')) {
      const [tenant, batchKey] = params as string[];
      return Promise.resolve([
        { c: digestSent.has(`${tenant}:${batchKey}`) ? 1 : 0 },
      ]);
    }
    if (sql.includes('INSERT INTO t_ai_reminder_delivery')) {
      const [tenant, sid, occ, kind, status] = params;
      delivery.set(
        `${String(tenant)}:${String(sid)}:${new Date(
          String(occ),
        ).toISOString()}:${String(kind)}`,
        String(status),
      );
      return Promise.resolve([]);
    }
    if (sql.includes('INSERT INTO t_ai_reminder_digest_sent')) {
      const [tenant, batchKey] = params;
      digestSent.add(`${String(tenant)}:${String(batchKey)}`);
      return Promise.resolve([]);
    }
    if (sql.includes('UPDATE t_ai_schedule SET reminded_at')) {
      reminded.set(String(params[1]), true);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  const noticeRecord = jest.fn(() => {
    if (noticeMode === 'fail') {
      return Promise.resolve({ inserted: false, error: 'notice table down' });
    }
    if (noticeMode === 'dedupe') {
      return Promise.resolve({ inserted: false, deduped: true });
    }
    return Promise.resolve({ inserted: true, noticeId: 'n1' });
  });

  const push = jest.fn(() => Promise.resolve(pushOk));

  // 🔴 真实 NoticeBridgeService（非 mock）
  const realBridge = new NoticeBridgeService(
    { record: noticeRecord } as never,
    { push } as never,
  );

  const service = new ReminderCatchupService(
    { query } as never,
    { push } as never,
    opts.realBridge === false ? undefined : realBridge,
  );

  return { service, query, push, noticeRecord, sqls, delivery, reminded };
}

/** 取某次 push 调用的消息体 */
function digestOf(
  h: ReturnType<typeof createHarness>,
  i: number,
): {
  title: string;
  content: string;
  targetUserId?: number;
} {
  return (h.push.mock.calls[i] as unknown[])[2] as never;
}

/** 取某次 push 调用的 tenant（第 1 参数） */
function tenantOf(h: ReturnType<typeof createHarness>, i: number): string {
  return (h.push.mock.calls[i] as unknown[])[0] as string;
}

describe('ReminderCatchupService（AI-P2-3F2 · 摘要闭合与安静收口）', () => {
  it('①【M1 靶点】>3 摘要成功后：每条幂等写 push=success ⇒ 下轮扫到 0', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `提醒${i + 1}` }),
    );
    const h = createHarness({ rows });

    const r1 = await h.service.catchup(DAY_10AM);
    expect(r1.digests).toBe(1); // 同 owner ⇒ 1 组 1 条摘要

    // 🔴 返工点 1：摘要成功后本批每条都写 push=success
    for (let i = 1; i <= 5; i += 1) {
      expect(h.delivery.get(`t1:${i}:2026-10-25T09:00:00.000Z:push`)).toBe(
        'success',
      );
    }

    // 🔴 硬验收 1：下一次 catchup 扫到的本批行为 0
    const r2 = await h.service.catchup(DAY_10AM);
    expect(r2.scanned).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(1); // 不重复发
  });

  it('②【M2 靶点】两 owner 分组定向：摘要含 targetUserId 且不泄露对方标题', async () => {
    const rows = [
      rowOf({ id: 1, owner: 'user:7', title: 'A的保密合同' }),
      rowOf({ id: 2, owner: 'user:7', title: 'A的巡检' }),
      rowOf({ id: 3, owner: 'user:8', title: 'B的裁员名单' }),
      rowOf({ id: 4, owner: 'user:8', title: 'B的报价' }),
      rowOf({ id: 5, owner: 'user:8', title: 'B的回款' }),
    ];
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    // 5 条 >3 ⇒ 按 owner 分组 = 2 条摘要（各一条，非租户广播）
    expect(r.digests).toBe(2);
    expect(h.push).toHaveBeenCalledTimes(2);
    const d0 = digestOf(h, 0);
    const d1 = digestOf(h, 1);
    // 🔴 必须定向（无 targetUserId = 退回租户广播 = M2 红）
    expect([d0.targetUserId, d1.targetUserId].sort()).toEqual([7, 8]);
    const o7 = d0.targetUserId === 7 ? d0 : d1;
    const o8 = d0.targetUserId === 8 ? d0 : d1;
    // 🔴 内容隔离：各只含自己的标题
    expect(o7.content).toContain('A的保密合同');
    expect(o7.content).not.toContain('B的裁员名单');
    expect(o8.content).toContain('B的裁员名单');
    expect(o8.content).not.toContain('A的保密合同');
    // 各组条数如实（user:7 两条 / user:8 三条）
    expect(o7.title).toContain('2');
    expect(o8.title).toContain('3');
    // 通知仍逐条独立入箱（不因摘要而少一条）
    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
  });

  for (const n of [1, 3, 4]) {
    it(`③【M3 靶点】quiet 后 ${n} 条：恢复首轮只发 1 条汇总（不逐条推）`, async () => {
      const rows = Array.from({ length: n }, (_, i) =>
        rowOf({ id: i + 1, title: `提醒${i + 1}` }),
      );
      const h = createHarness({ rows });

      // 安静时段：入箱 + 0 推送
      const rq = await h.service.catchup(NIGHT_11PM);
      expect(rq.quiet).toBe(true);
      expect(rq.pushed).toBe(0);
      expect(h.push).toHaveBeenCalledTimes(0);
      expect(h.noticeRecord).toHaveBeenCalledTimes(n);

      // 恢复后首轮：这 n 条变成 pending ⇒ **只 1 条汇总**
      const r2 = await h.service.catchup(DAY_10AM);
      // 🔴 返工点 4：1/3/4 条均不得逐条推（逐条 = M3 红）
      expect(h.push).toHaveBeenCalledTimes(1);
      expect(r2.digests).toBe(1);
      expect(r2.pushed).toBe(0);
      expect(digestOf(h, 0).content).toContain('通知中心');

      // 第三轮：已闭合 ⇒ 0
      const r3 = await h.service.catchup(DAY_10AM);
      expect(r3.scanned).toBe(0);
    });
  }

  it('④ 同批连续 cron 只发一次；新批成员变化 ⇒ 独立摘要不含旧闭合条目', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      rowOf({ id: i + 1, title: `旧${i + 1}` }),
    );
    const h = createHarness({ rows });
    for (let i = 0; i < 5; i += 1) {
      await h.service.catchup(DAY_10AM);
    }
    // 🔴 连续 5 次只成功发 1 次
    expect(h.push).toHaveBeenCalledTimes(1);

    // 新批（多出 id=5）⇒ 成员指纹变化 ⇒ 重新汇总
    const rows2 = [...rows, rowOf({ id: 5, title: '新5' })];
    const h2 = createHarness({ rows: rows2 });
    await h2.service.catchup(DAY_10AM);
    expect(h2.push).toHaveBeenCalledTimes(1);
    // 新摘要按 5 条计（本批成员），旧批次不会重复推送
    expect(digestOf(h2, 0).title).toContain('5');
  });

  it('⑤【M4 靶点】notice 已 success 但 reminded_at=null ⇒ 幂等补写', async () => {
    const rows = [rowOf({ id: 1 })];
    const h = createHarness({ rows });

    const r1 = await h.service.catchup(DAY_10AM);
    expect(r1.recorded).toBe(1);
    expect(h.reminded.get('1')).toBe(true);

    // 模拟崩溃窗口：通知已入箱（delivery=success），但 reminded_at 丢了
    h.reminded.set('1', false);
    const before = h.sqls.filter((s) =>
      s.sql.includes('UPDATE t_ai_schedule SET reminded_at'),
    ).length;

    await h.service.catchup(DAY_10AM);
    const after = h.sqls.filter((s) =>
      s.sql.includes('UPDATE t_ai_schedule SET reminded_at'),
    ).length;

    // 🔴 返工点 5：必须再次补写（不补 = M4 红）
    expect(after).toBeGreaterThan(before);
    expect(h.reminded.get('1')).toBe(true);
    // 通知不重复插入（notice 已 success ⇒ 走补写分支）
    expect(h.noticeRecord).toHaveBeenCalledTimes(1);
  });

  it('⑤b【漏洞锁死】push 也已闭合（条目不再入选）时，reminded_at 仍必须被补写', async () => {
    // 场景：通知入箱 + 摘要推送都成功（本批闭合 ⇒ collectAllDue 不再返回该行），
    // 但 reminded_at 因崩溃窗口为 NULL。
    // 若补写只挂在"该条目还会被扫到"的路径上 ⇒ 标记永久丢失。
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });

    const r1 = await h.service.catchup(DAY_10AM);
    expect(r1.digests).toBe(1); // >3 ⇒ 摘要，本批闭合
    // 确认本批已闭合：每条 notice 与 push 都 success
    for (let i = 1; i <= 5; i += 1) {
      const base = `t1:${i}:2026-10-25T09:00:00.000Z`;
      expect(h.delivery.get(`${base}:notice`)).toBe('success');
      expect(h.delivery.get(`${base}:push`)).toBe('success');
    }

    // 模拟崩溃窗口：reminded_at 全部回到 NULL（条目仍处"已闭合"状态）
    for (let i = 1; i <= 5; i += 1) h.reminded.set(String(i), false);

    // 下一轮：这些行不会被 collectAllDue 选中（已闭合），但阶段 0 必须补写
    const r2 = await h.service.catchup(DAY_10AM);
    expect(r2.scanned).toBe(0); // 证明确实"不再入选"

    // 🔴 承重断言：尽管如此，reminded_at 仍被幂等补写（否则该标记永久丢失）
    for (let i = 1; i <= 5; i += 1) {
      expect(h.reminded.get(String(i))).toBe(true);
    }
  });

  it('⑥ 不可定向 owner ⇒ push=skipped 收口（绝不广播、不再重扫）', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      rowOf({ id: i + 1, owner: 'employee:e9', title: `员工任务${i + 1}` }),
    );
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    // 🔴 红线：不得用租户广播承载个人日程标题 ⇒ 零推送
    expect(h.push).toHaveBeenCalledTimes(0);
    expect(r.digests).toBe(0);
    // 每条标 skipped（终态）
    for (let i = 1; i <= 4; i += 1) {
      expect(h.delivery.get(`t1:${i}:2026-10-25T09:00:00.000Z:push`)).toBe(
        'skipped',
      );
    }
    // 通知仍逐条入箱（skipped 不抹掉站内通知本体）
    expect(h.noticeRecord).toHaveBeenCalledTimes(4);
    // 下轮扫到 0（skipped 是终态，不每分钟重推）
    const r2 = await h.service.catchup(DAY_10AM);
    expect(r2.scanned).toBe(0);
  });

  // ─────────── B1/B2/B3/B5 保留 ───────────

  it('⑦ B1 保留：quiet 5 条 ⇒ notice 5 / push 0', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });
    const r = await h.service.catchup(NIGHT_11PM);
    expect(r.quiet).toBe(true);
    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
    expect(h.push).toHaveBeenCalledTimes(0);
  });

  it('⑧ B2 保留：非 quiet 新入箱 >3 ⇒ 一条摘要（不逐条）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });
    const r = await h.service.catchup(DAY_10AM);
    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r.pushed).toBe(0);
    expect(r.digests).toBe(1);
  });

  it('⑨ B1/B2 保留：非 quiet 新入箱 ≤3 ⇒ 逐条即时推送', async () => {
    const rows = [rowOf({ id: 1 }), rowOf({ id: 2 }), rowOf({ id: 3 })];
    const h = createHarness({ rows });
    const r = await h.service.catchup(DAY_10AM);
    expect(h.noticeRecord).toHaveBeenCalledTimes(3);
    expect(h.push).toHaveBeenCalledTimes(3);
    expect(r.pushed).toBe(3);
    expect(r.digests).toBe(0);
  });

  it('⑩ B3 保留：通知落库失败 ⇒ 不写 reminded_at、不推送、下轮重试', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })], notice: 'fail' });
    const r = await h.service.catchup(DAY_10AM);
    expect(r.recorded).toBe(0);
    expect(r.noticeFailed).toBe(1);
    expect(
      h.sqls.filter((s) =>
        s.sql.includes('UPDATE t_ai_schedule SET reminded_at'),
      ),
    ).toHaveLength(0);
    expect(h.push).toHaveBeenCalledTimes(0);
    expect(h.delivery.get('t1:1:2026-10-25T09:00:00.000Z:notice')).toBe(
      'failed',
    );
  });

  it('⑪ B5 保留：真实 bridge 链路 ⇒ push 失败通知不丢、不重复插入', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })], pushOk: false });
    await h.service.catchup(DAY_10AM);
    expect(h.noticeRecord).toHaveBeenCalledTimes(1);
    await h.service.catchup(DAY_10AM); // 重试 push
    expect(h.noticeRecord).toHaveBeenCalledTimes(1); // 通知未重复
    expect(h.push).toHaveBeenCalledTimes(2); // 两轮各一次
  });

  it('⑫ 100 条全部补回且闭合（同 owner ⇒ 1 条摘要；下轮 0）', async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      rowOf({ id: i + 1, owner: 'user:7' }),
    );
    const h = createHarness({ rows });
    const r = await h.service.catchup(DAY_10AM);
    expect(r.scanned).toBe(100);
    expect(r.recorded).toBe(100);
    expect(h.noticeRecord).toHaveBeenCalledTimes(100);
    expect(h.push).toHaveBeenCalledTimes(1);
    const r2 = await h.service.catchup(DAY_10AM);
    expect(r2.scanned).toBe(0);
  });

  it('⑬ 跨租户分组隔离：同名 owner 不同租户不合组、摘要 tenant 正确', async () => {
    // 🔴 remind_at 各异（身份键 = tenant:schedule:occurrence ⇒ 同 occurrence
    //    会让 mock 的状态互相污染，用例可能假绿 —— 这里刻意错开）
    const rows = [
      rowOf({
        id: 1,
        tenant_id: 'tA',
        owner: 'user:7',
        title: 'A店盘点',
        remind_at: '2026-10-25T09:00:00.000Z',
      }),
      rowOf({
        id: 2,
        tenant_id: 'tB',
        owner: 'user:7',
        title: 'B店盘点',
        remind_at: '2026-10-25T09:01:00.000Z',
      }),
      rowOf({
        id: 3,
        tenant_id: 'tA',
        owner: 'user:7',
        title: 'A店调拨',
        remind_at: '2026-10-25T09:02:00.000Z',
      }),
      rowOf({
        id: 4,
        tenant_id: 'tA',
        owner: 'user:7',
        title: 'A店对账',
        remind_at: '2026-10-25T09:03:00.000Z',
      }),
      rowOf({
        id: 5,
        tenant_id: 'tB',
        owner: 'user:7',
        title: 'B店对账',
        remind_at: '2026-10-25T09:04:00.000Z',
      }),
    ];
    const h = createHarness({ rows });
    const r = await h.service.catchup(DAY_10AM);

    // 同 owner 但不同租户 ⇒ 必须分成两组（否则跨租户泄漏标题）
    expect(r.digests).toBe(2);
    expect(h.push).toHaveBeenCalledTimes(2);
    const t0 = tenantOf(h, 0);
    const t1 = tenantOf(h, 1);
    expect(new Set([t0, t1])).toEqual(new Set(['tA', 'tB']));
    const aIdx = t0 === 'tA' ? 0 : 1;
    const bIdx = t0 === 'tB' ? 0 : 1;
    const aDigest = digestOf(h, aIdx);
    const bDigest = digestOf(h, bIdx);
    expect(aDigest.content).toContain('A店盘点');
    expect(aDigest.content).not.toContain('B店盘点');
    expect(bDigest.content).toContain('B店盘点');
    expect(bDigest.content).not.toContain('A店盘点');
    // A 组 3 条 / B 组 2 条
    expect(aDigest.title).toContain('3');
    expect(bDigest.title).toContain('2');
    // 🔴 通知按各自租户落库（不串）
    const noticeTenants = h.noticeRecord.mock.calls.map(
      (c) => (c as unknown[])[0] as { tenantId: string },
    );
    expect(noticeTenants.map((x) => x.tenantId).sort()).toEqual([
      'tA',
      'tA',
      'tA',
      'tB',
      'tB',
    ]);
  });

  it('⑭ AI 只读查询零写操作（不得删/改原始提醒）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => rowOf({ id: i + 1 }));
    const sqls: string[] = [];
    const query = jest.fn((sql: string) => {
      sqls.push(sql);
      return Promise.resolve(rows);
    });
    const service = new ReminderCatchupService(
      { query } as never,
      { push: jest.fn() } as never,
      undefined,
    );
    const r = await service.summarizeBacklog('t1', DAY_10AM);
    expect(r.total).toBe(5);
    expect(r.urgent).toHaveLength(3);
    expect(r.summary).toContain('通知中心');
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('SELECT');
    expect(sqls[0]).not.toContain('UPDATE');
    expect(sqls[0]).not.toContain('DELETE');
    expect(sqls[0]).not.toContain('INSERT');
  });

  it('⑮ recurrence 继续 BLOCKED（实体无字段，不自造）', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/database/entities/ai-schedule.entity.ts'),
      'utf8',
    );
    expect(
      /@Column\([^)]*\)[\s\S]{0,200}?\brecurrence\w*\s*!?\s*:/.test(src),
    ).toBe(false);
  });

  it('⑯ 结构禁 pushWithNotice（B5 保留）+ 复用既有通道', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/brain/proactive/reminder-catchup.service.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).not.toContain('pushWithNotice');
    expect(src).toContain('recordNoticeOnly');
    expect(src).toContain('ProactivePushService');
    expect(src).not.toContain('new WebSocket');
    expect(src).not.toContain('axios');
  });

  it('⑰ dedupeKey 用精确身份（tenant:schedule:occurrence:kind，禁 title）', async () => {
    const rows = [
      rowOf({ id: 11, title: '同名' }),
      rowOf({ id: 22, title: '同名' }),
      rowOf({ id: 33, title: '同名' }),
      rowOf({ id: 44, title: '同名' }),
    ];
    const h = createHarness({ rows });
    await h.service.catchup(DAY_10AM);
    const keys = h.noticeRecord.mock.calls
      .map((c) => (c as unknown[])[0] as { dedupeKey: string })
      .map((o) => o.dedupeKey);
    expect(keys).toEqual([
      't1:11:2026-10-25T09:00:00.000Z:notice',
      't1:22:2026-10-25T09:00:00.000Z:notice',
      't1:33:2026-10-25T09:00:00.000Z:notice',
      't1:44:2026-10-25T09:00:00.000Z:notice',
    ]);
  });

  it('⑱ 摘要推送失败 ⇒ 不写 push=success（不假成功，下轮重试）', async () => {
    const rows = Array.from({ length: 4 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows, pushOk: false });
    const r = await h.service.catchup(DAY_10AM);
    expect(r.digests).toBe(0);
    for (let i = 1; i <= 4; i += 1) {
      const st = h.delivery.get(`t1:${i}:2026-10-25T09:00:00.000Z:push`);
      expect(st).not.toBe('success');
    }
    // 通知仍全部入箱（推送失败不掩盖通知成功）
    expect(h.noticeRecord).toHaveBeenCalledTimes(4);
  });

  it('⑲ 查询抛错 ⇒ 不外抛（@Cron 异常隔离）', async () => {
    const service = new ReminderCatchupService(
      { query: jest.fn(() => Promise.reject(new Error('DB down'))) } as never,
      { push: jest.fn() } as never,
      undefined,
    );
    await expect(service.catchup(DAY_10AM)).resolves.toMatchObject({
      scanned: 0,
    });
  });

  it('⑳ dedupe 命中（已在箱内）不算失败、不重复推送', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })], notice: 'dedupe' });
    const r = await h.service.catchup(NIGHT_11PM);
    expect(r.noticeFailed).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(0);
  });
});
