/**
 * api_create_group_buy 工具 — 创建拼团活动（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/group-buys
 * 后端校验（marketing-group-buy.controller.ts createGroupBuy zod schema）：
 * - name(1-128)、productId、skuId、groupPrice、originalPrice
 * - minGroupSize>=2、maxGroupSize>=2、timeLimitHours 默认24、totalStock
 * - startTime / endTime
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

interface CreateGroupBuyArgs {
  name: string;
  productId: number;
  skuId: number;
  groupPrice: number;
  originalPrice: number;
  minGroupSize: number;
  maxGroupSize: number;
  timeLimitHours: number;
  totalStock: number;
  startTime: string;
  endTime: string;
  confirm?: boolean;
}

@Injectable()
export class CreateGroupBuyTool implements ITool {
  private readonly logger = new Logger(CreateGroupBuyTool.name);

  readonly name = 'api_create_group_buy';
  readonly description =
    '创建拼团活动（写操作，需用户确认）：为商品设置拼团价与成团人数。' +
    '入参：name、productId、skuId、groupPrice(拼团价)、originalPrice(原价)、' +
    'minGroupSize(成团人数)、maxGroupSize(上限)、totalStock(活动库存)、startTime/endTime。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '拼团活动名称（必填）' },
      productId: { type: 'number', description: '商品SPU ID（必填）' },
      skuId: { type: 'number', description: 'SKU ID（必填）' },
      groupPrice: { type: 'number', description: '拼团价（必填）' },
      originalPrice: { type: 'number', description: '原价（必填）' },
      minGroupSize: { type: 'number', description: '成团人数（必填，>=2）' },
      maxGroupSize: { type: 'number', description: '成团上限（必填，>=2）' },
      timeLimitHours: {
        type: 'number',
        description: '成团时限（小时，默认24）',
      },
      totalStock: { type: 'number', description: '活动库存（必填）' },
      startTime: {
        type: 'string',
        description: '开始时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'string',
        description: '结束时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: [
      'name',
      'productId',
      'skuId',
      'groupPrice',
      'originalPrice',
      'minGroupSize',
      'maxGroupSize',
      'totalStock',
      'startTime',
      'endTime',
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
          operation: '创建拼团活动',
          summary:
            `新建拼团「${a.name}」：${a.groupPrice}元（原价 ${a.originalPrice}元），` +
            `${a.minGroupSize}人成团，库存 ${a.totalStock}`,
          details: {
            name: a.name,
            productId: a.productId,
            skuId: a.skuId,
            groupPrice: a.groupPrice,
            originalPrice: a.originalPrice,
            minGroupSize: a.minGroupSize,
            maxGroupSize: a.maxGroupSize,
            timeLimitHours: a.timeLimitHours,
            totalStock: a.totalStock,
            startTime: a.startTime,
            endTime: a.endTime,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MARKETING_GROUP_BUYS,
        {
          name: a.name,
          productId: a.productId,
          skuId: a.skuId,
          groupPrice: a.groupPrice,
          originalPrice: a.originalPrice,
          minGroupSize: a.minGroupSize,
          maxGroupSize: a.maxGroupSize,
          timeLimitHours: a.timeLimitHours,
          totalStock: a.totalStock,
          startTime: a.startTime,
          endTime: a.endTime,
        },
        context,
      );
      this.logger.log(`创建拼团活动成功：${a.name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建拼团活动失败：${msg}`);
      return {
        success: false,
        error: `创建拼团活动失败：${msg}`,
        suggestion: '请确认商品/成团人数与时间格式后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateGroupBuyArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 name 必填',
        suggestion: '请提供拼团活动名称',
      };
    }
    const productId = Number(args.productId);
    const skuId = Number(args.skuId);
    if (!Number.isInteger(productId) || productId <= 0)
      return {
        valid: false,
        error: '参数 productId 必须为正整数',
        suggestion: '请提供商品SPU ID',
      };
    if (!Number.isInteger(skuId) || skuId <= 0)
      return {
        valid: false,
        error: '参数 skuId 必须为正整数',
        suggestion: '请提供SKU ID',
      };
    const groupPrice = Number(args.groupPrice);
    const originalPrice = Number(args.originalPrice);
    if (!Number.isFinite(groupPrice) || groupPrice < 0)
      return {
        valid: false,
        error: '参数 groupPrice 必须为不小于 0 的数字',
        suggestion: '请检查拼团价',
      };
    if (!Number.isFinite(originalPrice) || originalPrice < 0)
      return {
        valid: false,
        error: '参数 originalPrice 必须为不小于 0 的数字',
        suggestion: '请检查原价',
      };
    const minGroupSize = Number(args.minGroupSize);
    const maxGroupSize = Number(args.maxGroupSize);
    if (!Number.isInteger(minGroupSize) || minGroupSize < 2)
      return {
        valid: false,
        error: '参数 minGroupSize 必须为 >=2 的整数',
        suggestion: '请检查成团人数',
      };
    if (!Number.isInteger(maxGroupSize) || maxGroupSize < minGroupSize)
      return {
        valid: false,
        error: '参数 maxGroupSize 必须 >= minGroupSize',
        suggestion: '请检查成团上限',
      };
    const totalStock = Number(args.totalStock);
    if (!Number.isInteger(totalStock) || totalStock < 0)
      return {
        valid: false,
        error: '参数 totalStock 必须为不小于 0 的整数',
        suggestion: '请检查活动库存',
      };
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
    return {
      valid: true,
      data: {
        name: name.trim(),
        productId,
        skuId,
        groupPrice,
        originalPrice,
        minGroupSize,
        maxGroupSize,
        timeLimitHours:
          args.timeLimitHours === undefined ? 24 : Number(args.timeLimitHours),
        totalStock,
        startTime,
        endTime,
        confirm: args.confirm === true,
      },
    };
  }
}
