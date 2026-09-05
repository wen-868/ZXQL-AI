/**
 * LtmController — 长期记忆管理接口（完善度 P1 LT）
 *
 * 端点列表（全局前缀 /api）：
 * - GET /api/admin/ltm?tenantId= — 租户长期记忆总览（档案/情节/归档）
 * - GET /api/admin/ltm/episodic?tenantId=&limit= — 情节列表
 * - GET /api/admin/ltm/archival?tenantId=&limit= — 归档列表
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { LongTermMemoryService } from '../brain/memory/long-term-memory.service';

@UseGuards(AdminGuard)
@Controller('admin/ltm')
export class LtmController {
  constructor(private readonly ltm: LongTermMemoryService) {}

  /** 长期记忆总览 */
  @Get()
  async overview(@Query('tenantId') tenantId = 'default') {
    const [profiles, episodes, archivals] = await Promise.all([
      this.ltm.getProfiles(tenantId),
      this.ltm.listEpisodic(tenantId, 20),
      this.ltm.listArchival(tenantId, 20),
    ]);
    return {
      tenantId,
      profiles,
      episodes,
      archivals,
      counts: {
        profiles: profiles.length,
        episodes: episodes.length,
        archivals: archivals.length,
      },
    };
  }

  /** 情节列表 */
  @Get('episodic')
  episodic(
    @Query('tenantId') tenantId = 'default',
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number.parseInt(limit ?? '20', 10) || 20, 200);
    return this.ltm.listEpisodic(tenantId, n);
  }

  /** 归档列表 */
  @Get('archival')
  archival(
    @Query('tenantId') tenantId = 'default',
    @Query('limit') limit?: string,
  ) {
    const n = Math.min(Number.parseInt(limit ?? '20', 10) || 20, 200);
    return this.ltm.listArchival(tenantId, n);
  }
}
