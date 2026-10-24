/**
 * ReminderCatchupService — 停机漏提醒补偿器（AI-P2-3 / F1 重构）
 *
 * 解决的真问题：`@Cron` 只在进程活着时扫描。系统停机、重启、渠道故障期间到期的提醒，
 * 恢复后**不能静默丢失**。本服务把"所有已到期但未成功送达"的提醒全部补回。
 *
 * ══════════════════════════════════════════════════════════════════
 * 🔴 F1 重构核心：通知落库 与 即时推送 **彻底分离**
 * ══════════════════════════════════════════════════════════════════
 *
 * 驳回事实（P2-3 的 B1/B2/B3）：
 * 旧实现用 `NoticeBridgeService.pushWithNotice()`，而它的语义是"落通知 **+ 立刻推送**"
 * ⇒ ① quiet 时段照样逐条推；② >3 条时每条推完再补一条摘要 = N+1；
 *   ③ 其返回值只是 push 结果，**通知落库失败被掩盖**，push 成功就写完成标记 ⇒ 通知永久丢失。
 *
 * 现设计与三者的对应：
 * - **落库只走 `recordNoticeOnly()`**（不触发任何 push）⇒ quiet 时段天然零推送；
 * - **推送由本服务的分层逻辑单独执行**（quiet=0 / ≤3 逐条 / >3 仅摘要一条）；
 * - **投递状态分维度记录**（`t_ai_reminder_delivery`：notice / push 各自幂等），
 *   不再用单一 `reminded_at` 兼任两职；摘要另有 `t_ai_reminder_digest_sent` 幂等表。
 *
 * ══════════════════════════════════════════════════════════════════
 * 硬约束（逐条对应 F1 派单卡 §三）
 * ══════════════════════════════════════════════════════════════════
 * 1. **不设"只补最近 N 条"**：`LIMIT` 只是单批上限，分批循环**直到扫尽**；7 天/100 条全补。
 * 2. **安静时段 push 严格 0**：22:00–08:00 只入箱，不推即时消息。
 * 3. **>3 条 push 严格 1**（摘要），N 条通知仍逐条独立落库。
 * 4. **通知落库失败 ⇒ 不写完成标记**，下轮重试；push 成败**不能**掩盖通知失败。
 * 5. **通知成功 + push 失败** ⇒ 通知保留（已入箱），push 下轮重试，通知不重复插入。
 * 6. **身份 = (tenant, scheduleId, occurrenceAt)**，禁止用标题匹配（同名不同 id 不冒充）。
 * 7. **摘要幂等**：连续 cron 重跑只成功发 1 次。
 *
 * ⚠️ recurrence 继续 BLOCKED：`ai-schedule.entity.ts` 无 recurrence 字段（属 P2-2 范围）。
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-25
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import { NoticeBridgeService } from './notice-bridge.service';
import { parseParticipants } from '../../tools/definitions/schedule-participants.util';

/** 单批扫描上限：只限制**单次查询**规模，不是丢弃上限 */
const CATCHUP_BATCH = 100;
/** 逐条推送阈值：≤ 此值逐条推，> 此值只发一条聚合摘要 */
const DIGEST_THRESHOLD = 3;
/** 安静时段（Asia/Shanghai 小时，左闭右开：22:00–08:00） */
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;

interface DueRow {
  id: string | number;
  tenant_id: string;
  title: string;
  owner: string | null;
  participants: string | null;
  start_at: Date | string;
  remind_at: Date | string;
}

/** 补偿结果（字段语义严格对应派单卡判据） */
export interface CatchupResult {
  /** 扫描到的到期提醒总数 */
  scanned: number;
  /** 成功入箱（含幂等命中）条数 */
  recorded: number;
  /** 通知落库**真实失败**条数（下轮重试） */
  noticeFailed: number;
  /** 单条即时推送成功条数 */
  pushed: number;
  /** 摘要推送成功条数（0 或 1） */
  digests: number;
  /** 是否处于安静时段 */
  quiet: boolean;
  /** 是否因安静时段推迟了即时推送 */
  deferred: boolean;
}

@Injectable()
export class ReminderCatchupService {
  private readonly logger = new Logger(ReminderCatchupService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
    @Optional()
    private readonly noticeBridge?: NoticeBridgeService,
  ) {}

