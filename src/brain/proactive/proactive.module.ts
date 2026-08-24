/**
 * 主动能力模块 — 9 项定时巡检 + 推送
 *
 * 职责：
 * 1. 注册 9 个巡检 Service（库存预警/订单异常/应收催收/每日简报/经营异常/智能补货/配送异常/客户流失/毛利异常）
 * 2. 注册 ProactiveService 调度器（@Cron 定时 + 手动触发 + 任务列表）
 * 3. 注册 ProactiveController（管理 API）
 *
 * 依赖模块：
 * - BridgeModule（AuditLogger：推送审计留痕）
 * - DatabaseModule（DataSource：巡检数据直查共享 MySQL + t_push_log 落库）
 *
 * 被 AppModule 导入（需同时引入 ScheduleModule.forRoot() 启用 @Cron 调度）。
 *
 * 对应文档：
 * - docs/ai-base/智享AI助手-能力说明书.md 第三章 主动能力 / 第五章 触发机制
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Module } from '@nestjs/common';
import { BridgeModule } from '../../bridge/bridge.module';
import { DatabaseModule } from '../../database/database.module';
import { GatewayModule } from '../../gateway/gateway.module';
import { ProactiveController } from './proactive.controller';
import { ProactivePushService } from './proactive-push.service';
import { ProactiveService } from './proactive.service';
import { InventoryWarningService } from './inventory-warning.service';
import { OrderAnomalyService } from './order-anomaly.service';
import { ReceivableReminderService } from './receivable-reminder.service';
import { DailyBriefingService } from './daily-briefing.service';
import { BusinessAnomalyService } from './business-anomaly.service';
import { ReplenishmentAdviceService } from './replenishment-advice.service';
import { DeliveryAnomalyService } from './delivery-anomaly.service';
import { CustomerChurnService } from './customer-churn.service';
import { GrossMarginAnomalyService } from './gross-margin-anomaly.service';

@Module({
  imports: [BridgeModule, DatabaseModule, GatewayModule],
  providers: [
    ProactivePushService,
    InventoryWarningService,
    OrderAnomalyService,
    ReceivableReminderService,
    DailyBriefingService,
    BusinessAnomalyService,
    ReplenishmentAdviceService,
    DeliveryAnomalyService,
    CustomerChurnService,
    GrossMarginAnomalyService,
    ProactiveService,
  ],
  controllers: [ProactiveController],
  exports: [ProactiveService, ProactivePushService],
})
export class ProactiveModule {}
