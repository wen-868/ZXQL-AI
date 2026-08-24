/**
 * 毛利异常检测巡检（A09）
 *
 * 触发机制：每日定时（早 8:00 @Cron('0 8 * * *')）
 * 检测逻辑（对齐能力说明书 3.9）：
 * - 售价低于成本价（unit_price <= cost_price）→ 毛利为负
 * - 毛利率低于 10%（margin_rate < 10%）→ 低毛利交易
 *
 * 成本价来源：t_inventory_batch 该 SKU 最新一批次的成本价（cost_price）
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_sale_bill_item（销售单明细：成交单价）
 * - t_sale_bill（销售单：租户隔离 + 日期范围）
 * - t_inventory_batch（库存批次：成本价，取每个 SKU 最新批次）
 *
 * 推送优先级：important（重要，低毛利交易立即推送）
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
export class GrossMarginAnomalyService implements IProactiveTask {
  readonly name = 'gross_margin_anomaly';
  readonly description = '毛利异常检测：售价低于成本价或毛利率低于 10%';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '0 8 * * *';
  readonly priority: ProactivePriority = 'important';
  readonly pushType: ProactivePushType = 'system';

  private readonly logger = new Logger(GrossMarginAnomalyService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
  ) {}

  async execute(tenantId: string): Promise<ProactiveTaskResult> {
    const taskName = this.name;
    try {
      const rows = await this.dataSource.query<Row[]>(
        `SELECT si.bill_no AS billNo,
                si.sku_name AS skuName,
                si.unit_price AS unitPrice,
                COALESCE(cb.costPrice, 0) AS costPrice,
                ROUND(
                  (si.unit_price - COALESCE(cb.costPrice, 0)) / NULLIF(si.unit_price, 0) * 100,
                  2
                ) AS marginRate
         FROM t_sale_bill_item si
         JOIN t_sale_bill sb ON sb.bill_no = si.bill_no
         LEFT JOIN (
           SELECT b.sku_id, b.cost_price AS costPrice
           FROM t_inventory_batch b
           INNER JOIN (
             SELECT sku_id, MAX(id) AS maxId
             FROM t_inventory_batch
             GROUP BY sku_id
           ) latest ON latest.maxId = b.id
         ) cb ON cb.sku_id = si.sku_id
         WHERE sb.tenant_id = ?
           AND DATE(sb.created_at) = CURDATE()
           AND sb.business_status IN ('CREATED', 'COMPLETED')
           AND si.unit_price > 0
           AND (
             (COALESCE(cb.costPrice, 0) > 0
              AND ROUND((si.unit_price - cb.costPrice) / si.unit_price * 100, 2) < 10)
           )
         ORDER BY si.bill_no ASC
         LIMIT 20`,
        [tenantId],
      );

      if (!rows || rows.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const lines = rows
        .map((row) => {
          const unitPrice = toNumber(row.unitPrice);
          const costPrice = toNumber(row.costPrice);
          const marginRate = toNumber(row.marginRate);
          const negative = costPrice > 0 && unitPrice <= costPrice;
          return `| ${toText(row.billNo)} | ${toText(row.skuName)} | ¥${unitPrice.toFixed(2)} | ¥${costPrice.toFixed(2)} | ${marginRate.toFixed(1)}%（${negative ? '负毛利' : '正常 25%'}） |`;
        })
        .join('\n');

      const push: ProactivePush = {
        title: '⚠️ 毛利异常',
        type: this.pushType,
        priority: this.priority,
        content: `检测到 ${rows.length} 笔低毛利交易：\n\n| 单号 | 商品 | 售价 | 成本价 | 毛利率 |\n|------|------|------|--------|--------|\n${lines}\n\n建议：确认是否价格录入错误`,
        extras: { taskName, count: rows.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `毛利异常巡检完成：tenant=${tenantId} found=${rows.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: rows.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`毛利异常巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
