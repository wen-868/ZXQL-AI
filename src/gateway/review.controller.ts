/**
 * ReviewController — AI 待审工单接口（完善度 P0-4 人工确认闸）
 *
 * 端点列表（全局前缀 /api，实际路径 /api/review/...）：
 * - GET  /api/review?tenantId=&status=        — 待审工单列表
 * - GET  /api/review/:id                      — 工单详情
 * - POST /api/review/:id/approve              — 审核通过（图续跑）
 * - POST /api/review/:id/reject               — 审核驳回（图终止）
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
import { AdminGuard, getAdminIdentity } from '../tenant/admin-auth.guard';
import { resolveOptionalAdminTenantId } from '../tenant/admin-tenant-scope';
import {
  ReviewTaskService,
  ReviewTaskView,
} from '../brain/review/review-task.service';

/** 驳回请求体 */
export interface RejectReviewDto {
  reviewer?: string;
  reason: string;
}

@UseGuards(AdminGuard)
@Controller('review')
export class ReviewController {
  constructor(private readonly service: ReviewTaskService) {}

  /**
   * 待审工单列表（租户 + 状态过滤）
   *
   * P1 修复（2026-10-04）：租户一律由 JWT 身份解析——此前 query 自报且
   * 缺省 'default'，商户可列他人租户的待审工单（含写预览业务数据）；
   * 平台身份不传=全量。
   */
  @Get()
  list(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('status') status?: string,
  ): Promise<ReviewTaskView[]> {
    return this.service.list(
      resolveOptionalAdminTenantId(req, tenantId),
      status,
    );
  }

  /** 工单详情（商户锁本租户，跨租户 id 落到"不存在"） */
  @Get(':id')
  get(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<ReviewTaskView> {
    return this.service.get(id, resolveOptionalAdminTenantId(req));
  }

  /** 审核通过（图续跑；审核人从 JWT 身份取，body 可覆盖） */
  @Post(':id/approve')
  approve(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ): Promise<ReviewTaskView> {
    const reviewer = dto.reviewer ?? getAdminIdentity(req).username;
    return this.service.approve(
      id,
      reviewer,
      resolveOptionalAdminTenantId(req),
    );
  }

  /** 审核驳回（图终止；租户域语义同 approve） */
  @Post(':id/reject')
  reject(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectReviewDto,
  ): Promise<ReviewTaskView> {
    const reviewer = dto.reviewer ?? getAdminIdentity(req).username;
    return this.service.reject(
      id,
      reviewer,
      dto.reason,
      resolveOptionalAdminTenantId(req),
    );
  }
}
