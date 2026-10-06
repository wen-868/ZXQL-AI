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
import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { resolveAdminTenantId } from '../tenant/admin-tenant-scope';
import { AdminGuard, getAdminIdentity } from '../tenant/admin-auth.guard';
import { aiError } from '../common/ai-errors';
import {
  UsageDailyRow,
  UsageStatsService,
  UsageTotals,
} from './usage-stats.service';

@UseGuards(AdminGuard)
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
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{
    tenantId: string;
    list: UsageDailyRow[];
  }> {
    // P1 修复（2026-10-04）：租户由 JWT 身份解析（此前 query 自报缺省
    // 'default'，商户可读任意租户用量/计费数据）
    const tid = resolveAdminTenantId(req, tenantId);
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
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<UsageTotals> {
    const tid = resolveAdminTenantId(req, tenantId);
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
  /**
   * 跨租户用量概览
   *
   * 阶段0 B-5（2026-10-07 止血）：平台身份门禁——本端点聚合全部租户的
   * 费用与 Token 汇总，此前任何商户管理角色（含仓库/财务管理员）都可读。
   * 口径对齐 ai-config.controller.requirePlatformIdentity。
   */
  @Get('tenants')
  async tenants(
    @Req() req: Request,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<{ list: UsageTotals[] }> {
    const identity = getAdminIdentity(req);
    if (identity.identityType !== 'platform') {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: '跨租户用量概览仅限总台平台身份访问',
        }),
      });
    }
    const list = await this.usageStats.listTenantUsage(startDate, endDate);
    return { list };
  }
}
