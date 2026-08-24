/**
 * 库存预警巡检（A01）
 *
 * 触发机制：定时巡检（每 30 分钟 @Cron('* /30 * * * *')）
 * 检测逻辑（对齐能力说明书 3.1）：
 * - 当前库存 ≤ 安全阈值（t_product_sku.warning_threshold）
 * - 近 7 天日均销量 > 当前库存 → 预计 3 天内售罄
 *
 * 数据来源（共享 MySQL，多租户按 tenant_id 隔离）：
 * - t_inventory_balance（各门店库存余额，按 sku 汇总）
 * - t_product_sku（SKU 名称 + 预警阈值）
 * - t_sale_bill_item / t_sale_bill（近 7 天销量，计算日均）
 *
 * 推送优先级：urgent（紧急，库存售罄/偏低立即推送）
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
export class InventoryWarningService implements IProactiveTask {
  readonly name = 'inventory_warning';
  readonly description = '库存预警：库存低于安全线或预计 3 天内售罄';
  readonly scheduleType = 'cron' as const;
  readonly schedule = '*/30 * * * *';
  readonly priority: ProactivePriority = 'urgent';
  readonly pushType: ProactivePushType = 'inventory';

  private readonly logger = new Logger(InventoryWarningService.name);

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
                IFNULL(d.dailyAvg, 0) AS dailyAvg
         FROM t_inventory_balance ib
         JOIN t_product_sku sku ON sku.id = ib.sku_id
         LEFT JOIN (
           SELECT si.sku_id, SUM(si.total_bottle_qty) / 7 AS dailyAvg
           FROM t_sale_bill_item si
           JOIN t_sale_bill sb ON sb.bill_no = si.bill_no
           WHERE sb.tenant_id = ?
             AND sb.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
             AND sb.business_status IN ('CREATED', 'COMPLETED')
           GROUP BY si.sku_id
         ) d ON d.sku_id = ib.sku_id
         WHERE ib.tenant_id = ?
           AND ib.available_qty <= sku.warning_threshold
         GROUP BY ib.sku_id, sku.sku_name, sku.warning_threshold, d.dailyAvg
         ORDER BY SUM(ib.available_qty) - sku.warning_threshold ASC
         LIMIT 30`,
        [tenantId, tenantId],
      );

      if (!rows || rows.length === 0) {
        return { taskName, tenantId, found: 0, pushed: 0 };
      }

      const lines = rows
        .map((row) => {
          const skuName = toText(row.skuName);
          const current = toNumber(row.currentStock);
          const threshold = toNumber(row.warningThreshold);
          const dailyAvg = toNumber(row.dailyAvg);
          const sellOutDays =
            dailyAvg > 0 ? Math.max(Math.ceil(current / dailyAvg), 0) : null;
          const sellOutText =
            sellOutDays === null
              ? '-'
              : sellOutDays === 0
                ? '今天 ⚠️'
                : `${sellOutDays}天`;
          return `| ${skuName} | ${current} | ${threshold} | ${dailyAvg} | ${sellOutText} |`;
        })
        .join('\n');

      const push: ProactivePush = {
        title: '⚠️ 库存预警',
        type: this.pushType,
        priority: this.priority,
        content: `以下商品库存不足，建议尽快补货：\n\n| 商品 | 当前库存 | 安全线 | 日均销量 | 预计售罄 |\n|------|----------|--------|----------|----------|\n${lines}`,
        extras: { taskName, count: rows.length },
      };

      const pushed = await this.pushService.push(tenantId, taskName, push);
      this.logger.debug(
        `库存预警巡检完成：tenant=${tenantId} found=${rows.length} pushed=${pushed ? 1 : 0}`,
      );
      return {
        taskName,
        tenantId,
        found: rows.length,
        pushed: pushed ? 1 : 0,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`库存预警巡检失败：tenant=${tenantId} ${message}`);
      return { taskName, tenantId, found: 0, pushed: 0, error: message };
    }
  }
}
