/**
 * ApiCatalogController — 总台注册表 → AI 工具管理接口（完善度 P0-8）
 *
 * 端点列表（全局前缀 /api）：
 * - GET  /api/admin/api-catalog               — 查看 API 目录（可生成的技能清单）
 * - POST /api/admin/api-catalog/register      — 生成并注册目录工具（功能即技能）
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Controller, Get, Logger, Post } from '@nestjs/common';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolGeneratorService } from '../tools/catalog/tool-generator.service';

@Controller('admin/api-catalog')
export class ApiCatalogController {
  private readonly logger = new Logger(ApiCatalogController.name);

  constructor(
    private readonly generator: ToolGeneratorService,
    private readonly registry: ToolRegistry,
  ) {}

  /** 查看 API 目录（可生成的技能清单） */
  @Get()
  list() {
    return {
      enabled: this.generator.isEnabled(),
      total: this.generator.getCatalog().length,
      catalog: this.generator.getCatalog(),
    };
  }

  /** 生成并注册目录工具（功能即技能；幂等：已注册跳过） */
  @Post('register')
  register() {
    const registered = this.generator.generateAndRegister(this.registry);
    this.logger.log(`API 目录工具注册接口调用：新注册 ${registered} 个`);
    return {
      success: true,
      registered,
      total: this.registry.list().length,
    };
  }
}
