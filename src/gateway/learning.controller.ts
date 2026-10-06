/**
 * LearningController — 自主学习管理接口（完善度 P2 LN）
 *
 * 端点列表（全局前缀 /api）：
 * - GET /api/admin/learning?tenantId=&limit= — 学习回流记录
 * - GET /api/admin/learning/hints?tenantId=  — 当前租户回流提示（工具选择/路由）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { resolveAdminTenantId } from '../tenant/admin-tenant-scope';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { LearningService } from '../brain/learning/learning.service';

@UseGuards(AdminGuard)
@Controller('admin/learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  /** 学习回流记录 */
  /**
   * P1 修复（2026-10-04）：租户由 JWT 身份解析（此前 query 自报缺省
   * 'default'，商户可读他人租户学习记录）
   */
  @Get()
  listLogs(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number.parseInt(limit ?? '50', 10) || 50, 200);
    return this.learning.listLogs(resolveAdminTenantId(req, tenantId), n);
  }

  /** 当前租户回流提示（租户口径同上） */
  @Get('hints')
  async hints(@Req() req: Request, @Query('tenantId') tenantId?: string) {
    return this.learning.getHints(resolveAdminTenantId(req, tenantId));
  }
}
