/**
 * 应收账款催收巡检（A03）
 *
 * 触发机制：每日定时（早 9:00 @Cron('0 9 * * *')）
 * 检测逻辑（对齐能力说明书 3.3）：
 * - 逾期账款：赊销单 due_date 已过但仍未收清（OVERDUE）
 * - 即将到期：due_date 在未来 3 天内（DUE_SOON）
 * - 临近到期：due_date 在未来 7 天内（UPCOMING）
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_sale_bill（线下销售单，sale_type=CREDIT 赊销 + collection_status 未收清）
 *
 * 推送优先级：reminder（提醒，每日定时推送催收提醒）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
import {
  IProactiveTask,
  ProactivePriority,
  ProactivePush,
  ProactivePushType,
  ProactiveTaskResult,
  Row,
} from './proactive.types';
import { toDateText, toMoneyText, toNumber, toText } from './proactive.utils';

@Injectable()
export class ReceivableReminderService implements IProactiveTask {
  readonly name = 'receivable_reminder';
  readonly description = '应收账款催收：逾期 / 即将到期账款每日提醒';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '0 9 * * *';
  readonly priority: ProactivePriority = 'reminder';
  readonly pushType: ProactivePushType = 'system';

  private readonly logger = new Logger(ReceivableReminderService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const rows = await this.dataSource.query<Row[]>(
        `SELECT bill_no AS billNo,
                customer_name AS customerName,
                receivable_amount AS receivableAmount,
                unreceived_amount AS unreceivedAmount,
                due_date AS dueDate,
                CASE
                  WHEN due_date < CURDATE() THEN 'OVERDUE'
                  WHEN due_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY) THEN 'DUE_SOON'
                  ELSE 'UPCOMING'
                END AS remindStatus,
                DATEDIFF(CURDATE(), due_date) AS overdueDays
         FROM t_sale_bill
         WHERE tenant_id = ?
           AND sale_type = 'CREDIT'
           AND collection_status IN ('UNPAID', 'PARTIAL', 'OVERDUE')
           AND due_date IS NOT NULL
           AND due_date <= DATE_ADD(CURDATE(), INTERVAL 7 DAY)
         ORDER BY due_date ASC
         LIMIT 30`,
        [tenantId],
      );

      if (!rows || rows.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const statusText: Record<string, string> = {
        OVERDUE: '🔴 已逾期',
        DUE_SOON: '⚠️ 即将到期',
        UPCOMING: '📅 临近到期',
      };

      const lines = rows
        .map((row) => {
          const status = toText(row.remindStatus, 'UPCOMING');
          const overdueDays = toNumber(row.overdueDays);
          const detail =
            status === 'OVERDUE'
              ? `逾期 ${overdueDays} 天`
              : `${Math.max(overdueDays, 0)} 天后到期`;
          return `| ${toText(row.customerName)} | ¥${toMoneyText(toNumber(row.unreceivedAmount))} | ${toDateText(row.dueDate)} | ${statusText[status] ?? status} ${detail} |`;
        })
        .join('\n');

      // 合计待收 + 逾期金额
      const totalUnreceived = rows.reduce(
        (sum, row) => sum + toNumber(row.unreceivedAmount),
        0,
      );
      const totalOverdue = rows
        .filter((row) => toText(row.remindStatus) === 'OVERDUE')
        .reduce((sum, row) => sum + toNumber(row.unreceivedAmount), 0);

      const today = new Date().toISOString().slice(0, 10);

      const push: ProactivePush = {
        title: `💰 应收账款提醒（${today}）`,
        type: this.pushType,
        priority: this.priority,
        content: `以下客户账款已逾期或即将到期：\n\n| 客户 | 未收金额 | 到期日 | 状态 |\n|------|----------|--------|------|\n${lines}\n\n合计待收：¥${toMoneyText(totalUnreceived)} | 逾期：¥${toMoneyText(totalOverdue)}`,
        extras: { taskName, count: rows.length, totalUnreceived },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `应收催收巡检完成：tenant=${tenantId} found=${rows.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: rows.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`应收催收巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
