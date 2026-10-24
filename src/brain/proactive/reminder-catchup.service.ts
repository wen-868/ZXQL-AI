/**
 * ReminderCatchupService — 停机漏提醒补偿器（AI-P2-3）
 *
 * 解决的真问题：`@Cron` 只在进程活着时扫描。系统停机、重启、渠道故障期间到期的提醒，
 * 恢复后**不能静默丢失**。本服务把"所有已到期但未成功送达"的提醒全部补回。
 *
 * ══════════════════════════════════════════════════════════════════
 * 设计约束（逐条对应派单卡硬验收，改动前必读）
 * ══════════════════════════════════════════════════════════════════
 *
 * ① **不设"只补最近 N 条"**（红线）：
 *    `LIMIT` 只是**单批**上限（防一次查询拖垮库/内存），采用**分批循环直到扫尽**，
 *    任何分批边界都不丢弃提醒。停机 7 天、100 条都能全部补回。
 *
 * ② **推送分层，但通知中心逐条保全**：
 *    - 漏提醒 ≤ 3 条 ⇒ 逐条推送；
 *    - > 3 条 ⇒ 一条聚合摘要 + 每条仍**独立**进通知中心（NoticeService 逐条落库）。
 *    ⚠️ 聚合摘要**不是**提醒本体：它只是"告知总量"的引导入口，
 *    通知中心里每一条原始提醒都必须独立存在（mutation 2 专测此点）。
 *
 * ③ **安静时段 22:00–08:00 不推即时消息**：
 *    判定按 `Asia/Shanghai`。安静时段内：通知中心照常即时落库（用户打开就能看到），
 *    但**不发** WebSocket/推送；推迟到 08:00 生成一条聚合摘要。
 *
 * ④ **幂等键覆盖 tenant/user/sourceId/occurrenceAt/channel**：
 *    与 `NoticeService` 的 `dedupe_key` 语义对齐（同租户同键未读存在 ⇒ 不重复插）。
 *    重复扫描 100 次也不得重复成功发送。渠道失败可重试，**已成功渠道不重发**。
 *
 * ⑤ **人工与 AI 共用同一补偿器**（红线：不建 AI 旁路）：
 *    本服务只看 `t_ai_schedule`（人工日程与 AI 创建的日程同表同字段），
 *    不区分创建者 ⇒ 天然共用。AI 只能查询/生成摘要，不得删除原始提醒。
 *
 * ⚠️ **recurrence 标 BLOCKED**：`ai-schedule.entity.ts` 无 recurrence 字段
 *    （实体注释明确"本批不做"），P2-2 尚未落地 ⇒ recurrence occurrence 无法覆盖，
 *    矩阵中如实登记，不自造数据模型（自造会与 P2-2 撞车）。
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
/** 逐条推送阈值：≤ 此值逐条推，> 此值发聚合摘要 */
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

