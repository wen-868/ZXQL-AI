/**
 * NoticeModule — 站内通知落库的 DI 归属（R101-AI-43 S4 新建）
 *
 * 为什么单独成模块（破环，非"为了好看"）：
 * - `NoticeService` 只依赖 `AiNoticeEntity` 仓储（+ DatabaseModule）⇒ **不依赖 ProactiveModule**
 * - 而 `NoticeBridgeService` 依赖 `ProactivePushService`（由 ProactiveModule 提供）⇒ 它是**环的根源**
 *   ⇒ 若把 NoticeBridge 注册进 ProactiveModule，ProactiveModule 必须能拿到它，而它又指向
 *     ProactiveModule 自身 ⇒ **成环**（AI-39 已踩过的同款坑）
 * - 且 ProactiveModule 的 spec 有**精确 providers 断言**（`toHaveLength(12)`）与精确 exports
 *   断言 ⇒ 不能往它的 providers 里加东西
 *
 * ⇒ 本模块只装 `NoticeService`（无环、无 provider 冲突）；`ProactiveModule` 通过
 *   **imports: [NoticeModule]** 让 10 个巡检可见它 ⇒ providers 仍 12 / exports 仍 2，两条红线都不破。
 *   `NoticeBridgeService` 仍留在 `ScheduleReminderModule`（它需要 ProactiveModule ⇒ 方向单向，无环）。
 *
 * S4 用法（巡检"先落通知，再推送"）：
 * - 巡检 service 以 `@Optional()` 注入 `NoticeService` ⇒ 10 份既有 spec **零改动**即可构造
 * - 调用处必须**双层防护**：`NoticeService.record()` 契约上已吞异常，但调用方仍要包 try
 *   （"不信任自己的契约"）⇒ 通知失败绝不能把巡检误报成失败（主次不倒置）
 *
 * 负责人: 阿澈（AI 底座集成 owner）｜创建日期: 2026-10-17
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { NoticeService } from './notice.service';

@Module({
  imports: [DatabaseModule],
  providers: [NoticeService],
  exports: [NoticeService],
})
export class NoticeModule {}
