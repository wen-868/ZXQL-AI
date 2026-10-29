import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtGuard, getAdminIdentity } from '../tenant/admin-auth.guard';
import { ScheduleDomainService } from '../brain/schedule/schedule-domain.service';

interface IdentityCtx {
  tenantId: string;
  principal: {
    type: 'user' | 'employee';
    id: string;
    roles?: string[];
    isPlatform?: boolean;
  };
}

function ctxOf(req: Request): IdentityCtx {
  const id = getAdminIdentity(req);
  const principal: IdentityCtx['principal'] = {
    type: 'user',
    id: String(id.userId),
    roles: id.roles,
    isPlatform: id.identityType === 'platform',
  };
  return { tenantId: id.tenantId ?? '', principal };
}

@Controller('schedule')
@UseGuards(JwtGuard)
export class ScheduleController {
  constructor(private readonly domain: ScheduleDomainService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
  ) {
    const c = ctxOf(req);
    const rows = await this.domain.listVisible(c, {
      from: from ? new Date(from) : null,
      to: to ? new Date(to) : null,
      status: (status ?? null) as 'planned' | 'done' | 'cancelled' | null,
    });
    return { success: true, total: rows.length, list: rows };
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const c = ctxOf(req);
    const s = await this.domain.getById(id, c);
    if (!s) return { success: false, error: 'not found' };
    const access = await this.domain.resolveAccess(s, c);
    if (access === 'none') return { success: false, error: 'forbidden' };
    return { success: true, data: s, access };
  }

  @Post()
  async create(@Req() req: Request, @Body() body: Record<string, unknown>) {
    const c = ctxOf(req);
    const preview = this.domain.buildPreview(body as never);
    if (!body?.confirm) return { success: true, preview };
    const res = await this.domain.create(c, body as never);
    return { success: true, data: res };
  }

  @Put(':id')
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const c = ctxOf(req);
    const scope = String((body?.scope as string | undefined) ?? 'single') as
      'single' | 'following' | 'all';
    if (!body?.confirm) {
      const s = await this.domain.getById(id, c);
      return {
        success: true,
        preview: { scheduleId: id, title: s?.title, changes: body },
      };
    }
    const res = await this.domain.update(c, id, body, scope);
    return { success: true, data: res };
  }

  @Post(':id/complete')
  async complete(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const c = ctxOf(req);
    const scope = String((body?.scope as string | undefined) ?? 'single') as
      'single' | 'following' | 'all';
    const res = await this.domain.changeStatus(c, id, 'done', scope);
    return { success: true, data: res };
  }

  @Post(':id/cancel')
  async cancel(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    const c = ctxOf(req);
    const scope = String((body?.scope as string | undefined) ?? 'single') as
      'single' | 'following' | 'all';
    const res = await this.domain.changeStatus(c, id, 'cancelled', scope);
    return { success: true, data: res };
  }
}
