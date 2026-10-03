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
  ForbiddenException,
  Get,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard, getAdminIdentity } from '../tenant/admin-auth.guard';
import { aiError } from '../common/ai-errors';
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

  // ── 租户归属收口（2026-10-04 P0 修复）──────────────────────────
  // 此前本控制器仅挂 AdminGuard（只验角色），商户管理员可读写平台级
  // 配置与任意租户的 AI 配置/计费（可把他人租户 provider 改到攻击者
  // 端点，劫持其全部 AI 对话流）。口径：商户身份锁定本租户、平台级
  // 端点仅限平台身份，与全项目"tenantId 一律只认 JWT payload"铁律一致。

  /** 平台级端点守卫：商户身份访问平台资源 → 403 */
  private requirePlatformIdentity(req: Request): void {
    const identity = getAdminIdentity(req);
    if (identity.identityType !== 'platform') {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: '平台级端点仅限总台平台身份访问',
        }),
      });
    }
  }

  /**
   * 租户资源守卫：商户身份锁定本租户（请求他人租户 → 403，不静默改写
   * 以免误配出难排查的数据错位）；平台身份按请求参数放行。
   */
  private requireTenantAccess(req: Request, requestedTenantId: string): void {
    const identity = getAdminIdentity(req);
    if (identity.identityType === 'platform') {
      return;
    }
    if (!identity.tenantId || requestedTenantId !== identity.tenantId) {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: `无权访问租户 ${requestedTenantId} 的 AI 配置（仅限本租户）`,
        }),
      });
    }
  }

  // ── 平台默认配置 ──────────────────────────────────────────────

  /**
   * 获取平台默认配置
   *
   * GET /api/admin/ai-config/platform
   */
  @Get('platform')
  getPlatformConfig(@Req() req: Request) {
    this.requirePlatformIdentity(req);
    return this.adminService.getPlatformConfig();
  }

  /**
   * 更新平台默认配置
   *
   * PUT /api/admin/ai-config/platform
   */
  @Put('platform')
  updatePlatformConfig(
    @Req() req: Request,
    @Body() dto: UpdatePlatformAiConfigDto,
  ) {
    this.requirePlatformIdentity(req);
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
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // 商户身份：过滤条件锁定本租户（无过滤条件时也只看得到本租户）
    const identity = getAdminIdentity(req);
    const scopedTenantId =
      identity.identityType === 'platform' ? tenantId : identity.tenantId;
    return this.adminService.listTenantConfigs({
      tenantId: scopedTenantId,
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
  getTenant(@Req() req: Request, @Param('tenantId') tenantId: string) {
    this.requireTenantAccess(req, tenantId);
    return this.adminService.getTenantConfig(tenantId);
  }

  /**
   * 更新租户配置（apiKey 必须加密后存储）
   *
   * PUT /api/admin/ai-config/tenants/:tenantId
   */
  @Put('tenants/:tenantId')
  updateTenant(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantAiConfigDto,
  ) {
    this.requireTenantAccess(req, tenantId);
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
    @Req() req: Request,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('tenantId') tenantId?: string,
  ) {
    // 商户身份锁定本租户用量；平台身份可按租户过滤（不传=全量）
    const identity = getAdminIdentity(req);
    const scopedTenantId =
      identity.identityType === 'platform' ? tenantId : identity.tenantId;
    return this.adminService.getUsageStats({
      startDate,
      endDate,
      tenantId: scopedTenantId,
    });
  }

  // ── 计费套餐 ─────────────────────────────────────────────────

  /**
   * 计费套餐列表（分页，可 tenantId 过滤）
   *
   * GET /api/admin/ai-config/billing?tenantId=xxx&page=1&pageSize=20
   */
  @Get('billing')
  listBillings(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const identity = getAdminIdentity(req);
    const scopedTenantId =
      identity.identityType === 'platform' ? tenantId : identity.tenantId;
    return this.adminService.listBillings({
      tenantId: scopedTenantId,
      page: this.toInt(page, 1),
      pageSize: this.toInt(pageSize, DEFAULT_PAGE_SIZE),
    });
  }

  /**
   * 更新租户计费套餐
   *
   * PUT /api/admin/ai-config/billing/:tenantId
   * 平台级操作（套餐关系到平台计费），商户身份访问 → 403
   */
  @Put('billing/:tenantId')
  updateBilling(
    @Req() req: Request,
    @Param('tenantId') tenantId: string,
    @Body() dto: UpdateTenantBillingDto,
  ) {
    this.requirePlatformIdentity(req);
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
