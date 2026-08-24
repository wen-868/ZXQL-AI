/**
 * DynamicApiTool — 通用动态 API 工具（完善度 P0-8「功能即技能」）
 *
 * 由 ToolGeneratorService 按 API 目录条目生成：一个条目 = 一个工具，
 * 内部经 ServiceClient 调用管理系统后端真实端点（路径占位符替换 + GET 参数透传）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { ServiceClient } from '../../bridge/service-client';
import {
  ITool,
  ToolCategory,
  ToolContext,
  ToolResult,
  ToolRisk,
  ToolScope,
} from '../tool.interface';
import type { ApiRouteDef } from './api-catalog';

@Injectable()
export class DynamicApiTool implements ITool {
  private readonly logger: Logger;

  readonly name: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly parameters: object;
  readonly isWriteOperation: boolean;
  readonly risk: ToolRisk;
  readonly needsReview?: boolean;
  readonly scope?: ToolScope;

  constructor(
    private readonly serviceClient: ServiceClient,
    private readonly def: ApiRouteDef,
  ) {
    this.logger = new Logger(`DynamicApi:${def.name}`);
    this.name = def.name;
    this.description = def.description;
    this.category = def.category;
    this.parameters = def.parameters;
    this.isWriteOperation = def.isWriteOperation;
    this.risk = def.risk;
    this.needsReview = def.needsReview;
    this.scope = def.scope ?? 'mgmt';
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    try {
      // 1. 路径占位符替换 + 参数分流（GET→query，其余→body）
      let path = this.def.path;
      const query: Record<string, unknown> = {};
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (path.includes(`{${key}}`)) {
          path = path.replace(`{${key}}`, encodeURIComponent(String(value)));
        } else if (this.def.method === 'GET') {
          query[key] = value;
        } else {
          body[key] = value;
        }
      }

      // 2. 调用后端真实端点
      let data: unknown;
      switch (this.def.method) {
        case 'GET':
          data = await this.serviceClient.get(path, context, {
            params: query,
          });
          break;
        case 'POST':
          data = await this.serviceClient.post(path, body, context);
          break;
        case 'PUT':
          data = await this.serviceClient.put(path, body, context);
          break;
        case 'DELETE':
          data = await this.serviceClient.delete(path, context);
          break;
      }

      return { success: true, data };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${this.def.method} ${this.def.path} 失败：${message}`);
      return {
        success: false,
        error: `调用 ${this.name} 失败：${message}`,
        suggestion: '请检查参数是否完整或稍后重试',
      };
    }
  }
}
