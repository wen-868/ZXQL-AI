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
import { ProactiveModule } from './proactive.module';
import { ScheduleReminderService } from './schedule-reminder.service';
// R101-AI-40：站内通知落库 + 旁路组合（推送 + 通知）
import { NoticeService } from './notice.service';
import { NoticeBridgeService } from './notice-bridge.service';

@Module({
  imports: [ProactiveModule, DatabaseModule],
  providers: [ScheduleReminderService, NoticeService, NoticeBridgeService],
  exports: [ScheduleReminderService, NoticeService, NoticeBridgeService],
})
export class ScheduleReminderModule {}
