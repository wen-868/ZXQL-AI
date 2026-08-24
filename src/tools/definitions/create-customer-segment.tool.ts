/**
 * api_create_customer_segment 工具 — 创建客户分群（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/members/segments
 * 后端校验（customer-segment.controller.ts createSegmentSchema）：
 * - segmentName(1-100)、conditions(对象，分群条件)、autoRefresh(可选)
 *
 * 确认机制：confirm=false 生成预览；confirm=true 正式创建。
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
export class CreateCustomerSegmentTool implements ITool {
  private readonly logger = new Logger(CreateCustomerSegmentTool.name);

  readonly name = 'api_create_customer_segment';
  readonly description =
    '创建客户分群（写操作，需用户确认）：按条件圈选客户群体。' +
    '入参：segmentName(分群名称)、conditions(条件对象，如{"totalAmount":{">":10000}})、' +
    'autoRefresh(是否自动刷新,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      segmentName: { type: 'string', description: '分群名称（必填）' },
      conditions: {
        type: 'object',
        description: '分群条件对象（必填，如 {"customerType":"wholesale"}）',
      },
      autoRefresh: { type: 'boolean', description: '是否自动刷新（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['segmentName', 'conditions'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const segmentName = args.segmentName;
    if (
      typeof segmentName !== 'string' ||
      segmentName.trim().length === 0 ||
      segmentName.length > 100
    ) {
      return {
        success: false,
        error: '参数 segmentName 必填（1-100字）',
        suggestion: '请提供分群名称',
      };
    }
    if (
      !args.conditions ||
      typeof args.conditions !== 'object' ||
      Array.isArray(args.conditions)
    ) {
      return {
        success: false,
        error: '参数 conditions 必须为对象',
        suggestion: '请提供分群条件，如 {"customerType":"wholesale"}',
      };
    }
    const conditions = args.conditions as Record<string, unknown>;
    const confirm = args.confirm === true;
    const conditionCount = Object.keys(conditions).length;

    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '创建客户分群',
          summary: `新建客户分群「${segmentName.trim()}」（${conditionCount} 个条件）`,
          details: {
            segmentName: segmentName.trim(),
            conditions,
            autoRefresh: args.autoRefresh === true,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MEMBER_SEGMENTS,
        {
          segmentName: segmentName.trim(),
          conditions,
          autoRefresh: args.autoRefresh === true,
        },
        context,
      );
      this.logger.log(`创建客户分群成功：${segmentName.trim()}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建客户分群失败：${msg}`);
      return {
        success: false,
        error: `创建客户分群失败：${msg}`,
        suggestion: '请检查分群名称与条件后重试',
      };
    }
  }
}
