/**
 * ExternalModelController — 外部大模型管理接口（完善度-外部模型接入）
 *
 * 端点列表（全局前缀 /api，实际路径 /api/admin/ai-config/external-models/...）：
 * - GET    /api/admin/ai-config/external-models        — 外部模型列表（apiKey 脱敏）
 * - GET    /api/admin/ai-config/external-models/options — 启用模型选项（配置页下拉）
 * - POST   /api/admin/ai-config/external-models        — 添加外部模型（加密存储 + 注册）
 * - PUT    /api/admin/ai-config/external-models/:id    — 更新（apiKey 留空不修改）
 * - DELETE /api/admin/ai-config/external-models/:id    — 删除（注销）
 * - POST   /api/admin/ai-config/external-models/test   — 连通性测试（不落库）
 *
 * 安全（2026-10-09 P0-1 修复）：外部模型库是**平台级**资源
 * （t_ai_external_model 无租户列，服务层全无 tenantId），而 AdminGuard 同时
 * 放行商家 4 类管理角色，此前任一租户管理员可改写平台模型库并用 test/:id
 * 让服务端解密已存密钥发往自选端点。现本控制器全部端点仅限平台身份，
 * 口径与 ai-config.controller.ts 的 requirePlatformIdentity() 一致。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminGuard, getAdminIdentity } from '../tenant/admin-auth.guard';
import { aiError } from '../common/ai-errors';
import {
  ExternalModelInput,
  ExternalModelService,
} from '../tenant/external-model.service';

/** 连通性测试载荷 */
export interface TestExternalModelDto {
  providerBaseUrl: string;
  apiKey: string;
  modelName: string;
}

@UseGuards(AdminGuard)
@Controller('admin/ai-config/external-models')
export class ExternalModelController {
  constructor(private readonly service: ExternalModelService) {}

  /**
   * 平台级资源守卫：商户身份访问 → 403
   *
   * 外部模型库为平台全局共享（影响所有租户的对话路由与出站端点），
   * 与 ai-config.controller.ts 的平台级端点同口径。
   */
  private requirePlatformIdentity(req: Request): void {
    const identity = getAdminIdentity(req);
    if (identity.identityType !== 'platform') {
      throw new ForbiddenException({
        statusCode: 403,
        ...aiError('AI_010', {
          detail: '平台级端点仅限总台平台身份访问',
        }),
      });
    }
  }

  /** 外部模型列表 */
  @Get()
  list(@Req() req: Request) {
    this.requirePlatformIdentity(req);
    return this.service.list();
  }

  /** 启用模型选项（配置页下拉） */
  @Get('options')
  options(@Req() req: Request) {
    this.requirePlatformIdentity(req);
    return this.service.options();
  }

  /** 添加外部模型 */
  @Post()
  create(@Req() req: Request, @Body() dto: ExternalModelInput) {
    this.requirePlatformIdentity(req);
    return this.service.create(dto);
  }

  /** 更新外部模型 */
  @Put(':id')
  update(
    @Req() req: Request,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExternalModelInput,
  ) {
    this.requirePlatformIdentity(req);
    return this.service.update(id, dto);
  }

  /** 删除外部模型 */
  @Delete(':id')
  remove(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    this.requirePlatformIdentity(req);
    return this.service.remove(id);
  }

  /** 连通性测试（不落库） */
  @Post('test')
  testConnection(@Req() req: Request, @Body() dto: TestExternalModelDto) {
    this.requirePlatformIdentity(req);
    return this.service.testConnection(dto);
  }

  /** 按 ID 测试已保存模型（后端解密密钥执行） */
  @Post('test/:id')
  testById(@Req() req: Request, @Param('id', ParseIntPipe) id: number) {
    this.requirePlatformIdentity(req);
    return this.service.testById(id);
  }
}
