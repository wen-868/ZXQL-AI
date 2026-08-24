/**
 * 经营异常检测巡检（A04）
 *
 * 触发机制：每日定时（早 8:00 @Cron('0 8 * * *')）
 * 检测逻辑（对齐能力说明书 3.4）：
 * - 销售额异常：今日销售额 < 近 30 天日均销售额 × 50%（昨日全天 vs 近30日均值更稳定，此处用昨日对比）
 * - 订单量异常：今日订单量 < 近 30 天日均订单量 × 50%
 *
 * 说明：为避免"今日刚开始营业数据为 0"误报，对比基准取「昨日全天」与「近 30 天日均（不含昨日）」。
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_sale_bill（销售单：昨日汇总 + 近 30 天日均）
 *
 * 推送优先级：important（重要，经营指标偏离立即推送）
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
export class BusinessAnomalyService implements IProactiveTask {
  readonly name = 'business_anomaly';
  readonly description = '经营异常检测：销售额/订单量偏离近 30 天均值';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '0 8 * * *';
  readonly priority: ProactivePriority = 'important';
  readonly pushType: ProactivePushType = 'system';

  private readonly logger = new Logger(BusinessAnomalyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const [yesterday, avg] = await Promise.all([
        this.queryDailySummary(tenantId, 'YESTERDAY'),
        this.queryDailySummary(tenantId, 'AVG_30D'),
      ]);

      const anomalies: string[] = [];
      const lines: string[] = [];

      // 销售额偏差
      const salesRatio =
        avg.salesAmount > 0
          ? (yesterday.salesAmount / avg.salesAmount) * 100
          : null;
      if (salesRatio !== null && salesRatio < 50) {
        anomalies.push(`销售额异常偏低（仅为均值 ${Math.round(salesRatio)}%）`);
        lines.push(
          `| 销售额 | ¥${toMoneyText(yesterday.salesAmount)} | ¥${toMoneyText(Math.round(avg.salesAmount))} | ${Math.round(salesRatio - 100)}% 🔴 |`,
        );
      } else if (salesRatio !== null && salesRatio > 200) {
        anomalies.push(`销售额异常偏高（为均值 ${Math.round(salesRatio)}%）`);
        lines.push(
          `| 销售额 | ¥${toMoneyText(yesterday.salesAmount)} | ¥${toMoneyText(Math.round(avg.salesAmount))} | +${Math.round(salesRatio - 100)}% 🔴 |`,
        );
      }

      // 订单量偏差
      const orderRatio =
        avg.orderCount > 0
          ? (yesterday.orderCount / avg.orderCount) * 100
          : null;
      if (orderRatio !== null && orderRatio < 50) {
        anomalies.push(`订单量异常偏低（仅为均值 ${Math.round(orderRatio)}%）`);
        lines.push(
          `| 订单数 | ${yesterday.orderCount} 笔 | ${avg.orderCount.toFixed(1)} 笔 | ${Math.round(orderRatio - 100)}% 🔴 |`,
        );
      }

      if (anomalies.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const push: ProactivePush = {
        title: '⚠️ 经营异常检测',
        type: this.pushType,
        priority: this.priority,
        content: `昨日经营指标异常：\n\n| 指标 | 昨日 | 近 30 天日均 | 偏差 |\n|------|------|-------------|------|\n${lines.join('\n')}\n\n可能原因：${anomalies.join('；')}，请检查是否有异常情况。`,
        extras: { taskName, count: anomalies.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `经营异常巡检完成：tenant=${tenantId} found=${anomalies.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: anomalies.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`经营异常巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }

  /**
   * 查询单日/近 30 天日均销售汇总
   *
   * @param tenantId 租户 ID
   * @param mode YESTERDAY-昨日全天 / AVG_30D-近 30 天日均（不含昨日）
   */
  private async queryDailySummary(
    tenantId: string,
    mode: 'YESTERDAY' | 'AVG_30D',
  ): Promise<{ salesAmount: number; orderCount: number }> {
    const where =
      mode === 'YESTERDAY'
        ? `DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY)`
        : `created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND DATE(created_at) < DATE_SUB(CURDATE(), INTERVAL 1 DAY)`;
    const divisor = mode === 'YESTERDAY' ? 1 : 30;

    const rows = await this.dataSource.query<Row[]>(
      `SELECT IFNULL(SUM(receivable_amount), 0) AS salesAmount,
              COUNT(*) AS orderCount
       FROM t_sale_bill
       WHERE tenant_id = ?
         AND ${where}
         AND business_status IN ('CREATED', 'COMPLETED')`,
      [tenantId],
    );

    const row = rows?.[0];
    return {
      salesAmount: toNumber(row?.salesAmount) / divisor,
      orderCount: toNumber(row?.orderCount) / divisor,
    };
  }
}
