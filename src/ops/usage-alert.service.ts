/**
 * UsageAlertService — AI 用量阈值告警（完善度 P2-用量计费闭环）
 *
 * 职责：
 * 1. 每小时检查各租户当日 AI 用量（t_ai_usage_daily 的 total_cost）
 * 2. 超过阈值（USAGE_DAILY_ALERT_COST，元）的租户触发告警推送
 * 3. 告警走 ProactivePushService：落库 t_push_log + WebSocket 实时广播
 * 4. 同租户同日只告警一次（内存去重），避免每小时重复打扰
 *
 * 配置：
 * - USAGE_DAILY_ALERT_COST：日费用阈值（元），0 或未配置 = 禁用告警
 * - USAGE_DAILY_ALERT_TOKENS：日 Token 阈值（可选），0 或未配置 = 不按 Token 告警
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P2 用量计费闭环
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { ProactivePushService } from '../brain/proactive/proactive-push.service';

/** 数据行（DataSource.query 返回结构） */
type Row = Record<string, unknown>;

@Injectable()
export class UsageAlertService {
  private readonly logger = new Logger(UsageAlertService.name);
  private readonly costThreshold: number;
  private readonly tokenThreshold: number;
  /** 已告警租户集合（key = tenantId:YYYY-MM-DD，防重复） */
  private readonly alerted = new Set<string>();

  constructor(
    private readonly dataSource: DataSource,
    private readonly pushService: ProactivePushService,
    configService: ConfigService,
  ) {
    this.costThreshold = UsageAlertService.parseThreshold(
      configService.get<string>('USAGE_DAILY_ALERT_COST'),
    );
    this.tokenThreshold = UsageAlertService.parseThreshold(
      configService.get<string>('USAGE_DAILY_ALERT_TOKENS'),
    );
  }

  /**
   * 定时检查（每小时第 0 分执行）
   */
  @Cron('0 * * * *')
  async scheduledCheck(): Promise<void> {
    if (this.costThreshold <= 0 && this.tokenThreshold <= 0) {
      return;
    }
    await this.checkAndAlert();
  }

  /**
   * 检查当日超阈值租户并推送告警（供定时任务与测试调用）
   *
   * @returns 本次触发的告警条数
   */
  async checkAndAlert(): Promise<number> {
    if (this.costThreshold <= 0 && this.tokenThreshold <= 0) {
      this.logger.debug(
        '用量告警未配置阈值（USAGE_DAILY_ALERT_COST/TOKENS），跳过',
      );
      return 0;
    }

    const today = new Date().toISOString().slice(0, 10);
    const rows = await this.dataSource.query<Row[]>(
      `SELECT tenant_id,
              COALESCE(SUM(chat_count), 0) AS chat_count,
              COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(total_cost), 0) AS total_cost
       FROM t_ai_usage_daily
       WHERE stat_date = ?
       GROUP BY tenant_id`,
      [today],
    );

    let alerted = 0;
    for (const row of rows ?? []) {
      const tenantId = UsageAlertService.toStr(row.tenant_id);
      if (!tenantId) continue;
      const totalCost = UsageAlertService.toNum(row.total_cost);
      const totalTokens = UsageAlertService.toNum(row.total_tokens);

      const overCost = this.costThreshold > 0 && totalCost > this.costThreshold;
      const overTokens =
        this.tokenThreshold > 0 && totalTokens > this.tokenThreshold;
      if (!overCost && !overTokens) continue;

      const key = `${tenantId}:${today}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);

      const reason = [
        overCost
          ? `费用 ¥${totalCost.toFixed(2)} 超阈值 ¥${this.costThreshold.toFixed(2)}`
          : '',
        overTokens ? `Token ${totalTokens} 超阈值 ${this.tokenThreshold}` : '',
      ]
        .filter(Boolean)
        .join('；');

      const ok = await this.pushService.push(tenantId, 'usage_alert', {
        title: '⚠️ AI 用量超阈值提醒',
        type: 'system',
        priority: 'important',
        content:
          `今日 AI 用量已达告警线（${reason}）。\n` +
          `对话 ${UsageAlertService.toNum(row.chat_count)} 次，` +
          `工具调用 ${UsageAlertService.toNum(row.tool_call_count)} 次。`,
        extras: {
          task: 'usage_alert',
          totalCost,
          totalTokens,
          thresholdCost: this.costThreshold,
        },
      });

      this.logger.log(
        `用量告警：tenant=${tenantId} ${reason} 推送${ok ? '成功' : '失败'}`,
      );
      alerted += 1;
    }
    return alerted;
  }

  private static parseThreshold(raw?: string): number {
    const n = Number(raw ?? 0);
    return Number.isNaN(n) || n <= 0 ? 0 : n;
  }

  private static toStr(value: unknown): string | undefined {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined;
  }

  private static toNum(value: unknown): number {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
}
