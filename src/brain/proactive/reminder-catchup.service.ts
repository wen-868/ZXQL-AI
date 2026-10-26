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
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import jwt from 'jsonwebtoken';
import { ProactivePushService } from './proactive-push.service';
import { NoticeBridgeService } from './notice-bridge.service';
import { ServiceClient } from '../../bridge/service-client';
import { parseParticipants } from '../../tools/definitions/schedule-participants.util';

/** 单批扫描上限：只限制**单次查询**规模，不是丢弃上限 */
const CATCHUP_BATCH = 100;
/** 逐条推送阈值：≤ 此值逐条推，> 此值只发一条聚合摘要 */
const DIGEST_THRESHOLD = 3;
/** 安静时段（Asia/Shanghai 小时，左闭右开：22:00–08:00） */
const QUIET_START_HOUR = 22;
const QUIET_END_HOUR = 8;
/** F3 §四.3b：租户服务 JWT TTL（秒）—— 卡面上限 15 分钟，取 10 分钟留余量 */
const SERVICE_JWT_TTL_SECONDS = 600;
/** F3 §四.3：sys-users 分页大小（MS 侧 pageSize 上限 100） */
const SYS_USERS_PAGE_SIZE = 100;
/** 分页防御上限（total 异常时的收敛保险；达到即视为"分页失败"而非"无成员"） */
const SYS_USERS_MAX_PAGES = 50;

