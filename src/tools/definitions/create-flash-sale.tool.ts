/**
 * api_create_flash_sale 工具 — 创建秒杀活动（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/flash-sales
 * 后端路由：admin-marketing-flash-sale.routes.ts（prefix: /api/admin/marketing）
 * 后端校验（marketing-flash-sale.controller.ts createFlashSale zod schema）：
 * - name: string(1-128) 必填
 * - productId: int>0 必填（商品SPU）
 * - skuId: int>0 必填（SKU）
 * - flashPrice: number>=0 必填（秒杀价）
 * - originalPrice: number>=0 必填（原价）
 * - totalStock: int>=0 必填（活动库存）
 * - limitPerUser: int>=1 默认 1
 * - startTime / endTime: string 必填
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

interface CreateFlashSaleArgs {
  name: string;
  productId: number;
  skuId: number;
  flashPrice: number;
  originalPrice: number;
  totalStock: number;
  limitPerUser: number;
  startTime: string;
  endTime: string;
  confirm?: boolean;
}

@Injectable()
export class CreateFlashSaleTool implements ITool {
  private readonly logger = new Logger(CreateFlashSaleTool.name);

  readonly name = 'api_create_flash_sale';
  readonly description =
    '创建秒杀活动（写操作，需用户确认）：为指定商品设置秒杀价与活动库存。' +
    '入参：name(活动名)、productId(商品SPU ID)、skuId(SKU ID)、flashPrice(秒杀价)、' +
    'originalPrice(原价)、totalStock(活动库存)、startTime/endTime(活动时间)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '秒杀活动名称（必填）' },
      productId: { type: 'number', description: '商品SPU ID（必填）' },
      skuId: { type: 'number', description: 'SKU ID（必填）' },
      flashPrice: { type: 'number', description: '秒杀价（必填，>=0）' },
      originalPrice: { type: 'number', description: '原价（必填，>=0）' },
      totalStock: { type: 'number', description: '活动库存（必填，>=0）' },
      limitPerUser: { type: 'number', description: '每人限购（默认 1）' },
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
      'flashPrice',
      'originalPrice',
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
      const discount =
        a.originalPrice > 0
          ? Math.round((a.flashPrice / a.originalPrice) * 10)
          : 0;
      return {
        success: true,
        preview: {
          operation: '创建秒杀活动',
          summary:
            `新建秒杀「${a.name}」：${a.flashPrice}元（原价 ${a.originalPrice}元，` +
            `${discount}折），库存 ${a.totalStock}，` +
            `时间 ${a.startTime} ~ ${a.endTime}`,
          details: {
            name: a.name,
            productId: a.productId,
            skuId: a.skuId,
            flashPrice: a.flashPrice,
            originalPrice: a.originalPrice,
            totalStock: a.totalStock,
            limitPerUser: a.limitPerUser,
            startTime: a.startTime,
            endTime: a.endTime,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MARKETING_FLASH_SALES,
        {
          name: a.name,
          productId: a.productId,
          skuId: a.skuId,
          flashPrice: a.flashPrice,
          originalPrice: a.originalPrice,
          totalStock: a.totalStock,
          limitPerUser: a.limitPerUser,
          startTime: a.startTime,
          endTime: a.endTime,
        },
        context,
      );
      this.logger.log(`创建秒杀活动成功：${a.name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建秒杀活动失败：${msg}`);
      return {
        success: false,
        error: `创建秒杀活动失败：${msg}`,
        suggestion: '请确认商品/库存信息与时间格式后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateFlashSaleArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 name 必填',
        suggestion: '请提供秒杀活动名称',
      };
    }
    const productId = Number(args.productId);
    const skuId = Number(args.skuId);
    if (!Number.isInteger(productId) || productId <= 0) {
      return {
        valid: false,
        error: '参数 productId 必须为正整数',
        suggestion: '请提供商品SPU ID',
      };
    }
    if (!Number.isInteger(skuId) || skuId <= 0) {
      return {
        valid: false,
        error: '参数 skuId 必须为正整数',
        suggestion: '请提供SKU ID',
      };
    }
    const flashPrice = Number(args.flashPrice);
    const originalPrice = Number(args.originalPrice);
    if (!Number.isFinite(flashPrice) || flashPrice < 0) {
      return {
        valid: false,
        error: '参数 flashPrice 必须为不小于 0 的数字',
        suggestion: '请检查秒杀价',
      };
    }
    if (!Number.isFinite(originalPrice) || originalPrice < 0) {
      return {
        valid: false,
        error: '参数 originalPrice 必须为不小于 0 的数字',
        suggestion: '请检查原价',
      };
    }
    const totalStock = Number(args.totalStock);
    if (!Number.isInteger(totalStock) || totalStock < 0) {
      return {
        valid: false,
        error: '参数 totalStock 必须为不小于 0 的整数',
        suggestion: '请检查活动库存',
      };
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
    return {
      valid: true,
      data: {
        name: name.trim(),
        productId,
        skuId,
        flashPrice,
        originalPrice,
        totalStock,
        limitPerUser:
          args.limitPerUser === undefined ? 1 : Number(args.limitPerUser),
        startTime,
        endTime,
        confirm: args.confirm === true,
      },
    };
  }
}
