/**
 * ReminderCatchupService 测试（AI-P2-3F1 · 通知落库与推送分层分离）
 *
 * ═══════════════════════════════════════════════════════════════
 * 🔴 本版测试的保真原则（针对 P2-3 的 B5 驳回）
 * ═══════════════════════════════════════════════════════════════
 * 旧版把 `noticeBridge.pushWithNotice` 与 `pushService.push` 当作**互不相干的两个 mock**，
 * 而真实 `pushWithNotice` 内部会调用 push ⇒ quiet 与 >3 场景全是假绿。
 *
 * 本版用**真实 `NoticeBridgeService` 实例**：
 *   真实 NoticeBridgeService + mock NoticeService(record) + mock ProactivePushService(push)
 * ⇒ "落库"与"推送"的真实调用链被完整跑通，断言的是真实次数。
 *
 * 覆盖（对应派单卡 §二.5）：
 * ① quiet 5 条：notice 5 / push 0
 * ② >3：notice N / push 1（仅摘要）
 * ③ 通知失败 + push 成功：不得写 reminded_at，下轮重试
 * ④ 通知成功 + push 失败：通知保留、push 重试、通知不重复
 * ⑤ 同名不同 scheduleId 的精确归集
 * ⑥ 摘要幂等：连续 100 次只成功推 1 次
 * ⑦ 1/3/100 条分层；⑧ 跨租户；⑨ quiet 边界；⑩ recurrence BLOCKED；⑪ 异常隔离
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-25
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { NoticeBridgeService } from './notice-bridge.service';
import { ReminderCatchupService } from './reminder-catchup.service';

/** 构造一行到期未提醒的日程 */
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

/** 固定时间点（Asia/Shanghai） */
const DAY_10AM = new Date('2026-10-25T02:00:00.000Z'); // 10:00 非安静
const NIGHT_11PM = new Date('2026-10-25T15:00:00.000Z'); // 23:00 安静

interface HarnessOpts {
  rows?: Array<Record<string, unknown>>;
  /** NoticeService.record 的行为 */
  notice?: 'ok' | 'fail' | 'dedupe';
  /** push 返回 */
  pushOk?: boolean;
  /** 是否使用真实 NoticeBridgeService（默认 true） */
  realBridge?: boolean;
}

/**
 * 真实组合保真 harness：
 * - 真实 NoticeBridgeService 实例（其 recordNoticeOnly 内部调 mock NoticeService.record）
 * - mock ProactivePushService.push（真实被 bridge 或 service 调用）
 * - mock DataSource（记录 SQL：投递状态读写、reminded_at 更新）
 */
