/**
 * OpsModule — 运营闭环模块（完善度 P2）
 *
 * 职责：
 * 1. UsageStatsService：AI 用量统计（明细/汇总/跨租户概览）
 * 2. UsageAlertService：用量阈值告警（小时级巡检，超阈值推送）
 * 3. HealthMonitorService：AI 底座健康监控告警（5 分钟自检，状态翻转推送）
 * 4. UsageController：用量统计管理接口
 *
 * 依赖：
 * - ProactiveModule（ProactivePushService：告警统一走 t_push_log + WebSocket 实时推送）
 * - DatabaseModule（DataSource：用量表 / 健康自检）
 * - BridgeModule（ServiceClient：后端连通性检查）
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P2 用量计费闭环 / 监控告警
 */
import { Module } from '@nestjs/common';
import { ProactiveModule } from '../brain/proactive/proactive.module';
import { DatabaseModule } from '../database/database.module';
import { BridgeModule } from '../bridge/bridge.module';
import { CommonModule } from '../common/common.module';
import { UsageStatsService } from './usage-stats.service';
import { UsageAlertService } from './usage-alert.service';
import { HealthMonitorService } from './health-monitor.service';
import { DeadLetterSinkService } from './dead-letter-sink.service';
import { DeadLetterReplayService } from './dead-letter-replay.service';
import { UsageController } from './usage.controller';

@Module({
  // CommonModule：R101-AI-23 起 DeadLetterReplayService 注入 RedisProvider（共享 provider）
  imports: [ProactiveModule, DatabaseModule, BridgeModule, CommonModule],
  providers: [
    UsageStatsService,
    UsageAlertService,
    HealthMonitorService,
    // R101-AI-22：bestEffort 死信生产落库端（onModuleInit 注册全局 sink）
    DeadLetterSinkService,
    // R101-AI-23：死信重放队列（Redis Stream 故障缓冲 + @Cron 补录）
    DeadLetterReplayService,
  ],
  controllers: [UsageController],
  exports: [UsageStatsService],
})
export class OpsModule {}
