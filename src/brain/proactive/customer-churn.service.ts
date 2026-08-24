/**
 * 客户流失预警巡检（A08）
 *
 * 触发机制：每日定时（早 9:30 @Cron('30 9 * * *')）
 * 检测逻辑（对齐能力说明书 3.8）：
 * - 老客户超过 30 天未下单（last_order_at < 当前日期 - 30 天）
 * - 风险分级：≥60 天 → 高；≥45 天 → 中；≥30 天 → 关注
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_member（会员客户表，last_order_at 最近下单时间）
 *
 * 推送优先级：suggestion（建议，静默推送）
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
import { toDateText, toNumber, toText } from './proactive.utils';

@Injectable()
export class CustomerChurnService implements IProactiveTask {
  readonly name = 'customer_churn';
  readonly description = '客户流失预警：超过 30 天未下单的客户分析';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '30 9 * * *';
  readonly priority: ProactivePriority = 'suggestion';
  readonly pushType: ProactivePushType = 'marketing';

  private readonly logger = new Logger(CustomerChurnService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const rows = await this.dataSource.query<Row[]>(
        `SELECT id,
                name,
                customer_type AS customerType,
                last_order_at AS lastOrderAt,
                DATEDIFF(CURDATE(), last_order_at) AS inactiveDays
         FROM t_member
         WHERE tenant_id = ?
           AND status = 1
           AND last_order_at IS NOT NULL
           AND last_order_at < DATE_SUB(CURDATE(), INTERVAL 30 DAY)
         ORDER BY last_order_at ASC
         LIMIT 20`,
        [tenantId],
      );

      if (!rows || rows.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const lines = rows
        .map((row) => {
          const days = toNumber(row.inactiveDays);
          const risk = days >= 60 ? '🔴 高' : days >= 45 ? '⚠️ 中' : '📅 关注';
          return `| ${toText(row.name, '-')} | ${toDateText(row.lastOrderAt)} | ${days} 天 | ${risk} |`;
        })
        .join('\n');

      const push: ProactivePush = {
        title: '⚠️ 客户流失预警',
        type: this.pushType,
        priority: this.priority,
        content: `以下客户超过 30 天未下单，存在流失风险：\n\n| 客户 | 上次下单 | 间隔 | 风险 |\n|------|----------|------|------|\n${lines}\n\n建议：电话回访或推送优惠活动`,
        extras: { taskName, count: rows.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `客户流失巡检完成：tenant=${tenantId} found=${rows.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: rows.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`客户流失巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
