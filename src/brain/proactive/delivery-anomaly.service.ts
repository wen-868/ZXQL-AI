/**
 * 配送异常追踪巡检（A07）
 *
 * 触发机制：定时巡检（每 15 分钟 @Cron('* /15 * * * *')）
 * 检测逻辑（对齐能力说明书 3.7）：
 * - 取货超时：PENDING / ASSIGNED 状态创建超 30 分钟未取货
 * - 配送超时：PICKED_UP 后 45 分钟仍未送达
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_delivery_record（配送记录表：订单/配送单号/骑手/状态/取货时间）
 *
 * 推送优先级：urgent（紧急，配送严重超时立即推送）
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
import { toNumber, toText } from './proactive.utils';

@Injectable()
export class DeliveryAnomalyService implements IProactiveTask {
  readonly name = 'delivery_anomaly';
  readonly description = '配送异常追踪：取货超时 / 配送超时提醒';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '*/15 * * * *';
  readonly priority: ProactivePriority = 'urgent';
  readonly pushType: ProactivePushType = 'order';

  private readonly logger = new Logger(DeliveryAnomalyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const rows = await this.dataSource.query<Row[]>(
        `SELECT id,
                order_id AS orderId,
                delivery_no AS deliveryNo,
                delivery_type AS deliveryType,
                rider_name AS riderName,
                rider_phone AS riderPhone,
                status,
                TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS waitMinutes,
                TIMESTAMPDIFF(MINUTE, picked_up_at, NOW()) AS deliverMinutes
         FROM t_delivery_record
         WHERE tenant_id = ?
           AND status IN ('PENDING', 'ASSIGNED', 'PICKED_UP')
           AND (
             (status IN ('PENDING', 'ASSIGNED') AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE))
             OR (status = 'PICKED_UP' AND picked_up_at IS NOT NULL
                 AND picked_up_at < DATE_SUB(NOW(), INTERVAL 45 MINUTE))
           )
         ORDER BY created_at ASC
         LIMIT 20`,
        [tenantId],
      );

      if (!rows || rows.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const lines = rows
        .map((row) => {
          const status = toText(row.status);
          const wait = toNumber(row.waitMinutes);
          const deliver = toNumber(row.deliverMinutes);
          const detail =
            status === 'PICKED_UP'
              ? `配送超时 ${deliver} 分钟`
              : `取货超时，已等待 ${wait} 分钟`;
          return `| ${toText(row.deliveryNo, toText(row.orderId))} | ${toText(row.deliveryType)} | ${toText(row.riderName, '-')}（${toText(row.riderPhone, '-')}） | ${status} | ${detail} |`;
        })
        .join('\n');

      const push: ProactivePush = {
        title: '🚚 配送异常',
        type: this.pushType,
        priority: this.priority,
        content: `检测到 ${rows.length} 单配送异常：\n\n| 配送单 | 平台 | 骑手 | 状态 | 异常 |\n|--------|------|------|------|------|\n${lines}\n\n建议：联系骑手或更换配送平台`,
        extras: { taskName, count: rows.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `配送异常巡检完成：tenant=${tenantId} found=${rows.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: rows.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`配送异常巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
