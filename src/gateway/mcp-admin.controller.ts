/**
 * McpAdminController — 总台 MCP 对接 Token 管理（P0-3）
 *
 * 端点（总台 AI 配置中心「MCP 对接 Token」）：
 * - GET    /api/admin/mcp-tokens?tenantId=xxx  列表
 * - POST   /api/admin/mcp-tokens               生成（返回 token 明文，仅此一次）
 * - POST   /api/admin/mcp-tokens/:id/enabled   启停
 * - DELETE /api/admin/mcp-tokens/:id           删除
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { McpTokenService } from '../brain/mcp/mcp-token.service';
import { McpTokenEntity } from '../database/entities/mcp-token.entity';

/** 生成 Token 请求 */
export class CreateMcpTokenDto {
  /** 绑定的租户 ID */
  @IsString()
  @IsNotEmpty({ message: 'tenantId 不能为空' })
  tenantId!: string;

  /** 标识名称（如"WorkBuddy对接"） */
  @IsOptional()
  @IsString()
  name?: string;

  /** 过期时间（ISO 字符串，不传则按 MCP_TOKEN_TTL_DAYS 默认兜底，默认 90 天） */
  @IsOptional()
  @IsString()
  expiresAt?: string;
}

/** 启停请求 */
export class SetMcpTokenEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

@UseGuards(AdminGuard)
@Controller('admin/mcp-tokens')
export class McpAdminController {
  constructor(private readonly tokenService: McpTokenService) {}

  /**
   * 列表（总台全量，可按租户过滤；商户身份强制本租户——2026-10-04 P1 修复：
   * 此前 tenantId 由查询参数自报，商户管理员可枚举他人租户的全部 Token）
   */
  @Get()
  async list(
    @Req() req: Request,
    @Query('tenantId') tenantId?: string,
  ): Promise<{ total: number; items: McpTokenEntity[] }> {
    const scopedTenantId = resolveOptionalAdminTenantId(req, tenantId);
    const items = await this.tokenService.list(scopedTenantId);
    return { total: items.length, items };
  }

  /**
   * 生成 MCP Token（token 明文仅本次返回，请交付第三方后妥善保管；库中只存 SHA-256 哈希）
   *
   * 2026-10-04 P1 修复：商户身份只能为本租户签发（自报他人租户 → 403），
   * 防止为他人租户铸造 Token 拿到其数据通道。
   */
  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateMcpTokenDto,
  ): Promise<{ success: boolean; token?: string; message: string }> {
    const tenantId = resolveAdminTenantId(req, dto.tenantId);
    // P3 修复（2026-10-04）：非法日期串此前入库报 500，这里显式 400
    let expiresAt: Date | undefined;
    if (dto.expiresAt) {
      expiresAt = new Date(dto.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new BadRequestException(
          `expiresAt 不是合法日期：${dto.expiresAt}（ISO 8601 格式，如 2026-12-31T00:00:00Z）`,
        );
      }
    }
    const { plaintext } = await this.tokenService.create({
      tenantId,
      name: dto.name,
      expiresAt,
    });
    return {
      success: true,
      token: plaintext,
      message: 'MCP Token 已生成（请立即保存，明文仅本次返回）',
    };
  }

  /**
   * 启停 Token（商户身份仅限本租户的 Token，跨租户 id 落到"不存在"）
   */
  @Post(':id/enabled')
  async setEnabled(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetMcpTokenEnabledDto,
  ): Promise<{ success: boolean; message: string }> {
    const tenantId = resolveOptionalAdminTenantId(req);
    const ok = await this.tokenService.setEnabledFor(id, dto.enabled, tenantId);
    return ok
      ? {
          success: true,
          message: dto.enabled ? '已启用' : '已停用',
        }
      : { success: false, message: 'Token 不存在' };
  }

  /**
   * 删除 Token（租户域语义同启停）
   */
  @Delete(':id')
  async remove(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: boolean; message: string }> {
    const tenantId = resolveOptionalAdminTenantId(req);
    const ok = await this.tokenService.removeFor(id, tenantId);
    return ok
      ? { success: true, message: '已删除' }
      : { success: false, message: 'Token 不存在' };
  }
}
