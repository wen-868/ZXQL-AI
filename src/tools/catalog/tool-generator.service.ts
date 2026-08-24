/**
 * ToolGeneratorService — 总台注册表 → AI 工具生成器（完善度 P0-8）
 *
 * 职责：
 * 1. 按 API 目录条目生成 DynamicApiTool（一条目录 = 一个 AI 技能）
 * 2. 提供目录查询与注册能力（管理接口 / 启动开关按需接入）
 * 3. 实现「系统所有功能变成 AI 的技能」：新增后端 API 登记目录即可成为工具
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-8 工具化体系
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolRegistry } from '../tool-registry';
import type { ITool } from '../tool.interface';
import { API_CATALOG, ApiRouteDef } from './api-catalog';
import { DynamicApiTool } from './dynamic-api.tool';

@Injectable()
export class ToolGeneratorService {
  private readonly logger = new Logger(ToolGeneratorService.name);
  private readonly enabled: boolean;

  constructor(
    private readonly serviceClient: ServiceClient,
    private readonly configService: ConfigService,
  ) {
    this.enabled =
      this.configService.get<string>('ENABLE_API_CATALOG_TOOLS', 'false') ===
      'true';
  }

  /**
   * 目录是否启用（ENABLE_API_CATALOG_TOOLS）
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 获取 API 目录（供管理接口展示）
   */
  getCatalog(): ApiRouteDef[] {
    return API_CATALOG;
  }

  /**
   * 生成目录工具（不注册）
   */
  generate(defs: ApiRouteDef[] = API_CATALOG): ITool[] {
    return defs.map((def) => new DynamicApiTool(this.serviceClient, def));
  }

  /**
   * 生成并注册到 ToolRegistry（跳过已注册名称）
   *
   * @returns 本次新注册的工具数
   */
  generateAndRegister(
    registry: ToolRegistry,
    defs: ApiRouteDef[] = API_CATALOG,
  ): number {
    let registered = 0;
    for (const tool of this.generate(defs)) {
      if (!registry.has(tool.name)) {
        registry.register(tool);
        registered += 1;
      }
    }
    if (registered > 0) {
      this.logger.log(
        `API 目录工具已注册：${registered} 个（共 ${defs.length} 条目录）`,
      );
    }
    return registered;
  }
}
