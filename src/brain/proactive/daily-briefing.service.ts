/**
 * 每日经营简报巡检（A05）
 *
 * 触发机制：每日定时（早 8:30 @Cron('30 8 * * *')）
 * 检测逻辑（对齐能力说明书 3.5）：
 * - 昨日回顾：销售额 / 订单数 / 环比（相对今日实时累计）
 * - 今日待办：待处理订单数 / 库存预警数 / 逾期应收数 / 配送异常数
 * - AI 建议：基于昨日销售额与待办事项生成简单经营建议
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_sale_bill（销售单，昨日/今日汇总 + 逾期应收）
 * - t_miniapp_order（线上订单，待支付数）
 * - t_inventory_balance / t_product_sku（库存预警数）
 * - t_delivery_record（配送异常数）
 *
 * 推送优先级：reminder（提醒，每日定时推送）
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
import { toMoneyText, toNumber } from './proactive.utils';

@Injectable()
export class DailyBriefingService implements IProactiveTask {
  readonly name = 'daily_briefing';
  readonly description = '每日经营简报：昨日数据 + 今日待办 + AI 建议';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '30 8 * * *';
  readonly priority: ProactivePriority = 'reminder';
  readonly pushType: ProactivePushType = 'system';

  private readonly logger = new Logger(DailyBriefingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const [
        yesterday,
        today,
        pendingOrders,
        warningCount,
        overdueCount,
        deliveryCount,
      ] = await Promise.all([
        this.queryYesterdaySummary(tenantId),
        this.queryTodaySummary(tenantId),
        this.queryPendingOrderCount(tenantId),
        this.queryInventoryWarningCount(tenantId),
        this.queryOverdueReceivableCount(tenantId),
        this.queryDeliveryAnomalyCount(tenantId),
      ]);

      const found = pendingOrders + warningCount + overdueCount + deliveryCount;

      // 环比：相对昨日（今日累计 vs 昨日全天）
      const yesterdaySales = yesterday.salesAmount;
      const todaySales = today.salesAmount;
      const salesChange =
        yesterdaySales > 0
          ? Math.round(((todaySales - yesterdaySales) / yesterdaySales) * 100)
          : null;

      // ── 昨日回顾 ──
      const reviewLines = [
        `| 指标 | 数值 | 环比（今日实时） |`,
        `|------|------|------|`,
        `| 昨日销售额 | ¥${toMoneyText(yesterdaySales)} | ${salesChange === null ? '-' : salesChange >= 0 ? `+${salesChange}%` : `${salesChange}%`} |`,
        `| 昨日订单数 | ${yesterday.orderCount} 笔 | 今日已 ${today.orderCount} 笔 |`,
      ];

      // ── 今日待办 ──
      const todoItems: string[] = [];
      if (pendingOrders > 0) {
        todoItems.push(`1. ⚠️ ${pendingOrders} 笔订单待处理`);
      }
      if (warningCount > 0) {
        todoItems.push(`2. ⚠️ ${warningCount} 个商品库存不足需补货`);
      }
      if (overdueCount > 0) {
        todoItems.push(`3. 💰 ${overdueCount} 笔应收已逾期`);
      }
      if (deliveryCount > 0) {
        todoItems.push(`4. 🚚 ${deliveryCount} 单配送异常待处理`);
      }
      if (todoItems.length === 0) {
        todoItems.push('暂无待办事项，经营状态良好');
      }

      // ── AI 建议（简单规则生成） ──
      const adviceItems: string[] = [];
      if (warningCount > 0) {
        adviceItems.push(
          `1. 有 ${warningCount} 个商品库存低于安全线，建议今日安排补货`,
        );
      }
      if (overdueCount > 0) {
        adviceItems.push(`2. 有 ${overdueCount} 笔应收已逾期，建议安排催收`);
      }
      if (salesChange !== null && salesChange < 0) {
        adviceItems.push(
          `3. 当前销售额低于昨日 ${Math.abs(salesChange)}%，建议关注客流与营销活动`,
        );
      }
      if (adviceItems.length === 0) {
        adviceItems.push('经营数据平稳，暂无特别建议');
      }

      const todayText = new Date().toISOString().slice(0, 10);
      const push: ProactivePush = {
        title: `📊 每日经营简报（${todayText}）`,
        type: this.pushType,
        priority: this.priority,
        content: [
          '📈 昨日回顾',
          reviewLines.join('\n'),
          '',
          '📋 今日待办',
          todoItems.join('\n'),
          '',
          '💡 AI 建议',
          adviceItems.join('\n'),
        ].join('\n'),
        extras: { taskName, found },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `每日简报巡检完成：tenant=${tenantId} found=${found} pushed=${pushed ? 1 : 0}`,
      );
      return { taskName, tenantId, found, pushed: pushed ? 1 : 0 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`每日简报巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }

  /** 昨日销售汇总（销售额 + 订单数） */
  private async queryYesterdaySummary(
    tenantId: string,
  ): Promise<{ salesAmount: number; orderCount: number }> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT IFNULL(SUM(receivable_amount), 0) AS salesAmount,
              COUNT(*) AS orderCount
       FROM t_sale_bill
       WHERE tenant_id = ?
         AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)
         AND business_status IN ('CREATED', 'COMPLETED')`,
      [tenantId],
    );
    const row = rows?.[0];
    return {
      salesAmount: toNumber(row?.salesAmount),
      orderCount: toNumber(row?.orderCount),
    };
  }

  /** 今日销售汇总（环比基准） */
  private async queryTodaySummary(
    tenantId: string,
  ): Promise<{ salesAmount: number; orderCount: number }> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT IFNULL(SUM(receivable_amount), 0) AS salesAmount,
              COUNT(*) AS orderCount
       FROM t_sale_bill
       WHERE tenant_id = ?
         AND DATE(created_at) = CURDATE()
         AND business_status IN ('CREATED', 'COMPLETED')`,
      [tenantId],
    );
    const row = rows?.[0];
    return {
      salesAmount: toNumber(row?.salesAmount),
      orderCount: toNumber(row?.orderCount),
    };
  }

  /** 待处理订单数（待支付） */
  private async queryPendingOrderCount(tenantId: string): Promise<number> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT COUNT(*) AS cnt
       FROM t_miniapp_order
       WHERE tenant_id = ? AND order_status = 'PENDING_PAYMENT'`,
      [tenantId],
    );
    return toNumber(rows?.[0]?.cnt);
  }

  /** 库存预警商品数（可用库存 ≤ 安全阈值） */
  private async queryInventoryWarningCount(tenantId: string): Promise<number> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT COUNT(*) AS cnt
       FROM t_inventory_balance ib
       JOIN t_product_sku sku ON sku.id = ib.sku_id
       WHERE ib.tenant_id = ?
         AND ib.available_qty <= sku.warning_threshold`,
      [tenantId],
    );
    return toNumber(rows?.[0]?.cnt);
  }

  /** 逾期应收笔数（赊销 + 未收清 + 已过账期） */
  private async queryOverdueReceivableCount(tenantId: string): Promise<number> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT COUNT(*) AS cnt
       FROM t_sale_bill
       WHERE tenant_id = ?
         AND sale_type = 'CREDIT'
         AND collection_status IN ('UNPAID', 'PARTIAL', 'OVERDUE')
         AND due_date IS NOT NULL
         AND due_date < CURDATE()`,
      [tenantId],
    );
    return toNumber(rows?.[0]?.cnt);
  }

  /** 配送异常记录数（取货超 30 分钟） */
  private async queryDeliveryAnomalyCount(tenantId: string): Promise<number> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT COUNT(*) AS cnt
       FROM t_delivery_record
       WHERE tenant_id = ?
         AND status IN ('PENDING', 'ASSIGNED')
         AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
      [tenantId],
    );
    return toNumber(rows?.[0]?.cnt);
  }
}
