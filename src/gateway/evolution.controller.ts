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
} from '@nestjs/common';
import { EvolutionService } from '../brain/evolution/evolution.service';
import type { ProposalInput } from '../brain/evolution/evolution.service';

@Controller('admin/evolution')
export class EvolutionController {
  constructor(private readonly service: EvolutionService) {}

  /** 进化版本列表 */
  @Get()
  list(
    @Query('tenantId') tenantId = 'default',
    @Query('status') status?: string,
  ) {
    return this.service.list(tenantId, status);
  }

  /** 提出进化提案 */
  @Post()
  propose(@Body() dto: ProposalInput) {
    return this.service.propose(dto);
  }

  /** 审核通过 → 灰度 */
  @Post(':id/approve')
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ) {
    return this.service.approve(id, dto.reviewer ?? 'admin');
  }

  /** 审核驳回 */
  @Post(':id/reject')
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string; reason: string },
  ) {
    return this.service.reject(id, dto.reviewer ?? 'admin', dto.reason);
  }

  /** 灰度转正式生效 */
  @Post(':id/rollout')
  rollout(@Param('id', ParseIntPipe) id: number) {
    return this.service.rollout(id);
  }

  /** 一键回滚 */
  @Post(':id/rollback')
  rollback(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: { reviewer?: string },
  ) {
    return this.service.rollback(id, dto.reviewer ?? 'admin');
  }
}
