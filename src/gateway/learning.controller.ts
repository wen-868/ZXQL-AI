/**
 * LearningController — 自主学习管理接口（完善度 P2 LN）
 *
 * 端点列表（全局前缀 /api）：
 * - GET /api/admin/learning?tenantId=&limit= — 学习回流记录
 * - GET /api/admin/learning/hints?tenantId=  — 当前租户回流提示（工具选择/路由）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { LearningService } from '../brain/learning/learning.service';

@UseGuards(AdminGuard)
@Controller('admin/learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  /** 学习回流记录 */
  @Get()
  listLogs(
    @Query('tenantId') tenantId = 'default',
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number.parseInt(limit ?? '50', 10) || 50, 200);
    return this.learning.listLogs(tenantId, n);
  }

  /** 当前租户回流提示 */
  @Get('hints')
  async hints(@Query('tenantId') tenantId = 'default') {
    return this.learning.getHints(tenantId);
  }
}
