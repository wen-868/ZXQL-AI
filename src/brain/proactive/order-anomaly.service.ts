/**
 * 订单异常巡检（A02）
 *
 * 触发机制：定时巡检（每 15 分钟 @Cron('* /15 * * * *')）
 * 检测逻辑（对齐能力说明书 3.2）：
 * - 订单积压：PENDING_PAYMENT（待支付）状态超过 30 分钟未处理
 * - 发货超时：已支付（pay_status=PAID）超过 2 小时仍未发货（delivery_status=WAITING）
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_miniapp_order（小程序线上订单）
 *
 * 推送优先级：important（重要，订单积压/发货超时立即推送）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProactivePushService } from './proactive-push.service';
// R101-AI-43 S4：站内通知落库（"先落通知，再推送"）
import { NoticeService } from './notice.service';
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
export class OrderAnomalyService implements IProactiveTask {
  readonly name = 'order_anomaly';
  readonly description =
    '订单异常提醒：待支付超 30 分钟 / 已支付超 2 小时未发货';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '*/15 * * * *';
  readonly priority: ProactivePriority = 'important';
  readonly pushType: ProactivePushType = 'order';

  private readonly logger = new Logger(OrderAnomalyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
    // R101-AI-43 S4：@Optional ⇒ 既有 spec 零改动
    @Optional() private readonly noticeService?: NoticeService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      // ── 1. 待支付超 30 分钟（订单积压） ──
      const pendingRows = await this.dataSource.query<Row[]>(
        `SELECT order_no AS orderNo, order_status AS orderStatus,
                TIMESTAMPDIFF(MINUTE, created_at, NOW()) AS waitMinutes
         FROM t_miniapp_order
         WHERE tenant_id = ?
           AND order_status = 'PENDING_PAYMENT'
           AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
         ORDER BY created_at ASC
         LIMIT 20`,
        [tenantId],
      );

      // ── 2. 已支付超 2 小时未发货（发货超时） ──
      const shippingRows = await this.dataSource.query<Row[]>(
        `SELECT order_no AS orderNo, delivery_status AS deliveryStatus,
                TIMESTAMPDIFF(HOUR, paid_at, NOW()) AS paidHours
         FROM t_miniapp_order
         WHERE tenant_id = ?
           AND pay_status = 'PAID'
           AND delivery_status = 'WAITING'
           AND paid_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
         ORDER BY paid_at ASC
         LIMIT 20`,
        [tenantId],
      );

      const total = (pendingRows?.length ?? 0) + (shippingRows?.length ?? 0);
      if (total === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const sections: string[] = [];

      if (shippingRows && shippingRows.length > 0) {
        sections.push(
          '发货超时（已支付超 2 小时未发货）：\n' +
            '| 订单号 | 配送状态 | 已等待 |\n|--------|----------|--------|\n' +
            shippingRows
              .map(
                (row) =>
                  `| ${toText(row.orderNo)} | ${toText(row.deliveryStatus)} | ${toNumber(row.paidHours)} 小时 |`,
              )
              .join('\n'),
        );
      }

      if (pendingRows && pendingRows.length > 0) {
        sections.push(
          '订单积压（待支付超 30 分钟）：\n' +
            '| 订单号 | 状态 | 已等待 |\n|--------|------|--------|\n' +
            pendingRows
              .map(
                (row) =>
                  `| ${toText(row.orderNo)} | ${toText(row.orderStatus)} | ${toNumber(row.waitMinutes)} 分钟 |`,
              )
              .join('\n'),
        );
      }

      const push: ProactivePush = {
        title: '🔴 订单异常提醒',
        type: this.pushType,
        priority: this.priority,
        content: `检测到 ${total} 笔异常订单：\n\n${sections.join('\n\n')}`,
        extras: { taskName, count: total },
      };

      // ── R101-AI-43 S4：先落站内通知（无条件，不依赖 push 成败）──
      // 巡检是租户级广播 ⇒ receiver = `tenant:{id}`（List/Count 第 4 支命中）
      // 主次不倒置：record 已吞异常，这里再包 try ⇒ 通知失败绝不误报"巡检失败"
      if (this.noticeService) {
        try {
          await this.noticeService.record({
            tenantId,
            receiver: `tenant:${tenantId}`,
            title: push.title,
            content: push.content,
            type: push.type,
            priority: push.priority,
            source: 'biz',
            refId: null,
            // 时间桶：同租户同日只落一条
            dedupeKey: `order-anomaly:${tenantId}:${new Date().toISOString().slice(0, 10)}`,
          });
        } catch {
          this.logger.warn('订单异常：站内通知落库失败（已隔离，不影响巡检）');
        }
      }

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `订单异常巡检完成：tenant=${tenantId} found=${total} pushed=${pushed ? 1 : 0}`,
      );
      return { taskName, tenantId, found: total, pushed: pushed ? 1 : 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`订单异常巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
