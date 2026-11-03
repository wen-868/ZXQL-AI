/**
 * ToolGeneratorService — 总台注册表 → AI 工具生成器（完善度 P0-8）
 *
 * 职责：
 * 1. 按 API 目录条目生成 DynamicApiTool（一条目录 = 一个 AI 技能）
 * 2. 提供目录查询与注册能力（管理接口 / 启动开关按需接入）
 * 3. 实现「系统所有功能变成 AI 的技能」：新增后端 API 登记目录即可成为工具
 *
 * 写条目 fail-closed 闸（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01）：
 * 生成与注册层对写条目（isWriteOperation=true）及非法元数据一律结构化拒绝——
 * 不构造可执行写工具、不向 ToolRegistry 注册、返回结构化拒绝结果（工具名+原因）
 * 并打结构化日志（tool/method/path/reason，不含凭据与 body）。
 * 未来开放动态写的唯一条件：先落地 preview/confirm 二段式与幂等契约，
 * 再显式声明 dynamicWriteCapability；仅把条目加入目录不构成开放。
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
import { DynamicApiTool, validateDynamicToolDef } from './dynamic-api.tool';

/** 结构化拒绝记录（含工具名与原因；不含凭据与 body） */
export interface DynamicToolRejection {
  name: string;
  reason: string;
}

/** 注册结果（注册数 + 结构化拒绝清单） */
export interface DynamicToolRegistrationResult {
  registered: number;
  rejected: DynamicToolRejection[];
}

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
   * 生成目录工具（不注册；写条目与非法元数据 fail-closed 拒绝，不产出可执行工具）
   */
  generate(defs: ApiRouteDef[] = API_CATALOG): ITool[] {
    return this.generateDetailed(defs).tools;
  }

  /**
   * 生成明细：安全工具 + 结构化拒绝清单（显式可观测，不静默降级）
   */
  generateDetailed(defs: ApiRouteDef[] = API_CATALOG): {
    tools: ITool[];
    rejected: DynamicToolRejection[];
  } {
    const tools: ITool[] = [];
    const rejected: DynamicToolRejection[] = [];
    const seen = new Set<string>();
    for (const def of defs) {
      const verdict = validateDynamicToolDef(def);
      if (!verdict.ok) {
        const name = def?.name || '<空>';
        rejected.push({ name, reason: verdict.reason || '未知原因' });
        this.logger.warn(
          `动态工具定义已拒绝（fail-closed）：tool=${name} ` +
            `method=${def?.method ?? '-'} path=${def?.path ?? '-'} reason=${verdict.reason}`,
        );
        continue;
      }
      if (seen.has(def.name)) {
        rejected.push({ name: def.name, reason: '批量内重复名称' });
        this.logger.warn(
          `动态工具定义已拒绝（fail-closed）：tool=${def.name} ` +
            `method=${def.method} path=${def.path} reason=批量内重复名称`,
        );
        continue;
      }
      seen.add(def.name);
      tools.push(new DynamicApiTool(this.serviceClient, def));
    }
    if (rejected.length > 0) {
      this.logger.warn(
        `动态工具生成完成：通过 ${tools.length} 个，拒绝 ${rejected.length} 个` +
          `（${rejected.map((r) => `${r.name}:${r.reason}`).join('；')}）`,
      );
    }
    return { tools, rejected };
  }

  /**
   * 生成并注册到 ToolRegistry（跳过已注册名称；写条目与非法元数据拒绝且不注册）
   *
   * @returns 注册数与结构化拒绝清单
   */
  generateAndRegister(
    registry: ToolRegistry,
    defs: ApiRouteDef[] = API_CATALOG,
  ): DynamicToolRegistrationResult {
    const { tools, rejected } = this.generateDetailed(defs);
    let registered = 0;
    for (const tool of tools) {
      if (!registry.has(tool.name)) {
        registry.register(tool);
        registered += 1;
      }
    }
    if (registered > 0) {
      this.logger.log(
        `API 目录工具已注册：${registered} 个（共 ${defs.length} 条目录，拒绝 ${rejected.length} 条）`,
      );
    }
    return { registered, rejected };
  }
}