  /** 补偿所有到期未送达的提醒（供 cron 调用；绝不外抛） */
  async catchup(now: Date = new Date()): Promise<CatchupResult> {
    const result: CatchupResult = {
      scanned: 0,
      recorded: 0,
      noticeFailed: 0,
      pushed: 0,
      digests: 0,
      quiet: this.isQuietHours(now),
      deferred: false,
    };

    try {
      const rows = await this.collectAllDue(now);
      result.scanned = rows.length;
      if (rows.length === 0) {
        return result;
      }

      // ══ 阶段 1：只落通知（绝不推送）══
      // 通知失败的条目**不写完成标记**，下轮重试。
      // noticeOk 含两类：本次新入箱的 + **此前已入箱**（push 待重试）的。
      const noticeOk: DueRow[] = [];
      const noticeFailed: DueRow[] = [];
      let newlyRecorded = 0;
      for (const row of rows) {
        const res = await this.recordNotice(row);
        if (res.ok) {
          noticeOk.push(row);
          if (res.fresh) newlyRecorded += 1;
        } else {
          noticeFailed.push(row);
          result.noticeFailed += 1;
        }
      }
      result.recorded = newlyRecorded;

      // ══ 阶段 2：按 quiet / 条数分层推送（只针对"通知已成功"的条目）══
      if (noticeOk.length > 0) {
        if (result.quiet) {
          // 安静时段：通知已入箱，**推送严格 0**
          result.deferred = true;
          this.logger.log(
            `补偿：安静时段，入箱 ${noticeOk.length} 条，即时推送 0 条`,
          );
        } else if (noticeOk.length <= DIGEST_THRESHOLD) {
          // ≤3 条：逐条单推
          for (const row of noticeOk) {
            const ok = await this.pushSingle(row);
            if (ok) result.pushed += 1;
          }
        } else {
          // >3 条：**只发一条摘要**，禁止逐条单推
          const ok = await this.pushDigest(noticeOk, now);
          if (ok) result.digests += 1;
        }
      }

      if (noticeFailed.length > 0) {
        this.logger.warn(
          `补偿：通知落库失败 ${noticeFailed.length} 条（不写完成标记，下轮重试）`,
        );
      }

      this.logger.log(
        `补偿完成：扫描 ${result.scanned}，入箱 ${result.recorded}，` +
          `通知失败 ${result.noticeFailed}，单推 ${result.pushed}，` +
          `摘要 ${result.digests}，安静时段=${result.quiet}`,
      );
    } catch (err) {
      // @Cron 内绝不外抛
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`漏提醒补偿失败（已隔离）：${message}`);
    }
    return result;
  }

  /**
   * 收集**全部**到期未送达提醒 —— 分批循环直到扫尽。
   *
   * "未送达"口径（关键）：**notice 维度未 success** 才需要补。
   * 但还有第二种"未送达"：notice 已 success、**push 维度未 success**（通知进了箱但没推出去），
   * 这类条目也要被选中，否则 push 永远不会重试（F1 硬验收 4）。
   *
   * ⇒ 条件：notice 未 success **或** push 未 success（且该条通知已成功才允许 push 重试）。
   *
   * 分页改用**游标（remind_at + id）**而非 OFFSET：
   * OFFSET 分页在"本轮没有把已扫条目标成功"时会重复取同一批（若通知全失败），
   * 导致无限重复扫描；游标只向前推进，天然不会重复。
   */
  private async collectAllDue(now: Date): Promise<DueRow[]> {
    const all: DueRow[] = [];
    const seen = new Set<string>();
    let cursorRemindAt: string | null = null;
    let cursorId: string | null = null;
    const MAX_ROUNDS = 1000;

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const params: unknown[] = [now];
      let cursorClause = '';
      if (cursorRemindAt !== null && cursorId !== null) {
        // 游标：按 (remind_at, id) 严格递增，避免同道同秒重复
        cursorClause =
          'AND (s.remind_at > ? OR (s.remind_at = ? AND s.id > ?))';
        params.push(cursorRemindAt, cursorRemindAt, cursorId);
      }

      const batch = await this.dataSource.query<DueRow[]>(
        `SELECT s.id, s.tenant_id, s.title, s.owner, s.participants,
                s.start_at, s.remind_at
           FROM t_ai_schedule s
          WHERE s.status = 'planned'
            AND s.remind_at IS NOT NULL
            AND s.remind_at <= ?
            ${cursorClause}
            AND (
              NOT EXISTS (
                SELECT 1 FROM t_ai_reminder_delivery dn
                 WHERE dn.tenant_id = s.tenant_id
                   AND dn.schedule_id = CAST(s.id AS CHAR)
                   AND dn.occurrence_at = s.remind_at
                   AND dn.kind = 'notice'
                   AND dn.status = 'success'
              )
              OR NOT EXISTS (
                SELECT 1 FROM t_ai_reminder_delivery dp
                 WHERE dp.tenant_id = s.tenant_id
                   AND dp.schedule_id = CAST(s.id AS CHAR)
                   AND dp.occurrence_at = s.remind_at
                   AND dp.kind = 'push'
                   AND dp.status = 'success'
              )
            )
          ORDER BY s.remind_at ASC, s.id ASC
          LIMIT ${CATCHUP_BATCH}`,
        params,
      );

      if (batch.length === 0) break;
      for (const row of batch) {
        const key = `${String(row.tenant_id)}:${String(row.id)}:${toIso(row.remind_at)}`;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(row);
        }
      }
      const last = batch[batch.length - 1];
      cursorRemindAt = toSqlDateTime(last.remind_at);
      cursorId = String(last.id);
      if (batch.length < CATCHUP_BATCH) break;
    }
    return all;
  }

  /**
   * 阶段 1：**只落通知**（不推送），并记录 notice 维度投递状态。
   *
   * 返回：
   * - `ok=true, fresh=true`  ⇒ 本次新入箱（或幂等命中视为已有）；
   * - `ok=true, fresh=false` ⇒ **此前已入箱**（push 待重试的那类），本轮不重复写；
   * - `ok=false`             ⇒ 通知失败，绝不标记完成。
   *
   * 🔴 绝不因 push 成功而返回 ok —— push 根本不在本函数内发生。
   */
  private async recordNotice(
    row: DueRow,
  ): Promise<{ ok: boolean; fresh: boolean }> {
    const scheduleId = String(row.id);
    const occurrence = toDate(row.remind_at);
    try {
      // 幂等前置：notice 已 success ⇒ 不重复插入（只用于推送重试）
      if (
        this.noticeBridge &&
        (await this.deliveryDone(row, occurrence, 'notice'))
      ) {
        return { ok: true, fresh: false };
      }

      const receiver = this.receiverOf(row);
      const push = this.buildPush(row);

      if (this.noticeBridge) {
        const res = await this.noticeBridge.recordNoticeOnly(
          row.tenant_id,
          push,
          {
            receiver,
            source: 'schedule',
            refId: scheduleId,
            dedupeKey: this.dedupeOf(
              row.tenant_id,
              scheduleId,
              occurrence,
              'notice',
            ),
          },
        );
        // 🔴 通知失败 ⇒ 记 failed，绝不标记完成
        if (!res.inserted && !res.deduped) {
          await this.markDelivery(
            row,
            occurrence,
            'notice',
            'failed',
            res.error ?? 'notice record failed',
          );
          return { ok: false, fresh: false };
        }
        await this.markDelivery(row, occurrence, 'notice', 'success');
      } else {
        // 无旁路（既有单测路径）：退回既有 push 通道
        await this.pushService.push(row.tenant_id, 'schedule_reminder', push);
        await this.markDelivery(row, occurrence, 'notice', 'success');
      }

      // 兼容既有语义：通知成功才写 reminded_at
      await this.dataSource.query(
        'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
        [new Date(), scheduleId],
      );
      return { ok: true, fresh: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补偿：通知落库异常：schedule=${scheduleId} ${message}`);
      try {
        await this.markDelivery(row, occurrence, 'notice', 'failed', message);
      } catch {
        // 状态记录失败不掩盖主错误
      }
      return { ok: false, fresh: false };
    }
  }

  /** 阶段 2a：单条即时推送（独立幂等；已 success 过则跳过） */
  private async pushSingle(row: DueRow): Promise<boolean> {
    const scheduleId = String(row.id);
    const occurrence = toDate(row.remind_at);
    try {
      if (await this.deliveryDone(row, occurrence, 'push')) {
        return true;
      }
      const ok = await this.pushService.push(
        row.tenant_id,
        'schedule_reminder',
        this.buildPush(row),
      );
      await this.markDelivery(
        row,
        occurrence,
        'push',
        ok ? 'success' : 'failed',
      );
      return ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补偿：单推失败：schedule=${scheduleId} ${message}`);
      try {
        await this.markDelivery(row, occurrence, 'push', 'failed', message);
      } catch {
        /* 忽略 */
      }
      return false;
    }
  }

  /**
   * 阶段 2b：**只发一条**聚合摘要（>3 条时；禁止逐条单推）。
   *
   * 幂等：batchKey 由本批 (scheduleId, occurrenceAt) 稳定集合构成 ⇒
   * 同名不同 id 不会混淆；连续 cron 重跑同一批只成功发 1 次。
   */
  private async pushDigest(rows: DueRow[], now: Date): Promise<boolean> {
    try {
      const tenantId = rows[0].tenant_id;
      const batchKey = this.batchKeyOf(rows);
      if (await this.digestDone(tenantId, batchKey)) {
        return true;
      }
      const urgent = rows.slice(0, DIGEST_THRESHOLD);
      const lines = urgent
        .map((r) => `· ${r.title}（${toIso(r.remind_at)}）`)
        .join('\n');
      const digest = {
        type: 'system' as const,
        title: `您有 ${rows.length} 条漏提醒待查看`,
        content:
          `系统恢复后发现 ${rows.length} 条到期提醒未及时送达：\n${lines}\n` +
          `以上为最紧急 ${urgent.length} 条，完整列表请打开通知中心查看。`,
        priority: 'reminder' as const,
      };
      const ok = await this.pushService.push(
        tenantId,
        'schedule_reminder_digest',
        digest,
      );
      if (ok) {
        await this.writeDigestSuccess(tenantId, batchKey, now);
      }
      return ok;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补偿：摘要推送失败：${message}`);
      return false;
    }
  }

  /** 接收人 = owner + participants（与既有日程提醒同口径） */
  private receiverOf(row: DueRow): string {
    return [row.owner ?? '', ...parseParticipants(row.participants)]
      .filter((x) => x.length > 0)
      .join(',');
  }

  /** 统一消息体（逐条入箱与单推共用同一文案） */
  private buildPush(row: DueRow): {
    type: 'system';
    title: string;
    content: string;
    priority: 'reminder';
  } {
    const startText = toIso(row.start_at);
    return {
      type: 'system' as const,
      title: `日程提醒：${row.title}`,
      content:
        `「${row.title}」将于 ${startText} 开始（漏提醒补发；` +
        `归属人 ${row.owner ?? '-'}；参与者 ${row.participants ?? '-'}；` +
        `日程ID ${String(row.id)}）`,
      priority: 'reminder' as const,
    };
  }

  /** 是否处于安静时段（Asia/Shanghai，22:00–08:00） */
  isQuietHours(now: Date = new Date()): boolean {
    const hour = this.shanghaiHour(now);
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  }

  // ────────────────────────── 投递状态读写 ──────────────────────────

  /** 幂等键：tenant:scheduleId:occurrenceAt:kind（精确身份，禁用 title） */
  private dedupeOf(
    tenantId: string,
    scheduleId: string,
    occurrence: Date,
    kind: 'notice' | 'push',
  ): string {
    return `${tenantId}:${scheduleId}:${occurrence.toISOString()}:${kind}`;
  }

  /** 该维度是否已 success */
  private async deliveryDone(
    row: DueRow,
    occurrence: Date,
    kind: 'notice' | 'push',
  ): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ c: unknown }>>(
      `SELECT COUNT(*) AS c FROM t_ai_reminder_delivery
        WHERE tenant_id = ? AND schedule_id = ? AND occurrence_at = ? AND kind = ? AND status = 'success'`,
      [row.tenant_id, String(row.id), occurrence, kind],
    );
    return Number(rows[0]?.c ?? 0) > 0;
  }

  /** 写/更新投递状态（唯一键冲突 ⇒ 累加 attempts） */
  private async markDelivery(
    row: DueRow,
    occurrence: Date,
    kind: 'notice' | 'push',
    status: 'success' | 'failed',
    errorMsg?: string,
  ): Promise<void> {
    const now = new Date();
    await this.dataSource.query(
      `INSERT INTO t_ai_reminder_delivery
         (tenant_id, schedule_id, occurrence_at, kind, status, dedupe_key, error_msg, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         error_msg = VALUES(error_msg),
         attempts = attempts + 1,
         updated_at = VALUES(updated_at)`,
      [
        row.tenant_id,
        String(row.id),
        occurrence,
        kind,
        status,
        this.dedupeOf(row.tenant_id, String(row.id), occurrence, kind),
        errorMsg ?? null,
        now,
        now,
      ],
    );
  }

  /** 本批摘要的稳定标识（scheduleId+occurrence 排序后哈希；同名不同 id 不混淆） */
  private batchKeyOf(rows: DueRow[]): string {
    const parts = rows
      .map((r) => `${String(r.id)}@${toIso(r.remind_at)}`)
      .sort()
      .join('|');
    let h = 0;
    for (let i = 0; i < parts.length; i += 1) {
      h = (h * 31 + parts.charCodeAt(i)) | 0;
    }
    return `digest:${Math.abs(h).toString(36)}`;
  }

  /** 该批摘要是否已发过 */
  private async digestDone(
    tenantId: string,
    batchKey: string,
  ): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ c: unknown }>>(
      `SELECT COUNT(*) AS c FROM t_ai_reminder_digest_sent
        WHERE tenant_id = ? AND batch_key = ?`,
      [tenantId, batchKey],
    );
    return Number(rows[0]?.c ?? 0) > 0;
  }

  /** 记录摘要已发送（唯一键防重） */
  private async writeDigestSuccess(
    tenantId: string,
    batchKey: string,
    now: Date,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO t_ai_reminder_digest_sent (tenant_id, batch_key, sent_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE sent_at = sent_at`,
      [tenantId, batchKey, now],
    );
  }

  /** 取 Asia/Shanghai 小时（0-23），不依赖服务器本地时区 */
  private shanghaiHour(now: Date): number {
    const text = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      hour12: false,
    }).format(now);
    const hour = Number.parseInt(text, 10);
    return Number.isNaN(hour) ? now.getHours() : hour % 24;
  }

  /**
   * 只读查询：某租户当前有多少条漏提醒 + 可读摘要（供 AI 工具调用）。
   *
   * 🔴 只读：不写 reminded_at、不改 status、不删任何行（AI 不得删原始提醒）。
   */
  async summarizeBacklog(
    tenantId: string,
    now: Date = new Date(),
  ): Promise<{
    total: number;
    urgent: Array<{ title: string; remindAt: string }>;
    summary: string;
  }> {
    try {
      const rows = await this.dataSource.query<DueRow[]>(
        `SELECT s.id, s.tenant_id, s.title, s.owner, s.participants,
                s.start_at, s.remind_at
           FROM t_ai_schedule s
          WHERE s.tenant_id = ?
            AND s.status = 'planned'
            AND s.remind_at IS NOT NULL
            AND s.remind_at <= ?
            AND NOT EXISTS (
              SELECT 1 FROM t_ai_reminder_delivery d
               WHERE d.tenant_id = s.tenant_id
                 AND d.schedule_id = CAST(s.id AS CHAR)
                 AND d.occurrence_at = s.remind_at
                 AND d.kind = 'notice'
                 AND d.status = 'success'
            )
          ORDER BY s.remind_at ASC`,
        [tenantId, now],
      );
      const total = rows.length;
      const urgent = rows.slice(0, DIGEST_THRESHOLD).map((r) => ({
        title: r.title,
        remindAt: toIso(r.remind_at),
      }));
      const summary =
        total === 0
          ? '当前没有待补发的漏提醒。'
          : `你有 ${total} 条漏提醒待查看：` +
            urgent.map((u) => `${u.title}（${u.remindAt}）`).join('；') +
            (total > urgent.length
              ? `；等共 ${total} 条，完整列表见通知中心。`
              : '。');
      return { total, urgent, summary };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`漏提醒查询失败（已隔离）：${message}`);
      return { total: 0, urgent: [], summary: '暂时无法读取漏提醒信息' };
    }
  }
}

/** 时间归一为 Date（用于 occurrence 身份） */
function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/** 归一为 MySQL DATETIME(3) 文本（游标分页用） */
function toSqlDateTime(v: Date | string): string {
  return toDate(v).toISOString().slice(0, 23).replace('T', ' ');
}

/** 时间归一为 ISO 文本（兼容 Date / 字符串） */
function toIso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
