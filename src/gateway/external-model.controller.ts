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
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../tenant/admin-auth.guard';
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

  /** 外部模型列表 */
  @Get()
  list() {
    return this.service.list();
  }

  /** 启用模型选项（配置页下拉） */
  @Get('options')
  options() {
    return this.service.options();
  }

  /** 添加外部模型 */
  @Post()
  create(@Body() dto: ExternalModelInput) {
    return this.service.create(dto);
  }

  /** 更新外部模型 */
  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ExternalModelInput,
  ) {
    return this.service.update(id, dto);
  }

  /** 删除外部模型 */
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }

  /** 连通性测试（不落库） */
  @Post('test')
  testConnection(@Body() dto: TestExternalModelDto) {
    return this.service.testConnection(dto);
  }

  /** 按 ID 测试已保存模型（后端解密密钥执行） */
  @Post('test/:id')
  testById(@Param('id', ParseIntPipe) id: number) {
    return this.service.testById(id);
  }
}
