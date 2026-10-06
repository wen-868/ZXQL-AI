/**
 * EvolutionController — 自主进化管理接口（完善度 P3 SE 门控）
 *
 * 端点列表（全局前缀 /api）：
 * - GET  /api/admin/evolution?tenantId=&status= — 进化版本列表
 * - POST /api/admin/evolution — 提出进化提案（自动创建审核工单）
 * - POST /api/admin/evolution/:id/approve — 审核通过 → 灰度
 * - POST /api/admin/evolution/:id/reject — 审核驳回
 * - POST /api/admin/evolution/:id/rollout — 灰度转正式生效
 * - POST /api/admin/evolution/:id/rollback — 一键回滚
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin-auth.guard';
import {
  resolveAdminTenantId,
  resolveOptionalAdminTenantId,
} from '../tenant/admin-tenant-scope';
import { EvolutionService } from '../brain/evolution/evolution.service';
import type { ProposalInput } from '../brain/evolution/evolution.service';

@UseGuards(AdminGuard)
@Controller('admin/evolution')
export class EvolutionController {
  constructor(private readonly service: EvolutionService) {}

  /**
   * 进化版本列表
   * P1 修复（2026-10-04）：租户由 JWT 身份解析（此前 query 自报缺省 'default'）
   */
  @Get()
  list(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list(
      resolveOptionalAdminTenantId(req, tenantId),
      status,
    );
  }

  /**
   * 提出进化提案
   * P1 修复（2026-10-04）：tenantId 由身份解析——此前取请求体自报，
   * 商户可向任意租户提出案并自动创建审核工单
   */
  @Post()
  propose(@Req() req: Request, @Body() dto: ProposalInput) {
    return this.service.propose({
      ...dto,
      tenantId: resolveAdminTenantId(req, dto.tenantId),
    });
  }

  /** 审核通过 → 灰度 */
  @Post(':id/approve')
  approve(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ) {
    return this.service.approve(
      id,
      dto.reviewer ?? 'admin',
      resolveOptionalAdminTenantId(req),
    );
  }

  /** 审核驳回 */
  @Post(':id/reject')
  reject(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string; reason: string },
  ) {
    return this.service.reject(
      id,
      dto.reviewer ?? 'admin',
      dto.reason,
      resolveOptionalAdminTenantId(req),
    );
  }

  /** 灰度转正式生效 */
  @Post(':id/rollout')
  rollout(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    return this.service.rollout(id, resolveOptionalAdminTenantId(req));
  }

  /** 一键回滚 */
  @Post(':id/rollback')
  rollback(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ) {
    return this.service.rollback(
      id,
      dto.reviewer ?? 'admin',
      resolveOptionalAdminTenantId(req),
    );
  }
}
