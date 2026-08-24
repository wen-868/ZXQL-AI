/**
 * 运营管理接口 — AI 用量统计（完善度 P2-用量计费闭环）
 *
 * 端点列表：
 * - GET /api/admin/usage/daily?tenantId=&startDate=&endDate= — 租户用量明细
 * - GET /api/admin/usage/totals?tenantId=&startDate=&endDate= — 租户区间汇总
 * - GET /api/admin/usage/tenants?startDate=&endDate= — 跨租户用量概览
 *
 * 用途：
 * - 工作台/总台查看 AI 用量与费用，支撑计费与成本控制
 * - 结合 UsageAlertService 的阈值告警形成「用量-计费-告警」闭环
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P2 用量计费闭环
 */
import { Controller, Get, Logger, Query } from '@nestjs/common';
import {
  UsageDailyRow,
  UsageStatsService,
  UsageTotals,
} from './usage-stats.service';

@Controller('admin/usage')
export class UsageController {
  private readonly logger = new Logger(UsageController.name);

  constructor(private readonly usageStats: UsageStatsService) {}

  /**
   * 租户用量明细
   *
   * GET /api/admin/usage/daily?tenantId=default&startDate=2026-08-01&endDate=2026-08-15
   */
  @Get('daily')
  async daily(
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    tenantId: string;
    list: UsageDailyRow[];
  }> {
    const tid = tenantId ?? 'default';
    const list = await this.usageStats.getDailyUsage(tid, startDate, endDate);
    return { tenantId: tid, list };
  }

  /**
   * 租户区间用量汇总
   *
   * GET /api/admin/usage/totals?tenantId=default&startDate=&endDate=
   */
  @Get('totals')
  async totals(
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<UsageTotals> {
    const tid = tenantId ?? 'default';
    this.logger.log(
      `查询租户用量汇总：tenant=${tid} range=${startDate ?? '*'}-${endDate ?? '*'}`,
    );
    return this.usageStats.getTenantTotals(tid, startDate, endDate);
  }

  /**
   * 跨租户用量概览
   *
   * GET /api/admin/usage/tenants?startDate=&endDate=
   */
  @Get('tenants')
  async tenants(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{ list: UsageTotals[] }> {
    const list = await this.usageStats.listTenantUsage(startDate, endDate);
    return { list };
  }
}