function createHarness(opts: HarnessOpts = {}) {
  const rows = opts.rows ?? [];
  const noticeMode = opts.notice ?? 'ok';
  const pushOk = opts.pushOk ?? true;

  const sqls: Array<{ sql: string; params: unknown[] }> = [];
  const delivery = new Map<string, string>(); // dedupeKey -> status
  const digestSent = new Set<string>();

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    sqls.push({ sql, params });
    // 到期扫描：与真实 SQL 的过滤语义一致 ——
    // notice 未 success **或** push 未 success 的条目都应入选（后者用于 push 重试）
    if (sql.includes('FROM t_ai_schedule s') && sql.includes('NOT EXISTS')) {
      const pending = rows.filter((r) => {
        const base = `${String(r.tenant_id)}:${String(r.id)}:${new Date(
          String(r.remind_at),
        ).toISOString()}`;
        const noticeOk = delivery.get(`${base}:notice`) === 'success';
        const pushOk = delivery.get(`${base}:push`) === 'success';
        return !noticeOk || !pushOk;
      });
      return Promise.resolve(pending);
    }
    if (sql.includes('FROM t_ai_reminder_delivery') && sql.includes('COUNT')) {
      const [tenant, sid, occ, kind] = params as string[];
      const key = `${tenant}:${sid}:${new Date(occ).toISOString()}:${kind}`;
      return Promise.resolve([{ c: delivery.get(key) === 'success' ? 1 : 0 }]);
    }
    if (sql.includes('FROM t_ai_reminder_digest_sent')) {
      const [tenant, batchKey] = params as string[];
      return Promise.resolve([
        { c: digestSent.has(`${tenant}:${batchKey}`) ? 1 : 0 },
      ]);
    }
    if (sql.includes('INSERT INTO t_ai_reminder_delivery')) {
      const [tenant, sid, occ, kind, status] = params;
      const key = `${String(tenant)}:${String(sid)}:${new Date(
        String(occ),
      ).toISOString()}:${String(kind)}`;
      delivery.set(key, String(status));
      return Promise.resolve([]);
    }
    if (sql.includes('INSERT INTO t_ai_reminder_digest_sent')) {
      const [tenant, batchKey] = params;
      digestSent.add(`${String(tenant)}:${String(batchKey)}`);
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });

  // mock NoticeService.record（真实 bridge 内部会调用它）
  const noticeRecord = jest.fn((input: Record<string, unknown>) => {
    if (noticeMode === 'fail') {
      return Promise.resolve({ inserted: false, error: 'notice table down' });
    }
    if (noticeMode === 'dedupe') {
      return Promise.resolve({ inserted: false, deduped: true });
    }
    void input;
    return Promise.resolve({ inserted: true, noticeId: 'n1' });
  });

  // mock ProactivePushService.push
  const push = jest.fn(() => Promise.resolve(pushOk));

  // 🔴 真实 NoticeBridgeService（不是 mock）
  const realBridge = new NoticeBridgeService(
    { record: noticeRecord } as never,
    { push } as never,
  );

  const bridge = opts.realBridge === false ? undefined : realBridge;

  const service = new ReminderCatchupService(
    { query } as never,
    { push } as never,
    bridge,
  );

  return { service, query, push, noticeRecord, realBridge, sqls, delivery };
}

