/**
 * ScheduleReminderModule — 日程到期提醒的 DI 归属（R101-AI-39）
 *
 * 为什么单独成模块：
 * - 服务文件归属 **proactive 域**（架构一致：提醒 = 主动巡检 + 推送）
 * - 但注册进 ProactiveModule 会破坏其 spec 的**精确 providers 断言**（长度 12）⇒ 按"既有断言零修改"红线不改它
 * - 注册进 ToolsModule 会形成 **循环依赖**（ToolsModule → ProactiveModule → BrainModule → …）
 * ⇒ 独立模块：只依赖 ProactiveModule（其 exports 含 ProactivePushService）+ DatabaseModule（DataSource）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
// AI-P2-3F3 §四.3：role 参与者成员须经 MS 公共 sys-users 接口解析 ⇒ 引入 BridgeModule(ServiceClient)
// 无环校验：BridgeModule → { DatabaseModule, TenantModule }，其闭包不引用本模块 ⇒ 不成环
import { BridgeModule } from '../../bridge/bridge.module';
import { ProactiveModule } from './proactive.module';
import { ScheduleReminderService } from './schedule-reminder.service';
// R101-AI-40：站内通知落库 + 旁路组合（推送 + 通知）
import { NoticeService } from './notice.service';
import { NoticeBridgeService } from './notice-bridge.service';
// AI-P2-3：停机漏提醒补偿器（与正常提醒共用同一 push/notice 通道，不建旁路）
import { ReminderCatchupService } from './reminder-catchup.service';

@Module({
  imports: [ProactiveModule, DatabaseModule, BridgeModule],
  providers: [
    ScheduleReminderService,
    NoticeService,
    NoticeBridgeService,
    // AI-P2-3：补偿器与提醒服务同模块 ⇒ 共享同一 push/notice 实例（人工与 AI 共用，无旁路）
    ReminderCatchupService,
  ],
  exports: [
    ScheduleReminderService,
    NoticeService,
    NoticeBridgeService,
    // AI-P2-3：导出以便 AI 查询漏提醒摘要（只读；不得删除原始提醒）
    ReminderCatchupService,
  ],
})
export class ScheduleReminderModule {}
