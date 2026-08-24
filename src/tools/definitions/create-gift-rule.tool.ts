/**
 * api_create_gift_rule 工具 — 创建赠品规则（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/gift-rules
 * 后端校验（marketing-gift-rule.controller.ts createGiftRuleSchema，字段为 snake_case）：
 * - rule_name(1-200)、threshold_type(AMOUNT|QUANTITY)、threshold_amount(>0)
 * - start_time / end_time、status(DRAFT|ACTIVE|PAUSED 默认 DRAFT)
 * - rule_desc、applicable_scope(ALL|SPECIFIC 默认 ALL)、gift_stock_limit
 * - levels: [{ gift_product_id, gift_sku_id, gift_quantity, sort_order }]
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

interface GiftLevel {
  gift_product_id: number;
  gift_sku_id: number;
  gift_quantity: number;
  sort_order: number;
}

interface CreateGiftRuleArgs {
  rule_name: string;
  threshold_type: string;
  threshold_amount: number;
  start_time: string;
  end_time: string;
  status: string;
  rule_desc: string;
  applicable_scope: string;
  gift_stock_limit?: number;
  levels: GiftLevel[];
  confirm?: boolean;
}

@Injectable()
export class CreateGiftRuleTool implements ITool {
  private readonly logger = new Logger(CreateGiftRuleTool.name);

  readonly name = 'api_create_gift_rule';
  readonly description =
    '创建赠品规则（写操作，需用户确认）：满额/满量赠礼。' +
    '入参：ruleName(规则名)、thresholdType(AMOUNT金额/QUANTITY数量)、thresholdAmount(门槛)、' +
    'startTime/endTime(有效期)、levels([{giftProductId,giftSkuId,giftQuantity}])。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      ruleName: { type: 'string', description: '赠品规则名称（必填）' },
      thresholdType: {
        type: 'string',
        enum: ['AMOUNT', 'QUANTITY'],
        description: '触发类型（必填）：AMOUNT按金额/QUANTITY按数量',
      },
      thresholdAmount: { type: 'number', description: '触发门槛（必填，>0）' },
      startTime: {
        type: 'string',
        description: '开始时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'string',
        description: '结束时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      status: {
        type: 'string',
        enum: ['DRAFT', 'ACTIVE', 'PAUSED'],
        description: '状态（默认 DRAFT）',
      },
      giftStockLimit: { type: 'number', description: '赠品库存上限（可选）' },
      levels: {
        type: 'array',
        description: '赠品档位（必填）',
        items: {
          type: 'object',
          properties: {
            giftProductId: { type: 'number', description: '赠品商品ID' },
            giftSkuId: { type: 'number', description: '赠品SKU ID' },
            giftQuantity: { type: 'number', description: '赠品数量' },
          },
          required: ['giftProductId', 'giftSkuId', 'giftQuantity'],
        },
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: [
      'ruleName',
      'thresholdType',
      'thresholdAmount',
      'startTime',
      'endTime',
      'levels',
    ],
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

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '创建赠品规则',
          summary:
            `新建赠品规则「${a.rule_name}」：` +
            `${a.threshold_type === 'AMOUNT' ? '满' : '买'}${a.threshold_amount}` +
            `赠 ${a.levels.length} 档礼品，有效期 ${a.start_time} ~ ${a.end_time}`,
          details: {
            ruleName: a.rule_name,
            thresholdType: a.threshold_type,
            thresholdAmount: a.threshold_amount,
            startTime: a.start_time,
            endTime: a.end_time,
            levels: a.levels,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MARKETING_GIFT_RULES,
        {
          rule_name: a.rule_name,
          threshold_type: a.threshold_type,
          threshold_amount: a.threshold_amount,
          start_time: a.start_time,
          end_time: a.end_time,
          status: a.status,
          rule_desc: a.rule_desc,
          applicable_scope: a.applicable_scope,
          gift_stock_limit: a.gift_stock_limit ?? null,
          levels: a.levels,
        },
        context,
      );
      this.logger.log(`创建赠品规则成功：${a.rule_name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建赠品规则失败：${msg}`);
      return {
        success: false,
        error: `创建赠品规则失败：${msg}`,
        suggestion: '请检查触发门槛与赠品明细后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateGiftRuleArgs }
    | { valid: false; error: string; suggestion?: string } {
    const rule_name = args.ruleName;
    if (typeof rule_name !== 'string' || rule_name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 ruleName 必填',
        suggestion: '请提供赠品规则名称',
      };
    }
    const threshold_type = args.thresholdType;
    if (threshold_type !== 'AMOUNT' && threshold_type !== 'QUANTITY') {
      return {
        valid: false,
        error: '参数 thresholdType 必须为 AMOUNT/QUANTITY',
        suggestion: '请选择触发类型',
      };
    }
    const threshold_amount = Number(args.thresholdAmount);
    if (!Number.isFinite(threshold_amount) || threshold_amount <= 0) {
      return {
        valid: false,
        error: '参数 thresholdAmount 必须为大于 0 的数字',
        suggestion: '请检查触发门槛',
      };
    }
    const start_time = args.startTime;
    const end_time = args.endTime;
    if (
      typeof start_time !== 'string' ||
      typeof end_time !== 'string' ||
      !start_time ||
      !end_time
    ) {
      return {
        valid: false,
        error: '参数 startTime/endTime 必填',
        suggestion: '格式如 2026-09-01 00:00:00',
      };
    }
    if (!Array.isArray(args.levels) || args.levels.length === 0) {
      return {
        valid: false,
        error: '参数 levels 必须为非空数组',
        suggestion: '请配置赠品档位',
      };
    }
    const levels: GiftLevel[] = [];
    for (const raw of args.levels) {
      const l = (raw ?? {}) as Record<string, unknown>;
      const gift_product_id = Number(l.giftProductId);
      const gift_sku_id = Number(l.giftSkuId);
      const gift_quantity = Number(l.giftQuantity);
      if (
        !Number.isInteger(gift_product_id) ||
        gift_product_id <= 0 ||
        !Number.isInteger(gift_sku_id) ||
        gift_sku_id <= 0 ||
        !Number.isInteger(gift_quantity) ||
        gift_quantity <= 0
      ) {
        return {
          valid: false,
          error: 'levels[].giftProductId/giftSkuId/giftQuantity 必须为正整数',
          suggestion: '请检查赠品档位',
        };
      }
      levels.push({
        gift_product_id,
        gift_sku_id,
        gift_quantity,
        sort_order: 0,
      });
    }
    const status = args.status;
    if (
      status !== undefined &&
      status !== 'DRAFT' &&
      status !== 'ACTIVE' &&
      status !== 'PAUSED'
    ) {
      return {
        valid: false,
        error: '参数 status 必须为 DRAFT/ACTIVE/PAUSED',
        suggestion: '请检查状态',
      };
    }
    return {
      valid: true,
      data: {
        rule_name: rule_name.trim(),
        threshold_type,
        threshold_amount,
        start_time,
        end_time,
        status: status === undefined ? 'DRAFT' : status,
        rule_desc: typeof args.ruleDesc === 'string' ? args.ruleDesc : '',
        applicable_scope: 'ALL',
        gift_stock_limit:
          args.giftStockLimit === undefined
            ? undefined
            : Number(args.giftStockLimit),
        levels,
        confirm: args.confirm === true,
      },
    };
  }
}