describe('ReminderCatchupService（AI-P2-3F1 · 落库与推送分离）', () => {
  it('① quiet 5 条：notice 5 / push 0（真实 bridge 组合语义）', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `提醒${i + 1}` }),
    );
    const h = createHarness({ rows });

    const r = await h.service.catchup(NIGHT_11PM);

    expect(r.quiet).toBe(true);
    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
    expect(r.recorded).toBe(5);
    // 🔴 推送严格 0（旧实现此处为 5 = B1 的正面反证）
    expect(h.push).toHaveBeenCalledTimes(0);
    expect(r.pushed).toBe(0);
  });

  it('② >3 条（5 条）：notice 5 / push 1（仅摘要），禁止逐条单推', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `提醒${i + 1}` }),
    );
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
    expect(r.recorded).toBe(5);
    // 🔴 推送严格 1（旧实现是 5+1=6 = B2 的正面反证）
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r.pushed).toBe(0);
    expect(r.digests).toBe(1);
    const digest = (h.push.mock.calls[0] as unknown[])[2] as {
      title: string;
    };
    expect(digest.title).toContain('5');
  });

  it('②b ≤3 条（3 条）：notice 3 / push 3（逐条单推，无摘要）', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    expect(h.noticeRecord).toHaveBeenCalledTimes(3);
    expect(h.push).toHaveBeenCalledTimes(3);
    expect(r.pushed).toBe(3);
    expect(r.digests).toBe(0);
  });

  it('②c 1 条：notice 1 / push 1', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })] });
    const r = await h.service.catchup(DAY_10AM);
    expect(h.noticeRecord).toHaveBeenCalledTimes(1);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r.pushed).toBe(1);
  });

  it('③ 通知落库失败 + push 成功：不得写 reminded_at，下轮重试', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })], notice: 'fail' });

    const r = await h.service.catchup(DAY_10AM);

    expect(r.recorded).toBe(0);
    expect(r.noticeFailed).toBe(1);
    // 🔴 不得写完成标记
    const updates = h.sqls.filter((s) =>
      s.sql.includes('UPDATE t_ai_schedule SET reminded_at'),
    );
    expect(updates).toHaveLength(0);
    // 🔴 push 成功与否都不能掩盖通知失败 ⇒ 通知失败不做推送分层
    expect(h.push).toHaveBeenCalledTimes(0);
    // 投递状态记为 failed
    const entries = Array.from(h.delivery.entries());
    expect(
      entries.some(([k, v]) => k.endsWith(':notice') && v === 'failed'),
    ).toBe(true);
  });

  it('④ 通知成功 + push 失败：通知保留、下轮重试 push、通知不重复插入', async () => {
    const h = createHarness({
      rows: [rowOf({ id: 1 })],
      pushOk: false,
    });

    const r1 = await h.service.catchup(DAY_10AM);
    expect(r1.recorded).toBe(1);
    expect(r1.pushed).toBe(0);

    const r2 = await h.service.catchup(DAY_10AM);
    // 🔴 通知不重复（真实 bridge 的 record 只被调 1 次）
    expect(h.noticeRecord).toHaveBeenCalledTimes(1);
    expect(r2.recorded).toBe(0);
    // push 维度未 success ⇒ 两轮各尝试一次
    expect(h.push).toHaveBeenCalledTimes(2);
  });

  it('⑤ 同名不同 scheduleId：按 (scheduleId, occurrenceAt) 精确归集，不互相冒充', async () => {
    const rows = [
      rowOf({ id: 11, title: '客户回访' }),
      rowOf({ id: 22, title: '客户回访' }),
      rowOf({ id: 33, title: '客户回访' }),
      rowOf({ id: 44, title: '客户回访' }),
    ];
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    expect(h.noticeRecord).toHaveBeenCalledTimes(4);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r.digests).toBe(1);
    // dedupeKey 含各自 scheduleId（不是 title）
    const keys = Array.from(h.delivery.keys());
    expect(keys.filter((k) => k.endsWith(':notice'))).toHaveLength(4);
    for (const id of [11, 22, 33, 44]) {
      expect(keys.some((k) => k.includes(`:${id}:`))).toBe(true);
    }
  });

  it('⑥ 摘要幂等：连续扫描 100 次只成功推 1 次', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `提醒${i + 1}` }),
    );
    const h = createHarness({ rows });

    for (let i = 0; i < 100; i += 1) {
      await h.service.catchup(DAY_10AM);
    }

    // 🔴 摘要只推 1 次（digest_sent 幂等表承重）
    expect(h.push).toHaveBeenCalledTimes(1);
    // 通知也只 5 次（已 success 不再入选）
    expect(h.noticeRecord).toHaveBeenCalledTimes(5);
  });

  it('⑦ 100 条全部补回（分批扫尽，不设"只补最近 N 条"）', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });

    const r = await h.service.catchup(DAY_10AM);

    expect(r.scanned).toBe(100);
    expect(r.recorded).toBe(100);
    expect(h.noticeRecord).toHaveBeenCalledTimes(100);
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it('⑧ 跨租户隔离：各条按自身 tenant 入箱，不串', async () => {
    const rows = [
      rowOf({ id: 1, tenant_id: 'tA', title: 'A店' }),
      rowOf({ id: 2, tenant_id: 'tB', title: 'B店' }),
    ];
    const h = createHarness({ rows });

    await h.service.catchup(DAY_10AM);

    const tenants = h.noticeRecord.mock.calls.map(
      (c) => (c[0] as { tenantId: string }).tenantId,
    );
    expect(tenants).toEqual(['tA', 'tB']);
  });

  it('⑨ quiet 判定边界（Asia/Shanghai）', () => {
    const h = createHarness();
    expect(h.service.isQuietHours(new Date('2026-10-25T14:00:00.000Z'))).toBe(
      true,
    ); // 22:00
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

  it('⑩ recurrence 继续 BLOCKED（不自造数据模型）', () => {
    const entitySource = readFileSync(
      join(process.cwd(), 'src/database/entities/ai-schedule.entity.ts'),
      'utf8',
    );
    const hasRecurrenceColumn =
      /@Column\([^)]*\)[\s\S]{0,200}?\brecurrence\w*\s*!?\s*:/.test(
        entitySource,
      );
    expect(hasRecurrenceColumn).toBe(false);
  });

  it('⑪ 查询抛错 ⇒ 不外抛（@Cron 异常隔离）', async () => {
    const service = new ReminderCatchupService(
      { query: jest.fn(() => Promise.reject(new Error('DB down'))) } as never,
      { push: jest.fn() } as never,
      undefined,
    );
    await expect(service.catchup(DAY_10AM)).resolves.toMatchObject({
      scanned: 0,
    });
  });

  // ────────── F1 增补用例（覆盖卡内剩余要求）──────────

  it('⑫ 通知幂等命中（deduped）也算"已在箱内"，不误判失败', async () => {
    const h = createHarness({ rows: [rowOf({ id: 1 })], notice: 'dedupe' });

    const r = await h.service.catchup(NIGHT_11PM);

    expect(r.noticeFailed).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(0);
  });

  it('⑬ 安静时段下 >3 条同样零推送（quiet 优先于条数分层）', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => rowOf({ id: i + 1 }));
    const h = createHarness({ rows });

    const r = await h.service.catchup(NIGHT_11PM);

    expect(h.noticeRecord).toHaveBeenCalledTimes(8);
    expect(h.push).toHaveBeenCalledTimes(0);
    expect(r.pushed).toBe(0);
    expect(r.digests).toBe(0);
    expect(r.deferred).toBe(true);
  });

  it('⑭ push 幂等：已成功推送的条目不重发（push 维度独立幂等）', async () => {
    const rows = [rowOf({ id: 1 })];
    const h = createHarness({ rows, pushOk: true });

    await h.service.catchup(DAY_10AM);
    expect(h.push).toHaveBeenCalledTimes(1);

    const r2 = await h.service.catchup(DAY_10AM);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(r2.scanned).toBe(0);
  });

  it('⑮ 摘要含"最紧急 3 条 + 引导通知中心"（商户可操作）', async () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      rowOf({ id: i + 1, title: `事项${i + 1}` }),
    );
    const h = createHarness({ rows });

    await h.service.catchup(DAY_10AM);

    const digest = (h.push.mock.calls[0] as unknown[])[2] as {
      title: string;
      content: string;
    };
    expect(digest.title).toContain('6');
    expect(digest.content).toContain('事项1');
    expect(digest.content).toContain('事项3');
    expect(digest.content).not.toContain('事项4');
    expect(digest.content).toContain('通知中心');
  });

  it('⑯ AI 只读查询：返回条数与摘要，且零写操作', async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      rowOf({ id: i + 1, title: `漏提醒${i + 1}` }),
    );
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
    expect(r.summary).toContain('5');
    expect(r.summary).toContain('通知中心');
    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toContain('SELECT');
    expect(sqls[0]).not.toContain('UPDATE');
    expect(sqls[0]).not.toContain('DELETE');
    expect(sqls[0]).not.toContain('INSERT');
  });

  it('⑰ 复用既有通道（无自建旁路）', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/brain/proactive/reminder-catchup.service.ts'),
      'utf8',
    );
    expect(src).toContain('ProactivePushService');
    expect(src).toContain('NoticeBridgeService');
    expect(src).not.toContain('new WebSocket');
    expect(src).not.toContain('axios');
  });

  it('⑱ 通知落库只走 recordNoticeOnly（结构上不得再出现 pushWithNotice）', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/brain/proactive/reminder-catchup.service.ts'),
      'utf8',
    );
    // 只看**代码行**（剔除 /** */ 块注释与 // 行注释），避免误伤"解释旧实现"的注释
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    // 🔴 结构承重：补偿器**代码**里不得调用 pushWithNotice（那会"落通知+立刻推送"）
    expect(codeOnly).not.toContain('pushWithNotice');
    expect(codeOnly).toContain('recordNoticeOnly');
  });
});
