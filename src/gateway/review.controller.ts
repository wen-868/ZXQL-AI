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
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import {
  ReviewTaskService,
  ReviewTaskView,
} from '../brain/review/review-task.service';

/** 驳回请求体 */
export interface RejectReviewDto {
  reviewer: string;
  reason: string;
}

@UseGuards(AdminGuard)
@Controller('review')
export class ReviewController {
  constructor(private readonly service: ReviewTaskService) {}

  /** 待审工单列表（租户 + 状态过滤） */
  @Get()
  list(
    @Query('tenantId') tenantId = 'default',
    @Query('status') status?: string,
  ): Promise<ReviewTaskView[]> {
    return this.service.list(tenantId, status);
  }

  /** 工单详情 */
  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<ReviewTaskView> {
    return this.service.get(id);
  }

  /** 审核通过（图续跑） */
  @Post(':id/approve')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ): Promise<ReviewTaskView> {
    return this.service.approve(id, dto.reviewer ?? 'admin');
  }

  /** 审核驳回（图终止） */
  @Post(':id/reject')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectReviewDto,
  ): Promise<ReviewTaskView> {
    return this.service.reject(id, dto.reviewer ?? 'admin', dto.reason);
  }
}
