/**
 * HealthMonitorService — AI 底座健康监控告警（完善度 P2-监控告警）
 *
 * 职责：
 * 1. 每 5 分钟自检核心依赖（MySQL 数据库 + 后端服务）
 * 2. 状态由健康转为不健康时，向 default 租户推送告警（落库 + WebSocket 广播）
 * 3. 去重策略：状态翻转才推送（健康→不健康推一次；恢复后再次故障可再推），避免每 5 分钟刷屏
 *
 * 配置：
 * - HEALTH_MONITOR_ENABLED：监控开关（默认 true；false 时禁用自检与告警）
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P2 监控告警
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression, Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { ServiceClient } from '../bridge/service-client';
import { ProactivePushService } from '../brain/proactive/proactive-push.service';

@Injectable()
export class HealthMonitorService {
  private readonly logger = new Logger(HealthMonitorService.name);
  private readonly enabled: boolean;
  /** 上一轮自检是否健康（状态翻转才推送告警） */
  private wasHealthy = true;

  constructor(
    private readonly dataSource: DataSource,
    private readonly serviceClient: ServiceClient,
    private readonly pushService: ProactivePushService,
    configService: ConfigService,
  ) {
    this.enabled =
      configService.get<string>('HEALTH_MONITOR_ENABLED', 'true') !== 'false';
  }

  /**
   * 定时自检（默认每 5 分钟）
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledCheck(): Promise<void> {
    if (!this.enabled) return;
    await this.checkAndAlert();
  }

  /**
   * 执行一轮自检，状态翻转时推送告警（供定时任务与测试调用）
   *
   * @returns 自检结果摘要
   */
  async checkAndAlert(): Promise<{
    healthy: boolean;
    failures: string[];
    alerted: boolean;
  }> {
    if (!this.enabled) {
      this.logger.debug(
        '健康监控已关闭（HEALTH_MONITOR_ENABLED=false），跳过自检',
      );
      return { healthy: true, failures: [], alerted: false };
    }

    const failures: string[] = [];

    // 1. 数据库连通性
    try {
      await this.dataSource.query('SELECT 1');
    } catch (err) {
      failures.push(
        `数据库不可达：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2. 后端服务连通性
    try {
      const health = await this.serviceClient.healthCheck();
      if (!health.reachable) {
        failures.push(`后端服务不可达（latency=${health.latencyMs}ms）`);
      }
    } catch (err) {
      failures.push(
        `后端服务检查异常：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const healthy = failures.length === 0;
    let alerted = false;

    // 状态翻转：健康 → 不健康 时推送告警
    if (!healthy && this.wasHealthy) {
      const detail = failures.join('；');
      const ok = await this.pushService.push('default', 'health_monitor', {
        title: '🚨 AI 底座健康异常',
        type: 'system',
        priority: 'urgent',
        content: `AI 底座自检发现异常：${detail}。请检查服务日志与依赖连通性。`,
        extras: { task: 'health_monitor', failures },
      });
      this.logger.warn(
        `AI 底座健康告警已推送（${ok ? '成功' : '失败'}）：${detail}`,
      );
      alerted = true;
    }
    if (healthy && !this.wasHealthy) {
      this.logger.log('AI 底座健康已恢复，解除告警状态');
    }

    this.wasHealthy = healthy;
    return { healthy, failures, alerted };
  }
}
