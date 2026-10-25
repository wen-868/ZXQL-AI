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

      // ══ 阶段 2：分层推送（只针对"通知已成功"的条目）══
      // F2 分流口径（返工点 3）：
      // - **quiet 后积压（pending）与非 quiet 新入箱超过阈值（fresh>3）一律"汇总"**：
      //   按 owner 分组、每组一条定向摘要，1/3/4 条也不逐条推；
      // - **fresh ≤3** 保留 F1 的逐条即时推送（B1/B2 已验证行为不回归）。
      if (result.quiet) {
        // 安静时段：通知已入箱，**推送严格 0**（B1 行为保留）
        const n = freshRows.length + pendingRows.length;
        if (n > 0) {
          result.deferred = true;
          this.logger.log(`补偿：安静时段，入箱 ${n} 条，即时推送 0 条`);
        }
      } else {
        // 2a. pending 存在 ⇒ 本轮**一律汇总**（pending+fresh 合并成组，每 owner 一条）。
        //     不允许"逐条 + 摘要"并存（那正是 F1 被驳回的 B2 = N+1 形态）。
        // 2b. 无 pending ⇒ fresh ≤3 逐条推（B1/B2 保留）；fresh >3 每 owner 一条汇总。
        if (pendingRows.length > 0) {
          const d = await this.pushDigestByOwner(
            [...pendingRows, ...freshRows],
            now,
          );
          result.digests += d;
        } else if (freshRows.length <= DIGEST_THRESHOLD) {
          for (const row of freshRows) {
            const ok = await this.pushSingle(row);
            if (ok) result.pushed += 1;
          }
        } else {
          const d = await this.pushDigestByOwner(freshRows, now);
          result.digests += d;
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
   * 阶段 2b（F2）：**按 owner/接收人分组**，每组**至多一条**定向摘要。
   *
   * 三条驳回对应关系：
   * - 返工点 2「禁止租户广播泄露他人日程标题」⇒ 摘要必须带 `targetUserId`，
   *   走 `sendToUser` 只投该用户（AI-45 语义：不在线不回落广播）；
   *   owner 不是 `user:{数字}`（如 `employee:{id}` 或缺失）⇒ **无法定向 ⇒ 不推送**
   *   （宁可只留站内通知，也不把个人日程标题广播给全租户），投递记 `skipped`。
   * - 返工点 1「摘要成功后给本批每条幂等写 push=success」⇒ 组内每条都写
   *   `kind='push', status='success'` ⇒ 下轮不再被选中（硬验收 1）。
   * - 返工点 4「1/3/4 条均只发一条汇总」⇒ 本函数不看条数阈值，每组恒定一条。
   *
   * 幂等：`batch_key = digest:{owner}:{成员指纹}`（按组而非整批）⇒
   * 同组连续 cron 只发一次；新批不含旧条目（成员变了 ⇒ 指纹变了）。
   */
  private async pushDigestByOwner(rows: DueRow[], now: Date): Promise<number> {
    // 按 **(租户, owner)** 分组：
    // 🔴 只按 owner 分组会把**不同租户**的同名 owner 合进一组 ⇒ B 租户标题
    //    随摘要进了 A 租户的定向推送（跨租户泄漏）。租户必须参与分组键。
    const groups = new Map<string, DueRow[]>();
    for (const r of rows) {
      const key = `${r.tenant_id}|${r.owner ?? '(none)'}`;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }

    let sent = 0;
    for (const [groupKey, groupRows] of groups) {
      const tenantId = groupRows[0].tenant_id;
      const owner = groupKey.slice(groupKey.indexOf('|') + 1);
      const batchKey = this.batchKeyOf(owner, groupRows);

      // 幂等：该组已发过 ⇒ 仍要确保单条 push 状态补齐（返工点 2：不得继续被扫描）
      if (await this.digestDone(tenantId, batchKey)) {
        await this.markGroupPushDone(groupRows, now);
        continue;
      }

      const targetUserId = this.userIdOf(owner);
      if (targetUserId === null) {
        // 🔴 不可定向 ⇒ 不广播（防他人标题泄漏），标记 skipped 退出重扫
        this.logger.warn(
          `补偿：owner=${owner} 无法定向到用户，跳过即时推送（站内通知已入箱）`,
        );
        await this.markGroupPushSkipped(groupRows, now);
        await this.writeDigestSuccess(tenantId, batchKey, now);
        continue;
      }

      const urgent = groupRows.slice(0, DIGEST_THRESHOLD);
      const lines = urgent
        .map((r) => `· ${r.title}（${toIso(r.remind_at)}）`)
        .join('\n');
      const digest = {
        type: 'system' as const,
        title: `您有 ${groupRows.length} 条漏提醒待查看`,
        content:
          `系统恢复后发现您有 ${groupRows.length} 条到期提醒未及时送达：\n${lines}\n` +
          `以上为最紧急 ${urgent.length} 条，完整列表请打开通知中心查看。`,
        priority: 'reminder' as const,
        targetUserId,
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
        this.logger.warn(`补偿：摘要推送失败（owner=${owner}）：${message}`);
        ok = false;
      }

      if (ok) {
        // 🔴 返工点 1：摘要成功后**每条**幂等写 push=success ⇒ 下轮扫不到
        await this.markGroupPushDone(groupRows, now);
        await this.writeDigestSuccess(tenantId, batchKey, now);
        sent += 1;
      }
      // 摘要失败 ⇒ 不写 push=success、不写 digest 记录 ⇒ 下轮重试（不假成功）
    }
    return sent;
  }

  /** owner `user:{数字}` ⇒ targetUserId；否则 null（不可定向） */
  private userIdOf(owner: string): number | null {
    const m = /^user:(\d+)$/.exec(owner.trim());
    if (!m) return null;
    const id = Number.parseInt(m[1], 10);
    return Number.isFinite(id) && id > 0 ? id : null;
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

  /** 组内每条写 push=skipped（不可定向 ⇒ 退出重扫，但没推送出去） */
  private async markGroupPushSkipped(rows: DueRow[], now: Date): Promise<void> {
    for (const row of rows) {
      await this.markDelivery(
        row,
        toDate(row.remind_at),
        'push',
        'skipped',
        'owner 非用户身份，不可定向推送（站内通知已入箱）',
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

  /**
   * 本组摘要的稳定标识：**owner + 组内成员指纹**（排序后 scheduleId@occurrenceAt 哈希）。
   *
   * F2 关键变化（相对 F1 的整批指纹）：
   * - 按组 ⇒ 同租户两 owner 各自一条摘要、互不含对方标题（硬验收 2）；
   * - 成员变了 ⇒ 指纹变了 ⇒ 新批不撞旧记录（硬验收 3：新摘要不含旧条目）；
   * - 同组同批连续 cron ⇒ 指纹相同 ⇒ 只成功发一次。
   */
  private batchKeyOf(owner: string, rows: DueRow[]): string {
    const parts = rows
      .map((r) => `${String(r.id)}@${toIso(r.remind_at)}`)
      .sort()
      .join('|');
    let h = 0;
    for (let i = 0; i < parts.length; i += 1) {
      h = (h * 31 + parts.charCodeAt(i)) | 0;
    }
    return `digest:${owner}:${Math.abs(h).toString(36)}`;
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