/** MS `sys-users` 返回的用户精简形状（roles[].id / roles[].roleCode 用于精确匹配） */
interface SysUserLite {
  id: number;
  roles?: Array<{ id: number; roleCode?: string; roleName?: string }>;
}
/** MS `sys-users` 分页信封（ServiceClient 已解包 data） */
interface SysUsersPage {
  total: number;
  page: number;
  pageSize: number;
  records: SysUserLite[];
}

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
  /** 逐接收人摘要**投递成功**的接收人数（F3 起按人计，不再按日程计） */
  digests: number;
  /** 逐接收人摘要投递**失败**的接收人数（下轮只重试这些） */
  recipientFailed: number;
  /** 无法解析（role/employee/未知形态）的**未投递**接收人数（明确未投递，非成功） */
  unresolvedRecipients: number;
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
    // F3 §四.3：role 参与者经 ServiceClient 调 MS 公共 sys-users 接口解析成员
    @Optional()
    private readonly serviceClient?: ServiceClient,
    @Optional()
    private readonly configService?: ConfigService,
  ) {}

  /** 补偿所有到期未送达的提醒（供 cron 调用；绝不外抛） */
  async catchup(now: Date = new Date()): Promise<CatchupResult> {
    // F3 §四.3d：同轮缓存每次 catchup 重建 ⇒ 下一轮重新读取 sys-users 快照
    this.clearRecipientCaches();
    const result: CatchupResult = {
      scanned: 0,
      recorded: 0,
      noticeFailed: 0,
      pushed: 0,
      digests: 0,
      recipientFailed: 0,
      unresolvedRecipients: 0,
      quiet: this.isQuietHours(now),
      deferred: false,
    };

    try {
      // ══ 阶段 0（F2 返工点 5）：崩溃窗口补写 ══
      // 通知已入箱（notice delivery=success）但 reminded_at 仍 NULL
      // ⇒ 幂等补写。**必须独立于投递扫描**：若只靠"该条目还会被扫到"来补写，
      //   一旦 push 也已闭合，该行永远不再入选 ⇒ 标记永久丢失（本单实测发现的漏洞）。
      const backfilled = await this.backfillMissingRemindedAt(now);
      if (backfilled > 0) {
        this.logger.log(
          `补偿：幂等补写 reminded_at ${backfilled} 条（崩溃窗口恢复）`,
        );
      }

      const rows = await this.collectAllDue(now);
      result.scanned = rows.length;
      if (rows.length === 0) {
        return result;
      }

      // ══ 阶段 1：只落通知（绝不推送）══
      // 通知失败的条目**不写完成标记**，下轮重试。
      // fresh=本轮新入箱；pending=此前已入箱但 push 未完成（F2：一律走汇总）。
      const freshRows: DueRow[] = [];
      const pendingRows: DueRow[] = [];
      const noticeFailed: DueRow[] = [];
      let newlyRecorded = 0;
      for (const row of rows) {
        const res = await this.recordNotice(row, now);
        if (res.ok && res.fresh) {
          freshRows.push(row);
          newlyRecorded += 1;
        } else if (res.ok) {
          pendingRows.push(row);
        } else {
          noticeFailed.push(row);
          result.noticeFailed += 1;
        }
      }
      result.recorded = newlyRecorded;

      // ══ 阶段 2：逐接收人定向投递（只针对"通知已成功"的条目）══
      // F3 统一口径（返工点 2/红线「禁止 owner 单推代替参与者触达」）：
      // 无论 pending 还是 fresh、无论条数，一律 expandRecipients ⇒ **每个可解析
      // 接收人一份定向摘要**（F2 的"≤3 逐条广播"路径整条移除：不带 targetUserId
      // 的 push 在共享 WebSocket 下即租户广播，正是 M2 驳回形态）。
      if (result.quiet) {
        // 安静时段：通知已入箱，**推送严格 0**（B1 行为保留）
        const n = freshRows.length + pendingRows.length;
        if (n > 0) {
          result.deferred = true;
          this.logger.log(`补偿：安静时段，入箱 ${n} 条，即时推送 0 条`);
        }
      } else if (pendingRows.length > 0 || freshRows.length > 0) {
        const st = await this.pushDigestByRecipient(
          [...pendingRows, ...freshRows],
          now,
        );
        result.digests += st.delivered;
        result.recipientFailed += st.failed;
        result.unresolvedRecipients += st.unresolved;
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
   * "未送达"口径（F2 收口）：
   * - notice 未 success ⇒ 需要补通知；
   * - notice success 但 push 未进终态 ⇒ 需要补推送。
   *   **终态 = success 或 skipped**（skipped=不可定向已收口 ⇒ 不得再被扫描，
   *   否则 quiet 积压会每分钟重推一遍）。
   *
   * ⇒ 摘要成功/已发过 ⇒ 组内每条都会被标 push=success（返工点 1），下轮本批为 0
   * （硬验收 1：下一次 catchup 扫到的本批行为 0）。
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
                   AND dp.status IN ('success', 'skipped')
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
    now: Date,
  ): Promise<{ ok: boolean; fresh: boolean }> {
    const scheduleId = String(row.id);
    const occurrence = toDate(row.remind_at);
    try {
      // 幂等前置：notice 已 success ⇒ 不重复插入；
      // F2 返工点 5：但 reminded_at 可能因"入箱后崩溃窗口"仍为 NULL ⇒ 必须幂等补写
      if (
        this.noticeBridge &&
        (await this.deliveryDone(row, occurrence, 'notice'))
      ) {
        await this.backfillRemindedAt(row, now);
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

      // 兼容既有语义：通知成功才写 reminded_at（以 reminded_at IS NULL 守卫 ⇒ 幂等）
      await this.dataSource.query(
        'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
        [now, scheduleId],
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

  /**
   * 阶段 2b（F3）：**逐接收人定向摘要**。
   *
   * 与 F2 的本质区别：F2 按 owner 一组、一条 push 代表整条日程；
   * F3 要求 owner 与每个可解析参与者**各收一份只含本人相关日程的摘要**，
   * 且**不得用 owner 单推代替参与者触达**（卡面红线）。
   *
   * 三类结局，逐接收人独立判定：
   * - delivered / failed：可定向（user:{id}）⇒ 真实推送 + 写 025 逐接收人状态；
   * - unresolved_*：无可靠映射 ⇒ 写登记表，**明确未投递**（不冒充 success）。
   *
   * 部分失败只重试失败接收人（§五.5）：delivered 的键进缓存，本轮/下轮不再重复；
   * failed 留 failed ⇒ 下轮 collectAllDue 仍会选中该日程并只补失败者。
   */
  private async pushDigestByRecipient(
    rows: DueRow[],
    now: Date,
  ): Promise<{ delivered: number; failed: number; unresolved: number }> {
    const stat = { delivered: 0, failed: 0, unresolved: 0 };

    // ① 逐日程展开接收人 ⇒ 反查：接收人 → 本人相关日程行（内容隔离的基础）
    const byRecipient = new Map<
      string,
      { tenantId: string; userId: number; principal: string; rows: DueRow[] }
    >();
    for (const row of rows) {
      const ex = await this.expandRecipients(row);
      for (const r of ex.resolved) {
        const key = `${row.tenant_id}|${r.userId}`;
        const hit = byRecipient.get(key);
        if (hit) hit.rows.push(row);
        else
          byRecipient.set(key, {
            tenantId: row.tenant_id,
            userId: r.userId,
            principal: r.principal,
            rows: [row],
          });
      }
      for (const u of ex.unresolved) {
        await this.markUnresolvedPrincipal(row, u);
        stat.unresolved += 1;
      }
      // 🔴 F2 收口保留：全部接收人均不可解析 ⇒ 该日程写 push=skipped 退出重扫
      //    （站内通知已入箱可见；否则该行会以 pending 态被每分钟无限重扫）
      if (ex.resolved.length === 0) {
        const occurrence = toDate(row.remind_at);
        if (!(await this.deliveryDone(row, occurrence, 'push'))) {
          await this.markDelivery(
            row,
            occurrence,
            'push',
            'skipped',
            `全部接收人不可解析（${ex.unresolved
              .map((u) => u.principal)
              .join(', ')}），已登记未投递`,
            now,
          );
        }
      }
    }

    // ② 逐接收人一份摘要（只含本人相关行）
    for (const [, grp] of byRecipient) {
      const { tenantId, userId, principal, rows: mine } = grp;
      const batchKey = this.recipientBatchKey(tenantId, userId, mine);

      // 幂等：该接收人该批已发过 ⇒ 补齐状态即收口（不重复发送）
      if (await this.digestDone(tenantId, batchKey)) {
        await this.markRecipientRows(mine, userId, principal, 'delivered', now);
        continue;
      }

      const urgent = mine.slice(0, DIGEST_THRESHOLD);
      const lines = urgent
        .map((r) => `· ${r.title}（${toIso(r.remind_at)}）`)
        .join('\n');
      const digest = {
        type: 'system' as const,
        title: `您有 ${mine.length} 条漏提醒待查看`,
        content:
          `系统恢复后发现您有 ${mine.length} 条到期提醒未及时送达：\n${lines}\n` +
          `以上为最紧急 ${urgent.length} 条，完整列表请打开通知中心查看。`,
        priority: 'reminder' as const,
        targetUserId: userId,
      };

      let ok = false;
      try {
        ok = await this.pushService.push(
          tenantId,
          'schedule_reminder_digest',
          digest,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `补偿：摘要推送失败（recipient=user:${userId}）：${message}`,
        );
      }

      if (ok) {
        await this.markRecipientRows(mine, userId, principal, 'delivered', now);
        await this.writeDigestSuccess(tenantId, batchKey, now);
        stat.delivered += 1;
      } else {
        // 只标该接收人 failed ⇒ 下轮只重试他（成功者不重复）
        await this.markRecipientRows(
          mine,
          userId,
          principal,
          'failed',
          now,
          '摘要推送失败',
        );
        stat.failed += 1;
      }
    }
    return stat;
  }

  /** 逐接收人批指纹：tenant + recipient + 成员集合 ⇒ 新批不撞旧批（旧条目不进新摘要） */
  private recipientBatchKey(
    tenantId: string,
    userId: number,
    rows: DueRow[],
  ): string {
    const parts = rows
      .map((r) => `${String(r.id)}@${toIso(r.remind_at)}`)
      .sort()
      .join('|');
    let h = 0;
    for (let i = 0; i < parts.length; i += 1) {
      h = (h * 31 + parts.charCodeAt(i)) | 0;
    }
    return `rdigest:${tenantId}:${userId}:${Math.abs(h).toString(36)}`;
  }

  /**
   * 写逐接收人投递状态（025 表），并在该日程**全部可解析接收人**达 delivered 时
   * 同步 024 的 push 闭合（保持 F2 硬验收 1 不回退：摘要后本批不再被扫描）。
   */
  private async markRecipientRows(
    rows: DueRow[],
    userId: number,
    principal: string,
    state: 'delivered' | 'failed',
    now: Date,
    errorMsg?: string,
  ): Promise<void> {
    for (const row of rows) {
      const occurrence = toDate(row.remind_at);
      try {
        await this.dataSource.query(
          `INSERT INTO t_ai_reminder_recipient_delivery
             (tenant_id, schedule_id, occurrence_at, recipient_user_id, principal, state, dedupe_key, error_msg, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON DUPLICATE KEY UPDATE
             state = VALUES(state),
             error_msg = VALUES(error_msg),
             attempts = attempts + 1,
             updated_at = VALUES(updated_at)`,
          [
            row.tenant_id,
            String(row.id),
            occurrence,
            userId,
            principal,
            state,
            `${row.tenant_id}:${String(row.id)}:${toIso(row.remind_at)}:${userId}`,
            errorMsg ?? null,
            now,
            now,
          ],
        );
        if (state === 'delivered' && (await this.allRecipientsDelivered(row))) {
          await this.markGroupPushDone([row], now);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `补偿：逐接收人状态写入失败：schedule=${String(row.id)} user=${userId} ${message}`,
        );
      }
    }
  }

  /** 该日程的全部可解析接收人是否都已 delivered（决定 024 是否闭合） */
  private async allRecipientsDelivered(row: DueRow): Promise<boolean> {
    // 同轮 (tenant, role) 成员快照缓存 ⇒ 这里不会重复全量扫描 MS 接口（§四.3d）
    const ex = await this.expandRecipients(row);
    if (ex.resolved.length === 0) return false;
    const occurrence = toDate(row.remind_at);
    const got = await this.dataSource.query<Array<{ c: unknown }>>(
      `SELECT COUNT(DISTINCT recipient_user_id) AS c FROM t_ai_reminder_recipient_delivery
        WHERE tenant_id = ? AND schedule_id = ? AND occurrence_at = ? AND state = 'delivered'`,
      [row.tenant_id, String(row.id), occurrence],
    );
    return Number(got[0]?.c ?? 0) >= ex.resolved.length;
  }

  /** 登记不可解析 principal（明确未投递，不冒充 success） */
  private async markUnresolvedPrincipal(
    row: DueRow,
    u: { principal: string; reason: string; detail: string },
  ): Promise<void> {
    const occurrence = toDate(row.remind_at);
    const at = new Date();
    try {
      await this.dataSource.query(
        `INSERT INTO t_ai_reminder_unresolved_principal
           (tenant_id, schedule_id, occurrence_at, principal, reason, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           reason = VALUES(reason),
           detail = VALUES(detail),
           updated_at = VALUES(updated_at)`,
        [
          row.tenant_id,
          String(row.id),
          occurrence,
          u.principal,
          u.reason,
          u.detail,
          at,
          at,
        ],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `补偿：不可解析 principal 登记失败：schedule=${String(row.id)} ${message}`,
      );
    }
  }

  /**
   * 经 **MS 公共接口**解析 `role:` 成员（卡面 §四.3 / §四.3b~3d / §五.3）。
   *
   * 口径：
   * - `GET /api/admin/sys-users?status=ACTIVE&page=N&pageSize=100`（公开接口，不直读
   *   `t_sys_user_role` —— 红线）；分页按返回 `total` 收敛，空页/越界即止；
   * - 匹配按 `roles[].roleCode`（principal 为数字时按 `roles[].id`）**精确等值**，
   *   不做模糊/子串匹配；
   * - 鉴权用**短期租户服务 JWT**（`id=0`、`issuer=zhixiang-system`、
   *   `audience=zhixiang-client`、TTL ≤ 15 分钟），密钥取 `JWT_SECRET`；
   *   🔴 令牌与密钥**绝不写日志/证据**（红线）；
   * - 接口/鉴权/分页任一失败 ⇒ 返回 `{ok:false,error}` ⇒ 调用方登记 `unresolved_role`
   *   （明确未投递），其他 owner/user 照常投递（§四.3c）；
   * - 同轮按 `(tenant, role)` 缓存成员快照（§四.3d）⇒ 多个日程引用同角色不重复全量扫描；
   *   缓存在每次 catchup 开始时清空 ⇒ 下一轮重新读取。
   */
  private readonly roleMemberCache = new Map<string, number[]>();
  private readonly tenantUserCache = new Map<string, SysUserLite[]>();

  private async resolveRoleMembers(
    tenantId: string,
    roleKey: string,
  ): Promise<{ ok: boolean; userIds: number[]; error?: string }> {
    if (roleKey.length === 0) {
      return { ok: false, userIds: [], error: 'role principal 缺少角色标识' };
    }
    const cacheKey = `${tenantId}|${roleKey}`;
    const hit = this.roleMemberCache.get(cacheKey);
    if (hit) return { ok: true, userIds: hit };

    const byRole = (u: SysUserLite): boolean =>
      (u.roles ?? []).some((r) =>
        /^\d+$/.test(roleKey)
          ? String(r.id) === roleKey
          : String(r.roleCode ?? '') === roleKey,
      );
    const users = await this.listTenantUsers(tenantId);
    if (!users.ok) {
      return { ok: false, userIds: [], error: users.error };
    }
    const ids = users.records.filter(byRole).map((u) => u.id);
    this.roleMemberCache.set(cacheKey, ids);
    return { ok: true, userIds: ids };
  }

  /** 分页枚举 ACTIVE 用户（同轮按租户缓存原始快照） */
  private async listTenantUsers(
    tenantId: string,
  ): Promise<
    { ok: true; records: SysUserLite[] } | { ok: false; error: string }
  > {
    const cached = this.tenantUserCache.get(tenantId);
    if (cached) return { ok: true, records: cached };

    if (!this.serviceClient) {
      return { ok: false, error: 'ServiceClient 未注入（role 成员不可解析）' };
    }
    const token = this.signServiceToken(tenantId);
    if (!token) {
      return { ok: false, error: '服务 JWT 签发失败（JWT_SECRET 未配置）' };
    }

    const records: SysUserLite[] = [];
    try {
      for (let page = 1; page <= SYS_USERS_MAX_PAGES; page += 1) {
        const data = await this.serviceClient.get<SysUsersPage>(
          `/api/admin/sys-users?status=ACTIVE&page=${page}&pageSize=${SYS_USERS_PAGE_SIZE}`,
          { tenantId, userId: '0', authToken: token },
        );
        const list = data?.records ?? [];
        records.push(...list);
        const total = Number(data?.total ?? 0);
        // 收敛条件：本页空 或 已集齐 total（§四.3c：分页失败不得静默当成"无成员"）
        if (list.length === 0 || records.length >= total) break;
        if (page === SYS_USERS_MAX_PAGES) {
          return {
            ok: false,
            error: `sys-users 分页未收敛（total=${total} 已取 ${records.length}）`,
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `sys-users 接口失败：${message}`.slice(0, 300),
      };
    }
    this.tenantUserCache.set(tenantId, records);
    return { ok: true, records };
  }

  /**
   * 短期租户服务 JWT（§四.3b）。
   * 🔴 返回值只用于请求头，禁止进入任何日志/异常信息/证据。
   */
  private signServiceToken(tenantId: string): string | null {
    const secret = this.configService?.get<string>('JWT_SECRET');
    if (!secret) return null;
    try {
      return jwt.sign(
        {
          id: 0,
          username: 'ai-reminder-service',
          realName: 'AI 提醒服务',
          roles: [],
          tenantId,
        },
        secret,
        {
          algorithm: 'HS256',
          // 10 分钟 < 卡面上限 15 分钟
          expiresIn: SERVICE_JWT_TTL_SECONDS,
          issuer: 'zhixiang-system',
          audience: 'zhixiang-client',
        },
      );
    } catch {
      // 异常信息可能含 payload ⇒ 只回固定文案
      return null;
    }
  }

  /** 每次 catchup 开始清空同轮缓存（下一轮必须重新读取，§四.3d） */
  private clearRecipientCaches(): void {
    this.roleMemberCache.clear();
    this.tenantUserCache.clear();
  }

  private userIdOf(owner: string): number | null {
    const m = /^user:(\d+)$/.exec(owner.trim());
    if (!m) return null;
    const id = Number.parseInt(m[1], 10);
    return Number.isFinite(id) && id > 0 ? id : null;
  }

  /**
   * 展开一条日程的**接收人集合**（F3 返工点 1）：owner + participants，按 principal 去重。
   *
   * 三类结局（卡面 §四.1~4 / §五.1/3/4）：
   * - `user:{数字}` ⇒ 直接定向（owner 与参与者同等对待）；
   * - `role:{code|id}` ⇒ 经 **MS 公共接口** `GET /api/admin/sys-users?status=ACTIVE&page&pageSize`
   *   分页枚举，按返回 `roles[].roleCode`（数字形态则按 `roles[].id`）**精确匹配**展开成员；
   *   接口/鉴权/分页任一失败 ⇒ 该 role 明确未投递，**不影响其他 owner/user 继续投递**（§四.3c）；
   *   禁止直读 MS `t_sys_user_role`（红线）。
   * - `employee:{id}` ⇒ `t_ai_employee` 无到用户的绑定字段 ⇒ 明确未投递（§四.4）。
   *
   * 同一用户兼 owner 与 participant ⇒ 只保留一次（§四.7）。
   */
  private async expandRecipients(row: DueRow): Promise<{
    resolved: Array<{ userId: number; principal: string }>;
    unresolved: Array<{ principal: string; reason: string; detail: string }>;
  }> {
    const principals: string[] = [];
    const push = (p: string | null | undefined): void => {
      const v = (p ?? '').trim();
      if (v.length > 0 && !principals.includes(v)) principals.push(v);
    };
    push(row.owner);
    for (const p of parseParticipants(row.participants)) push(p);

    const resolved: Array<{ userId: number; principal: string }> = [];
    const unresolved: Array<{
      principal: string;
      reason: string;
      detail: string;
    }> = [];
    const seenUsers = new Set<number>();
    const take = (userId: number, principal: string): void => {
      if (seenUsers.has(userId)) {
        // 同一用户以不同 principal 出现（owner=user:7 且 participants 亦含 user:7、
        // 或同时命中多个角色）⇒ 只投递一次（§四.4/§四.7）
        return;
      }
      seenUsers.add(userId);
      resolved.push({ userId, principal });
    };

    for (const principal of principals) {
      const uid = this.userIdOf(principal);
      if (uid !== null) {
        take(uid, principal);
        continue;
      }
      if (principal.startsWith('role:')) {
        const members = await this.resolveRoleMembers(
          row.tenant_id,
          principal.slice('role:'.length),
        );
        if (members.ok) {
          for (const id of members.userIds) take(id, principal);
        } else {
          unresolved.push({
            principal,
            reason: 'unresolved_role',
            detail: `sys-users 解析失败 ⇒ 未投递：${members.error}`.slice(
              0,
              480,
            ),
          });
        }
        continue;
      }
      if (principal.startsWith('employee:')) {
        unresolved.push({
          principal,
          reason: 'unresolved_employee',
          detail:
            't_ai_employee 无到用户的绑定字段，MS 亦无员工↔账号映射 ⇒ 无可靠映射，未投递',
        });
      } else {
        unresolved.push({
          principal,
          reason: 'unresolved_principal',
          detail: 'principal 形态无法识别（期望 user:/role:/employee:）',
        });
      }
    }
    return { resolved, unresolved };
  }

  /** 组内每条写 push=success（幂等，摘要已发或不可定向后的收口） */
  private async markGroupPushDone(rows: DueRow[], now: Date): Promise<void> {
    for (const row of rows) {
      const occurrence = toDate(row.remind_at);
      if (await this.deliveryDone(row, occurrence, 'push')) continue;
      await this.markDelivery(
        row,
        occurrence,
        'push',
        'success',
        undefined,
        now,
      );
    }
  }

  /**
   * 崩溃窗口恢复（F2 返工点 5）：notice 已 success 但 reminded_at 仍 NULL
   * ⇒ 幂等补写。守卫 `reminded_at IS NULL` ⇒ 普通扫描/重复执行不会改写已有值。
   */
  private async backfillRemindedAt(row: DueRow, now: Date): Promise<void> {
    try {
      await this.dataSource.query(
        'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
        [now, String(row.id)],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 补写失败不影响本轮投递判定（下轮仍会尝试）
      this.logger.warn(
        `补偿：reminded_at 幂等补写失败：schedule=${String(row.id)} ${message}`,
      );
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

  /**
   * 崩溃窗口恢复（F2 返工点 5）：通知已入箱（notice delivery=success）
   * 但 `t_ai_schedule.reminded_at` 仍 NULL ⇒ **独立**幂等补写。
   *
   * 为什么不能只在 `recordNotice` 的"已入箱"分支里补：
   * 那些条目若 push 也已闭合，就**不会**再被 `collectAllDue` 选中 ⇒
   * 标记永久停留在 NULL（实测漏洞）。故独立一步直接按 reminded_at IS NULL 查。
   *
   * 幂等：UPDATE 带 `reminded_at IS NULL` 守卫 ⇒ 重复执行/并发只写一次。
   */
  private async backfillMissingRemindedAt(now: Date): Promise<number> {
    try {
      const orphans = await this.dataSource.query<Array<{ id: unknown }>>(
        `SELECT s.id
           FROM t_ai_schedule s
          WHERE EXISTS (
            SELECT 1 FROM t_ai_reminder_delivery d
             WHERE d.tenant_id = s.tenant_id
               AND d.schedule_id = CAST(s.id AS CHAR)
               AND d.occurrence_at = s.remind_at
               AND d.kind = 'notice'
               AND d.status = 'success'
          )
            AND s.reminded_at IS NULL
          LIMIT ${CATCHUP_BATCH}`,
      );
      let n = 0;
      for (const o of orphans) {
        // UPDATE 带 `reminded_at IS NULL` 守卫 ⇒ 天然幂等：并发/重复执行
        // 只写一次，后写者 affectedRows=0（本行已不再"缺失"）。
        // 计数以"本次确实执行了补写动作"为准；affectedRows 细节不依赖
        // （TypeORM query 对 UPDATE 的返回形态跨方言不一致）。
        await this.dataSource.query(
          'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
          [now, String(o.id)],
        );
        n += 1;
      }
      return n;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 补写失败不影响本轮补偿主流程（下轮再试）
      this.logger.warn(`补偿：reminded_at 补写步骤失败（已隔离）：${message}`);
      return 0;
    }
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

  /** 该维度是否已进终态（notice: success；push: success/skipped） */
  private async deliveryDone(
    row: DueRow,
    occurrence: Date,
    kind: 'notice' | 'push',
  ): Promise<boolean> {
    const statusClause =
      kind === 'push' ? `IN ('success', 'skipped')` : `= 'success'`;
    const rows = await this.dataSource.query<Array<{ c: unknown }>>(
      `SELECT COUNT(*) AS c FROM t_ai_reminder_delivery
        WHERE tenant_id = ? AND schedule_id = ? AND occurrence_at = ? AND kind = ? AND status ${statusClause}`,
      [row.tenant_id, String(row.id), occurrence, kind],
    );
    return Number(rows[0]?.c ?? 0) > 0;
  }

  /** 写/更新投递状态（唯一键冲突 ⇒ 累加 attempts） */
  private async markDelivery(
    row: DueRow,
    occurrence: Date,
    kind: 'notice' | 'push',
    status: 'success' | 'failed' | 'skipped',
    errorMsg?: string,
    at: Date = new Date(),
  ): Promise<void> {
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
        at,
        at,
      ],
    );
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