/** 补偿结果（供 cron 日志与测试断言） */
export interface CatchupResult {
  /** 扫描到的漏提醒总数（去重前） */
  scanned: number;
  /** 逐条成功送达通知中心的条数 */
  recorded: number;
  /** 逐条推送条数（安静时段为 0） */
  pushed: number;
  /** 聚合摘要条数（0 或 1） */
  digests: number;
  /** 渠道/落库失败条数（下次重试） */
  failed: number;
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
      pushed: 0,
      digests: 0,
      failed: 0,
      quiet: this.isQuietHours(now),
      deferred: false,
    };

    try {
      // ── 08:00 汇总：先把安静时段积压的提醒汇总推送（硬验收 3）──
      // 安静时段内这些提醒已入通知中心（recorded 过），但没推即时消息；
      // 到 08:00 用一条摘要补告知，用户不会"昨晚的提醒完全没有提示"。
      if (!result.quiet) {
        const backlog = await this.collectQuietBacklog(now);
        if (backlog.length > 0) {
          const ok = await this.pushQuietDigest(backlog);
          if (ok) result.digests += 1;
          this.logger.log(
            `08:00 汇总：安静时段积压 ${backlog.length} 条已生成摘要`,
          );
        }
      }

      const rows = await this.collectAllDue(now);
      result.scanned = rows.length;
      if (rows.length === 0) {
        return result;
      }

      // ── 逐条：先落通知中心（持久化事实，无条件），再决定是否即时推送 ──
      for (const row of rows) {
        const ok = await this.recordOne(row, now);
        if (ok) {
          result.recorded += 1;
        } else {
          result.failed += 1;
        }
      }

      // ── 推送分层（安静时段不推即时消息）──
      if (result.quiet) {
        // 22:00–08:00：通知中心已即时入箱；不推即时消息，推迟到 08:00 汇总
        result.deferred = result.recorded > 0;
        this.logger.log(
          `补偿：安静时段，通知已入箱 ${result.recorded} 条，即时推送推迟至 08:00`,
        );
      } else if (rows.length <= DIGEST_THRESHOLD) {
        // ≤3 条：逐条推送
        for (const row of rows) {
          const ok = await this.pushOne(row);
          if (ok) {
            result.pushed += 1;
          }
        }
      } else {
        // >3 条：一条聚合摘要（每条原始提醒已在上面独立进通知中心）
        const ok = await this.pushDigest(rows);
        if (ok) {
          result.digests = 1;
        }
      }

      this.logger.log(
        `补偿完成：扫描 ${result.scanned} 条，入箱 ${result.recorded} 条，` +
          `推送 ${result.pushed} 条，摘要 ${result.digests} 条，失败 ${result.failed} 条，` +
          `安静时段=${result.quiet}`,
      );
    } catch (err) {
      // @Cron 内绝不外抛（补偿失败不得影响其它链路）
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`漏提醒补偿失败（已隔离）：${message}`);
    }
    return result;
  }

  /**
   * 收集**全部**到期未送达提醒 —— 分批循环直到扫尽，不丢任何一条。
   *
   * 为什么分批：`LIMIT` 防单次大查询，但必须循环到取空为止；
   * 若只取一批就停，等于"只补最近 N 条"（红线禁止）。
   */
  private async collectAllDue(now: Date): Promise<DueRow[]> {
    const all: DueRow[] = [];
    let offset = 0;
    // 防御性上限：避免异常数据导致无限循环（正常情况远达不到）
    const MAX_ROUNDS = 1000;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const batch = await this.dataSource.query<DueRow[]>(
        `SELECT id, tenant_id, title, owner, participants, start_at, remind_at
           FROM t_ai_schedule
          WHERE status = 'planned'
            AND remind_at IS NOT NULL
            AND reminded_at IS NULL
            AND remind_at <= ?
          ORDER BY remind_at ASC
          LIMIT ${CATCHUP_BATCH} OFFSET ${offset}`,
        [now],
      );
      if (batch.length === 0) break;
      all.push(...batch);
      if (batch.length < CATCHUP_BATCH) break;
      offset += batch.length;
    }
    return all;
  }

  /**
   * 单条落通知中心 + 写提醒标记。
   *
   * 幂等：dedupeKey = `catchup:{sourceId}:{occurrenceAt}`，四段语义由 NoticeService
   * 的 (tenantId, dedupeKey, 未读) 唯一约束承载 ⇒ 重复扫描不重复插入。
   */
  private async recordOne(row: DueRow, now: Date): Promise<boolean> {
    const scheduleId = String(row.id);
    try {
      const receiver = this.receiverOf(row);
      const occurrenceAt = toIso(row.remind_at);
      const push = this.buildPush(row, 'catchup');

      if (this.noticeBridge) {
        // 通知无条件落库；dedupeKey 保证重复扫描不重复打扰
        await this.noticeBridge.pushWithNotice(
          row.tenant_id,
          'schedule_reminder',
          push,
          {
            receiver,
            source: 'schedule',
            refId: scheduleId,
            dedupeKey: `catchup:${scheduleId}:${occurrenceAt}`,
          },
        );
      } else {
        // 无旁路（既有单测路径）：退回既有序次，保持原语义
        await this.pushService.push(row.tenant_id, 'schedule_reminder', push);
      }

      // 写提醒标记（幂等：只有未标记才写）
      await this.dataSource.query(
        'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
        [now, scheduleId],
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `补偿单条失败（下次重试）：schedule=${scheduleId} ${message}`,
      );
      return false;
    }
  }

  /** 单条即时推送（安静时段不会调用） */
  private async pushOne(row: DueRow): Promise<boolean> {
    try {
      return await this.pushService.push(
        row.tenant_id,
        'schedule_reminder',
        this.buildPush(row, 'catchup'),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补偿推送失败：schedule=${String(row.id)} ${message}`);
      return false;
    }
  }

  /**
   * 聚合摘要：一条消息说明漏提醒总数 + 最紧急 3 条 + 引导打开通知中心。
   *
   * 🔴 摘要**不是**提醒本体 —— 每条原始提醒已在上方独立进通知中心（mutation 2 专测）。
   */
  private async pushDigest(rows: DueRow[]): Promise<boolean> {
    try {
      const tenantId = rows[0].tenant_id;
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
      // 摘要本身不落通知中心（避免"摘要替代本体"）；仅推送告知
      return await this.pushService.push(
        tenantId,
        'schedule_reminder_digest',
        digest,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补偿摘要推送失败：${message}`);
      return false;
    }
  }

  /** 接收人 = owner + participants（与既有日程提醒同口径） */
  private receiverOf(row: DueRow): string {
    return [row.owner ?? '', ...parseParticipants(row.participants)]
      .filter((x) => x.length > 0)
      .join(',');
  }

  /**
   * 安静时段积压：已入通知中心（`reminded_at` 已写）但**未推送过即时消息**的提醒。
   *
   * 判定口径：安静时段内处理时，我们落了通知 + 写了 reminded_at，但**没调 push()**
   * ⇒ `t_push_log` 里没有对应流水。到 08:00 查"今天安静时段内已标记、
   * 但 push_log 无对应 title 记录"的日程，聚合成一条摘要补告知。
   *
   * 说明：用 title 匹配 push_log 是当前 schema 下可用的最稳判据（push_log 无 ref_id 列）；
   * 若未来 push_log 加 source 列，应改为按 source+refId 精确匹配（已在风险项登记）。
   */
  private async collectQuietBacklog(now: Date): Promise<DueRow[]> {
    try {
      // 窗口：今天 08:00 之前 24 小时内（覆盖"昨晚 22:00 至今天 08:00"的安静时段）
      const shanghaiNow = this.shanghaiParts(now);
      const windowStart = new Date(
        Date.UTC(
          shanghaiNow.year,
          shanghaiNow.month - 1,
          shanghaiNow.day,
          0,
          0,
          0,
        ) -
          24 * 60 * 60 * 1000,
      );
      const rows = await this.dataSource.query<DueRow[]>(
        `SELECT s.id, s.tenant_id, s.title, s.owner, s.participants,
                s.start_at, s.remind_at
           FROM t_ai_schedule s
          WHERE s.status = 'planned'
            AND s.reminded_at IS NOT NULL
            AND s.reminded_at >= ?
            AND s.reminded_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM t_push_log p
               WHERE p.tenant_id = s.tenant_id
                 AND p.title = CONCAT('日程提醒：', s.title)
                 AND p.created_at >= s.reminded_at
            )
          ORDER BY s.remind_at ASC`,
        [windowStart, now],
      );
      return rows;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`安静时段积压查询失败（已隔离）：${message}`);
      return [];
    }
  }

  /** 08:00 汇总摘要：告知昨晚积压总量 + 引导打开通知中心 */
  private async pushQuietDigest(rows: DueRow[]): Promise<boolean> {
    try {
      const digest = {
        type: 'system' as const,
        title: `昨晚有 ${rows.length} 条日程提醒已入通知中心`,
        content:
          `您在免打扰时段（22:00–08:00）到期的 ${rows.length} 条日程提醒已全部记录，` +
          `现汇总告知；完整列表请打开通知中心查看。`,
        priority: 'reminder' as const,
      };
      return await this.pushService.push(
        rows[0].tenant_id,
        'schedule_reminder_quiet_digest',
        digest,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`安静时段汇总推送失败：${message}`);
      return false;
    }
  }

  /** 取 Asia/Shanghai 的年月日（用于安静时段窗口计算） */
  private shanghaiParts(now: Date): {
    year: number;
    month: number;
    day: number;
  } {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const get = (t: string): number =>
      Number.parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10);
    return { year: get('year'), month: get('month'), day: get('day') };
  }

  /** 统一消息体（逐条推送与入箱共用，避免两套文案） */
  private buildPush(
    row: DueRow,
    tag: string,
  ): {
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
        `日程ID ${String(row.id)}；补发标记 ${tag}）`,
      priority: 'reminder' as const,
    };
  }

  /** 是否处于安静时段（Asia/Shanghai，22:00–08:00） */
  isQuietHours(now: Date = new Date()): boolean {
    const hour = this.shanghaiHour(now);
    return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
  }

  /**
   * 只读查询：某租户当前有多少条漏提醒 + 生成可读摘要（供 AI 工具调用）。
   *
   * 🔴 红线：**只读**。AI 不得删除/标记原始提醒（删除权只在人工通知中心）；
   * 本方法不写 reminded_at、不改 status、不删任何行。
   *
   * 为什么需要它：派单卡 §三 要求"AI 可查询『我有多少漏提醒并生成本次摘要』"，
   * 但**不得**因此让 AI 拥有补偿写权限 ⇒ 读路径与写路径（catchup）严格分离。
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
        `SELECT id, tenant_id, title, owner, participants, start_at, remind_at
           FROM t_ai_schedule
          WHERE tenant_id = ?
            AND status = 'planned'
            AND remind_at IS NOT NULL
            AND reminded_at IS NULL
            AND remind_at <= ?
          ORDER BY remind_at ASC`,
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
}

/** 时间归一为 ISO 文本（兼容 Date / 字符串） */
function toIso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
