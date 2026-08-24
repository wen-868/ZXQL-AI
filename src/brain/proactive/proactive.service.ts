/**
 * ProactiveService — 主动能力调度器
 *
 * 职责：
 * 1. 通过 @Cron 声明 9 项定时巡检任务（对齐能力说明书 5.2 Cron 配置）
 * 2. 每次调度对所有启用租户逐一执行（单租户失败不中断，try-catch 兜底）
 * 3. 防重入：同一任务并发调度时跳过（running Set）
 * 4. 记录最近运行时间与结果摘要（ProactiveController GET /jobs 展示）
 * 5. 支持手动触发：POST /api/admin/proactive/jobs/:name/run
 *
 * 定时配置：
 * - inventory_warning（库存预警）：每 30 分钟  * /30 * * * *
 * - order_anomaly（订单异常）：    每 15 分钟  * /15 * * * *
 * - receivable_reminder（应收催收）：每日 9:00  0 9 * * *
 * - daily_briefing（每日简报）：    每日 8:30  30 8 * * *
 * - business_anomaly（经营异常）：  每日 8:00  0 8 * * *
 * - replenishment_advice（智能补货）：每 30 分钟  * /30 * * * *
 * - delivery_anomaly（配送异常）：  每 15 分钟  * /15 * * * *
 * - customer_churn（客户流失）：    每日 9:30  30 9 * * *
 * - gross_margin_anomaly（毛利异常）：每日 8:00  0 8 * * *
 *
 * 租户来源：t_tenant 表（status = 'ACTIVE'），tenant_id 与业务表对齐
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  IProactiveTask,
  ProactiveJobInfo,
  ProactiveTaskResult,
  Row,
} from './proactive.types';
import { toText } from './proactive.utils';
import { InventoryWarningService } from './inventory-warning.service';
import { OrderAnomalyService } from './order-anomaly.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { DailyBriefingService } from './daily-briefing.service';
import { BusinessAnomalyService } from './business-anomaly.service';
import { ReplenishmentAdviceService } from './replenishment-advice.service';
import { DeliveryAnomalyService } from './delivery-anomaly.service';
import { CustomerChurnService } from './customer-churn.service';
import { GrossMarginAnomalyService } from './gross-margin-anomaly.service';

@Injectable()
export class ProactiveService {
  private readonly logger = new Logger(ProactiveService.name);

  /** 正在运行的任务集合（防重入） */
  private readonly running = new Set<string>();
  /** 最近运行时间（任务名 → ISO 字符串） */
  private readonly lastRunAt = new Map<string, string>();
  /** 最近运行结果摘要（任务名 → 摘要） */
  private readonly lastResult = new Map<string, string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly inventoryWarningService: InventoryWarningService,
    private readonly orderAnomalyService: OrderAnomalyService,
    private readonly receivableReminderService: ReceivableReminderService,
    private readonly dailyBriefingService: DailyBriefingService,
    private readonly businessAnomalyService: BusinessAnomalyService,
    private readonly replenishmentAdviceService: ReplenishmentAdviceService,
    private readonly deliveryAnomalyService: DeliveryAnomalyService,
    private readonly customerChurnService: CustomerChurnService,
    private readonly grossMarginAnomalyService: GrossMarginAnomalyService,
  ) {}

  /** 全部巡检任务（顺序即展示顺序） */
  get tasks(): IProactiveTask[] {
    return [
      this.inventoryWarningService,
      this.orderAnomalyService,
      this.receivableReminderService,
      this.dailyBriefingService,
      this.businessAnomalyService,
      this.replenishmentAdviceService,
      this.deliveryAnomalyService,
      this.customerChurnService,
      this.grossMarginAnomalyService,
    ];
  }

  // ──────────────────────────────────────────────
  // @Cron 定时调度（对齐能力说明书 5.2）
  // ──────────────────────────────────────────────

  /** 库存预警：每 30 分钟 */
  @Cron('*/30 * * * *')
  async cronInventoryWarning(): Promise<void> {
    await this.runForAllTenants(this.inventoryWarningService);
  }

  /** 订单异常：每 15 分钟 */
  @Cron('*/15 * * * *')
  async cronOrderAnomaly(): Promise<void> {
    await this.runForAllTenants(this.orderAnomalyService);
  }

  /** 应收催收：每日 9:00 */
  @Cron('0 9 * * *')
  async cronReceivableReminder(): Promise<void> {
    await this.runForAllTenants(this.receivableReminderService);
  }

  /** 每日简报：每日 8:30 */
  @Cron('30 8 * * *')
  async cronDailyBriefing(): Promise<void> {
    await this.runForAllTenants(this.dailyBriefingService);
  }

  /** 经营异常：每日 8:00 */
  @Cron('0 8 * * *')
  async cronBusinessAnomaly(): Promise<void> {
    await this.runForAllTenants(this.businessAnomalyService);
  }

  /** 智能补货：每 30 分钟 */
  @Cron('*/30 * * * *')
  async cronReplenishmentAdvice(): Promise<void> {
    await this.runForAllTenants(this.replenishmentAdviceService);
  }

  /** 配送异常：每 15 分钟 */
  @Cron('*/15 * * * *')
  async cronDeliveryAnomaly(): Promise<void> {
    await this.runForAllTenants(this.deliveryAnomalyService);
  }

  /** 客户流失：每日 9:30 */
  @Cron('30 9 * * *')
  async cronCustomerChurn(): Promise<void> {
    await this.runForAllTenants(this.customerChurnService);
  }

  /** 毛利异常：每日 8:00 */
  @Cron('0 8 * * *')
  async cronGrossMarginAnomaly(): Promise<void> {
    await this.runForAllTenants(this.grossMarginAnomalyService);
  }

  // ──────────────────────────────────────────────
  // 对外接口（Controller 使用）
  // ──────────────────────────────────────────────

  /**
   * 列出全部巡检任务及运行状态
   */
  listJobs(): ProactiveJobInfo[] {
    return this.tasks.map((task) => this.toJobInfo(task));
  }

  /**
   * 手动触发单个巡检任务（对全部启用租户执行）
   *
   * @param name 任务名（如 inventory_warning）
   * @throws NotFoundException 任务不存在时
   */
  async runJob(
    name: string,
  ): Promise<{ job: ProactiveJobInfo; results: ProactiveTaskResult[] }> {
    const task = this.tasks.find((t) => t.name === name);
    if (!task) {
      throw new NotFoundException(`巡检任务 ${name} 不存在`);
    }
    const results = await this.runForAllTenants(task);
    return { job: this.toJobInfo(task), results };
  }

  /**
   * 对全部启用租户执行指定任务（单租户失败不中断）
   *
   * @param task 巡检任务
   * @returns 各租户执行结果（防重入跳过时返回空数组）
   */
  async runForAllTenants(task: IProactiveTask): Promise<ProactiveTaskResult[]> {
    if (this.running.has(task.name)) {
      this.logger.warn(`任务 ${task.name} 正在运行，跳过本次调度`);
      return [];
    }
    this.running.add(task.name);
    this.lastRunAt.set(task.name, new Date().toISOString());

    try {
      let tenants: string[] = [];
      try {
        tenants = await this.listTenants();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const result = `${task.name}：获取租户列表失败 ${message}`;
        this.lastResult.set(task.name, result);
        this.logger.warn(result);
        return [];
      }

      if (tenants.length === 0) {
        const result = `${task.name}：未找到启用租户，跳过巡检`;
        this.lastResult.set(task.name, result);
        this.logger.warn(result);
        return [];
      }

      const results: ProactiveTaskResult[] = [];
      for (const tenantId of tenants) {
        try {
          results.push(await task.execute(tenantId));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `任务 ${task.name} 租户 ${tenantId} 执行异常：${message}`,
          );
          results.push({
            taskName: task.name,
            tenantId,
            found: 0,
            pushed: 0,
            error: message,
          });
        }
      }

      const foundTotal = results.reduce((sum, r) => sum + r.found, 0);
      const pushedTotal = results.reduce((sum, r) => sum + r.pushed, 0);
      const summary = `${task.name}：巡检 ${tenants.length} 个租户，发现 ${foundTotal} 条，推送 ${pushedTotal} 条`;
      this.lastResult.set(task.name, summary);
      this.logger.log(summary);
      return results;
    } finally {
      this.running.delete(task.name);
    }
  }

  // ──────────────────────────────────────────────
  // 私有方法
  // ──────────────────────────────────────────────

  /** 获取启用租户列表（t_tenant，status=ACTIVE） */
  private async listTenants(): Promise<string[]> {
    const rows = await this.dataSource.query<Row[]>(
      `SELECT tenant_id AS tenantId
       FROM t_tenant
       WHERE status = 'ACTIVE'`,
    );
    return rows
      .map((row) => toText(row.tenantId))
      .filter((id) => id.length > 0);
  }

  /** 组装任务状态信息 */
  private toJobInfo(task: IProactiveTask): ProactiveJobInfo {
    return {
      name: task.name,
      description: task.description,
      scheduleType: task.scheduleType,
      schedule: task.schedule,
      priority: task.priority,
      pushType: task.pushType,
      lastRunAt: this.lastRunAt.get(task.name),
      lastResult: this.lastResult.get(task.name),
    };
  }
}
