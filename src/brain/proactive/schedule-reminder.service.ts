/**
 * ScheduleReminderService — 日程到期提醒（R101-AI-39 · 提醒路径）
 *
 * 归属：**proactive 域**（凌舟授权）—— 日程提醒本质是"主动巡检 + 推送"，与既有 9 项巡检同构；
 * `@Cron` 与 push 范式都在本域（`AppModule` 已 `ScheduleModule.forRoot()`）。
 *
 * 🔴 复用既有通道，**不新建调度/推送**：
 * - 调度：`@Cron('* * * * *')` 每分钟扫描（与既有巡检同款注解）
 * - 推送：`ProactivePushService.push(tenantId, 'schedule_reminder', {...})`
 *   （内部写 `t_push_log` + `pushGateway.broadcast`）
 *
 * ⚠️ **提醒范围边界（凌舟裁定 ①）**：本批为**租户级广播**——`push()` 现状把 `t_push_log.user_id`
 *    固定写 0，无法定向到个人 ⇒ **payload 里带 owner/participants 标识**，由前端自行过滤。
 *    "定向到人"（gateway 按用户路由 + user_id 写真值）⇒ **独立缺口，不在本批硬造**。
 *
 * 幂等：`reminded_at` 为提醒标记；**推送失败不写标记**（下次扫描重试），且失败**不影响日程本身**。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';

/** 单次扫描上限（防一次性推送风暴） */
const SCAN_LIMIT = 50;

interface DueRow {
  id: string | number;
  tenant_id: string;
  title: string;
  owner: string | null;
  participants: string | null;
  start_at: Date | string;
  remind_at: Date | string;
}

@Injectable()
export class ScheduleReminderService {
  private readonly logger = new Logger(ScheduleReminderService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  /**
   * 每分钟扫描到期日程并推送提醒
   *
   * **绝不抛**：任何异常都被隔离（提醒失败不得影响其它链路）；单条失败不阻断其余条目。
   */
  @Cron('* * * * *')
  async scanDueReminders(now: Date = new Date()): Promise<number> {
    let pushed = 0;
    try {
      const rows = await this.dataSource.query<DueRow[]>(
        `SELECT id, tenant_id, title, owner, participants, start_at, remind_at
           FROM t_ai_schedule
          WHERE status = 'planned'
            AND remind_at IS NOT NULL
            AND reminded_at IS NULL
            AND remind_at <= ?
          ORDER BY remind_at ASC
          LIMIT ${SCAN_LIMIT}`,
        [now],
      );

      for (const row of rows) {
        const ok = await this.pushOne(row);
        if (ok) pushed += 1;
      }
      if (rows.length > 0) {
        this.logger.log(
          `日程提醒扫描：候选 ${rows.length} 条，成功推送 ${pushed} 条`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 扫描失败不影响其它链路（@Cron 内绝不外抛）
      this.logger.warn(`日程提醒扫描失败（已隔离）：${message}`);
    }
    return pushed;
  }

  /** 推送单条并写提醒标记（**推送失败不写标记** ⇒ 下次重试） */
  private async pushOne(row: DueRow): Promise<boolean> {
    const scheduleId = String(row.id);
    try {
      const startText = toIso(row.start_at);
      const ok = await this.pushService.push(
        row.tenant_id,
        'schedule_reminder',
        {
          type: 'system',
          title: `日程提醒：${row.title}`,
          // ⚠️ 租户级广播：消息体带 owner/participants 供前端过滤（定向到人属独立缺口）
          content: `「${row.title}」将于 ${startText} 开始（归属人 ${row.owner ?? '-'}；参与者 ${row.participants ?? '-'}；日程ID ${scheduleId}）`,
          priority: 'reminder',
        },
      );
      if (!ok) {
        this.logger.warn(
          `日程提醒推送失败（不写标记，下次重试）：schedule=${scheduleId}`,
        );
        return false;
      }
      await this.dataSource.query(
        'UPDATE t_ai_schedule SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL',
        [new Date(), scheduleId],
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 单条失败不影响其余（主次不倒置：日程本身不受影响）
      this.logger.warn(
        `日程提醒异常（已隔离）：schedule=${scheduleId} ${message}`,
      );
      return false;
    }
  }
}

/** 时间归一为 ISO 文本（兼容 Date / 字符串） */
function toIso(v: Date | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}
