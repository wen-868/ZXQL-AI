/**
 * api_create_full_reduction 工具 — 创建满减活动（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/full-reductions
 * 后端校验（marketing-full-reduction.controller.ts createFullReduction zod schema）：
 * - name: string(1-128)
 * - rules: [{ minAmount, reduceAmount }]（至少 1 条，支持多级满减）
 * - applicableScope: ALL|CATEGORY|BRAND|SKU 默认 ALL
 * - applicableIds: number[] 可空
 * - startTime / endTime: string
 * - priority: int 默认 0 / stackable: boolean 默认 false / description 默认 ""
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

interface FullReductionRule {
  minAmount: number;
  reduceAmount: number;
}

interface CreateFullReductionArgs {
  name: string;
  rules: FullReductionRule[];
  applicableScope: string;
  applicableIds: number[] | null;
  startTime: string;
  endTime: string;
  priority: number;
  stackable: boolean;
  description: string;
  confirm?: boolean;
}

@Injectable()
export class CreateFullReductionTool implements ITool {
  private readonly logger = new Logger(CreateFullReductionTool.name);

  readonly name = 'api_create_full_reduction';
  readonly description =
    '创建满减活动（写操作，需用户确认）：支持多级满减规则（满X减Y）。' +
    '入参：name(活动名)、rules([{minAmount, reduceAmount}])、startTime/endTime(活动时间)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '满减活动名称（必填）' },
      rules: {
        type: 'array',
        description: '满减规则（必填，至少1条，如满100减10）',
        items: {
          type: 'object',
          properties: {
            minAmount: { type: 'number', description: '满额门槛' },
            reduceAmount: { type: 'number', description: '减免金额' },
          },
          required: ['minAmount', 'reduceAmount'],
        },
      },
      applicableScope: {
        type: 'string',
        enum: ['ALL', 'CATEGORY', 'BRAND', 'SKU'],
        description: '适用范围（默认 ALL）',
      },
      applicableIds: {
        type: 'array',
        items: { type: 'number' },
        description: '适用对象ID列表（可选）',
      },
      startTime: {
        type: 'string',
        description: '开始时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'string',
        description: '结束时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      stackable: { type: 'boolean', description: '是否可叠加（默认 false）' },
      description: { type: 'string', description: '活动说明（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['name', 'rules', 'startTime', 'endTime'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const a = parsed.data;
    const ruleText = a.rules
      .map((r) => `满${r.minAmount}减${r.reduceAmount}`)
      .join('、');

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '创建满减活动',
          summary: `新建满减「${a.name}」：${ruleText}，有效期 ${a.startTime} ~ ${a.endTime}`,
          details: {
            name: a.name,
            rules: a.rules,
            applicableScope: a.applicableScope,
            stackable: a.stackable,
            startTime: a.startTime,
            endTime: a.endTime,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MARKETING_FULL_REDUCTIONS,
        {
          name: a.name,
          rules: a.rules,
          applicableScope: a.applicableScope,
          applicableIds: a.applicableIds,
          startTime: a.startTime,
          endTime: a.endTime,
          priority: a.priority,
          stackable: a.stackable,
          description: a.description,
        },
        context,
      );
      this.logger.log(`创建满减活动成功：${a.name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建满减活动失败：${msg}`);
      return {
        success: false,
        error: `创建满减活动失败：${msg}`,
        suggestion: '请检查规则与时间格式后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateFullReductionArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 name 必填',
        suggestion: '请提供满减活动名称',
      };
    }
    if (!Array.isArray(args.rules) || args.rules.length === 0) {
      return {
        valid: false,
        error: '参数 rules 必须为非空数组',
        suggestion: '请至少配置一条满减规则',
      };
    }
    const rules: FullReductionRule[] = [];
    for (const raw of args.rules) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const minAmount = Number(r.minAmount);
      const reduceAmount = Number(r.reduceAmount);
      if (
        !Number.isFinite(minAmount) ||
        minAmount < 0 ||
        !Number.isFinite(reduceAmount) ||
        reduceAmount < 0
      ) {
        return {
          valid: false,
          error: 'rules[].minAmount/reduceAmount 必须为不小于 0 的数字',
          suggestion: '请检查满减规则',
        };
      }
      rules.push({ minAmount, reduceAmount });
    }
    const startTime = args.startTime;
    const endTime = args.endTime;
    if (
      typeof startTime !== 'string' ||
      typeof endTime !== 'string' ||
      !startTime ||
      !endTime
    ) {
      return {
        valid: false,
        error: '参数 startTime/endTime 必填',
        suggestion: '格式如 2026-09-01 00:00:00',
      };
    }
    const scope = args.applicableScope;
    const SCOPES = ['ALL', 'CATEGORY', 'BRAND', 'SKU'];
    if (
      scope !== undefined &&
      (typeof scope !== 'string' || !SCOPES.includes(scope))
    ) {
      return {
        valid: false,
        error: '参数 applicableScope 必须为 ALL/CATEGORY/BRAND/SKU',
        suggestion: '请检查适用范围',
      };
    }
    return {
      valid: true,
      data: {
        name: name.trim(),
        rules,
        applicableScope: scope === undefined ? 'ALL' : scope,
        applicableIds: Array.isArray(args.applicableIds)
          ? args.applicableIds.map(Number)
          : null,
        startTime,
        endTime,
        priority: args.priority === undefined ? 0 : Number(args.priority),
        stackable: args.stackable === true,
        description:
          typeof args.description === 'string' ? args.description : '',
        confirm: args.confirm === true,
      },
    };
  }
}
