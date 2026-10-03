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
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard } from '../tenant/admin-auth.guard';
import { resolveAdminTenantId } from '../tenant/admin-tenant-scope';
import { LongTermMemoryService } from '../brain/memory/long-term-memory.service';

@UseGuards(AdminGuard)
@Controller('admin/ltm')
export class LtmController {
  constructor(private readonly ltm: LongTermMemoryService) {}

  /** 长期记忆总览（2026-10-04 P1 修复：tenantId 一律由 JWT 身份解析，
   * 商户自报他人租户 → 403；平台须显式指定，不再静默落 'default'——
   * 此前自报 tenantId 可读任意租户的用户档案与情节记忆） */
  @Get()
  async overview(@Req() req: Request, @Query('tenantId') tenantId?: string) {
    const scoped = resolveAdminTenantId(req, tenantId);
    const [profiles, episodes, archivals] = await Promise.all([
      this.ltm.getProfiles(scoped),
      this.ltm.listEpisodic(scoped, 20),
      this.ltm.listArchival(scoped, 20),
    ]);
    return {
      tenantId: scoped,
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
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ) {
    const scoped = resolveAdminTenantId(req, tenantId);
    const n = Math.min(Number.parseInt(limit ?? '20', 10) || 20, 200);
    return this.ltm.listEpisodic(scoped, n);
  }

  /** 归档列表 */
  @Get('archival')
  archival(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
    @Query('limit') limit?: string,
  ) {
    const scoped = resolveAdminTenantId(req, tenantId);
    const n = Math.min(Number.parseInt(limit ?? '20', 10) || 20, 200);
    return this.ltm.listArchival(scoped, n);
  }
}
