/**
 * api_auto_generate_collections 工具 — 自动生成催收计划（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/credits/collections/auto-generate
 * 后端服务：creditScoringService.autoGenerateCollections（按逾期策略自动生成催收任务）
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式执行。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

@Injectable()
export class AutoGenerateCollectionsTool implements ITool {
  private readonly logger = new Logger(AutoGenerateCollectionsTool.name);

  readonly name = 'api_auto_generate_collections';
  readonly description =
    '自动生成催收计划（写操作，需用户确认）：按逾期策略为逾期客户自动生成催收任务。' +
    '无入参。首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式执行。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=执行，默认 false）',
      },
    },
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const confirm = args.confirm === true;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '自动生成催收计划',
          summary: '按逾期策略为逾期客户自动生成催收任务',
          details: {},
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        `${API_ENDPOINTS.CREDIT_COLLECTIONS}/auto-generate`,
        {},
        context,
      );
      this.logger.log('自动生成催收计划完成');
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`自动生成催收计划失败：${msg}`);
      return {
        success: false,
        error: `自动生成催收计划失败：${msg}`,
        suggestion: '请确认逾期策略配置后重试',
      };
    }
  }
}
