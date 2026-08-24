/**
 * 智能补货建议巡检（A06）
 *
 * 触发机制：定时巡检（每 30 分钟 @Cron('* /30 * * * *')）
 * 检测逻辑（对齐能力说明书 3.6）：
 * - 基于近 30 天日均销量预测 + 当前库存 + 预警阈值
 * - 建议采购量 = max(预警阈值×2 - 当前库存, 日均销量×7 - 当前库存, 0)（保留 7 天销量 + 安全冗余）
 * - 紧急度：售罄（库存 0）→ urgent；低于安全线 → important；建议补货 → suggestion
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_inventory_balance（各门店库存余额，按 sku 汇总）
 * - t_product_sku（SKU 名称 + 预警阈值 + 箱瓶换算比）
 * - t_sale_bill_item / t_sale_bill（近 30 天销量，计算日均）
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
import { toNumber, toText } from './proactive.utils';

@Injectable()
export class ReplenishmentAdviceService implements IProactiveTask {
  readonly name = 'replenishment_advice';
  readonly description = '智能补货建议：基于销量预测 + 当前库存生成采购建议';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '*/30 * * * *';
  readonly priority: ProactivePriority = 'suggestion';
  readonly pushType: ProactivePushType = 'inventory';

  private readonly logger = new Logger(ReplenishmentAdviceService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const rows = await this.dataSource.query<Row[]>(
        `SELECT ib.sku_id AS skuId,
                sku.sku_name AS skuName,
                sku.warning_threshold AS warningThreshold,
                SUM(ib.available_qty) AS currentStock,
                IFNULL(d.dailyAvg, 0) AS dailyAvg,
                sku.box_ratio AS boxRatio
         FROM t_inventory_balance ib
         JOIN t_product_sku sku ON sku.id = ib.sku_id
         LEFT JOIN (
           SELECT si.sku_id, SUM(si.total_bottle_qty) / 30 AS dailyAvg
           FROM t_sale_bill_item si
           JOIN t_sale_bill sb ON sb.bill_no = si.bill_no
           WHERE sb.tenant_id = ?
             AND sb.created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
             AND sb.business_status IN ('CREATED', 'COMPLETED')
           GROUP BY si.sku_id
         ) d ON d.sku_id = ib.sku_id
         WHERE ib.tenant_id = ?
         GROUP BY ib.sku_id, sku.sku_name, sku.warning_threshold, d.dailyAvg, sku.box_ratio
         ORDER BY SUM(ib.available_qty) ASC
         LIMIT 30`,
        [tenantId, tenantId],
      );

      // 仅保留需要补货的商品（当前库存不足安全线或按销量预计不足 7 天）
      const needs = rows.filter((row) => {
        const current = toNumber(row.currentStock);
        const threshold = toNumber(row.warningThreshold);
        const dailyAvg = toNumber(row.dailyAvg);
        return current < threshold || (dailyAvg > 0 && current < dailyAvg * 7);
      });

      if (needs.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const lines = needs
        .map((row) => {
          const skuName = toText(row.skuName);
          const current = toNumber(row.currentStock);
          const threshold = toNumber(row.warningThreshold);
          const dailyAvg = toNumber(row.dailyAvg);
          const boxRatio = Math.max(toNumber(row.boxRatio, 1), 1);
          // 建议采购量（瓶）→ 按箱换算（至少 1 箱）
          const suggestedBottles = Math.max(
            threshold * 2 - current,
            Math.ceil(dailyAvg * 7) - current,
            0,
          );
          const suggestedBoxes = Math.max(
            Math.ceil(suggestedBottles / boxRatio),
            suggestedBottles > 0 ? 1 : 0,
          );
          const urgency =
            current <= 0
              ? '🔴 紧急'
              : current < threshold
                ? '⚠️ 建议'
                : '📅 关注';
          return `| ${skuName} | ${current} | ${dailyAvg.toFixed(1)} | ${suggestedBoxes} 箱 | ${urgency} |`;
        })
        .join('\n');

      const totalSuggested = needs.reduce((sum, row) => {
        const current = toNumber(row.currentStock);
        const threshold = toNumber(row.warningThreshold);
        const dailyAvg = toNumber(row.dailyAvg);
        return (
          sum +
          Math.max(
            threshold * 2 - current,
            Math.ceil(dailyAvg * 7) - current,
            0,
          )
        );
      }, 0);

      const push: ProactivePush = {
        title: '💡 智能补货建议',
        type: this.pushType,
        priority: this.priority,
        content: `基于近 30 天销量分析，建议以下商品补货：\n\n| 商品 | 当前库存 | 日均销量 | 建议采购 | 紧急度 |\n|------|----------|----------|----------|--------|\n${lines}\n\n建议采购量合计：约 ${totalSuggested} 瓶`,
        extras: { taskName, count: needs.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `补货建议巡检完成：tenant=${tenantId} found=${needs.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: needs.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`补货建议巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
