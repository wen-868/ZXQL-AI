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
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
} from '@nestjs/common';
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

  /** 过期时间（ISO 字符串，不传=永不过期） */
  @IsOptional()
  @IsString()
  expiresAt?: string;
}

/** 启停请求 */
export class SetMcpTokenEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

@Controller('admin/mcp-tokens')
export class McpAdminController {
  constructor(private readonly tokenService: McpTokenService) {}

  /**
   * 列表（总台全量，可按租户过滤）
   */
  @Get()
  async list(
    @Query('tenantId') tenantId?: string,
  ): Promise<{ total: number; items: McpTokenEntity[] }> {
    const items = await this.tokenService.list(tenantId);
    return { total: items.length, items };
  }

  /**
   * 生成 MCP Token（token 明文仅本次返回，请交付第三方后妥善保管）
   */
  @Post()
  async create(
    @Body() dto: CreateMcpTokenDto,
  ): Promise<{ success: boolean; token?: string; message: string }> {
    const entity = await this.tokenService.create({
      tenantId: dto.tenantId,
      name: dto.name,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
    return {
      success: true,
      token: entity.token,
      message: 'MCP Token 已生成（请立即保存，明文仅本次返回）',
    };
  }

  /**
   * 启停 Token
   */
  @Post(':id/enabled')
  async setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetMcpTokenEnabledDto,
  ): Promise<{ success: boolean; message: string }> {
    const ok = await this.tokenService.setEnabled(id, dto.enabled);
    return ok
      ? {
          success: true,
          message: dto.enabled ? '已启用' : '已停用',
        }
      : { success: false, message: 'Token 不存在' };
  }

  /**
   * 删除 Token
   */
  @Delete(':id')
  async remove(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<{ success: boolean; message: string }> {
    const ok = await this.tokenService.remove(id);
    return ok
      ? { success: true, message: '已删除' }
      : { success: false, message: 'Token 不存在' };
  }
}
