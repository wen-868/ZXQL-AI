/**
 * AiConfigController — AI 配置管理接口（平台总后台）
 *
 * 职责：
 * 1. 平台默认配置：读取 / 更新
 * 2. 租户 AI 配置：分页列表 / 详情 / 更新（apiKey 加密存储）
 * 3. 用量统计：按租户 + 日期范围查询
 * 4. 计费套餐：列表 / 更新
 *
 * 端点列表（全局前缀 /api，实际路径 /api/admin/ai-config/...）：
 * - GET  /api/admin/ai-config/platform          — 获取平台默认配置
 * - PUT  /api/admin/ai-config/platform          — 更新平台默认配置
 * - GET  /api/admin/ai-config/tenants           — 租户 AI 配置列表（分页，可 tenantId 过滤）
 * - GET  /api/admin/ai-config/tenants/:tenantId — 租户配置详情
 * - PUT  /api/admin/ai-config/tenants/:tenantId — 更新租户配置（apiKey 加密后存储）
 * - GET  /api/admin/ai-config/usage             — 用量统计（startDate/endDate/tenantId）
 * - GET  /api/admin/ai-config/billing           — 计费套餐列表
 * - PUT  /api/admin/ai-config/billing/:tenantId — 更新租户计费套餐
 *
 * 业务逻辑全部委托给 AiConfigAdminService（Controller 不操作数据库，符合分层标准）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { AiConfigAdminService } from '../tenant/ai-config-admin.service';
import {
  UpdatePlatformAiConfigDto,
  UpdateTenantAiConfigDto,
  UpdateTenantBillingDto,
} from './dto/ai-config.dto';

/** 默认分页大小 */
const DEFAULT_PAGE_SIZE = 20;

@UseGuards(AdminGuard)
@Controller('admin/ai-config')
export class AiConfigController {
  constructor(private readonly adminService: AiConfigAdminService) {}

  // ── 平台默认配置 ──────────────────────────────────────────────

  /**
   * 获取平台默认配置
   *
   * GET /api/admin/ai-config/platform
   */
  @Get('platform')
  getPlatformConfig() {
    return this.adminService.getPlatformConfig();
  }

  /**
   * 更新平台默认配置
   *
   * PUT /api/admin/ai-config/platform
   */
  @Put('platform')
  updatePlatformConfig(@Body() dto: UpdatePlatformAiConfigDto) {
    return this.adminService.updatePlatformConfig(dto);
  }

  // ── 租户 AI 配置 ─────────────────────────────────────────────

  /**
   * 租户 AI 配置列表（分页，可 tenantId 过滤）
   *
   * GET /api/admin/ai-config/tenants?tenantId=xxx&page=1&pageSize=20
   */
  @Get('tenants')
  listTenants(
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.adminService.listTenantConfigs({
      tenantId,
      page: this.toInt(page, 1),
      pageSize: this.toInt(pageSize, DEFAULT_PAGE_SIZE),
    });
  }

  /**
   * 租户配置详情
   *
   * GET /api/admin/ai-config/tenants/:tenantId
   */
  @Get('tenants/:tenantId')
  getTenant(@Param('tenantId') tenantId: string) {
    return this.adminService.getTenantConfig(tenantId);
  }

  /**
   * 更新租户配置（apiKey 必须加密后存储）
   *
   * PUT /api/admin/ai-config/tenants/:tenantId
   */
  @Put('tenants/:tenantId')
  updateTenant(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantAiConfigDto,
  ) {
    return this.adminService.updateTenantConfig(tenantId, dto);
  }

  // ── 用量统计 ─────────────────────────────────────────────────

  /**
   * 用量统计（t_ai_usage_daily 按日汇总）
   *
   * GET /api/admin/ai-config/usage?startDate=2026-08-01&endDate=2026-08-02&tenantId=xxx
   */
  @Get('usage')
  getUsage(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    return this.adminService.getUsageStats({ startDate, endDate, tenantId });
  }

  // ── 计费套餐 ─────────────────────────────────────────────────

  /**
   * 计费套餐列表（分页，可 tenantId 过滤）
   *
   * GET /api/admin/ai-config/billing?tenantId=xxx&page=1&pageSize=20
   */
  @Get('billing')
  listBillings(
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.adminService.listBillings({
      tenantId,
      page: this.toInt(page, 1),
      pageSize: this.toInt(pageSize, DEFAULT_PAGE_SIZE),
    });
  }

  /**
   * 更新租户计费套餐
   *
   * PUT /api/admin/ai-config/billing/:tenantId
   */
  @Put('billing/:tenantId')
  updateBilling(
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantBillingDto,
  ) {
    return this.adminService.updateBilling(tenantId, dto);
  }

  /**
   * 查询参数转整数（非法值回退默认值）
   */
  private toInt(raw: string | undefined, fallback: number): number {
    if (raw === undefined) {
      return fallback;
    }
    const value = Number.parseInt(raw, 10);
    if (Number.isNaN(value) || value < 1) {
      return fallback;
    }
    return value;
  }
}
