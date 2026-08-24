/**
 * api_create_limited_discount 工具 — 创建限量折扣活动（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/limited-discounts
 * 后端校验（marketing-limited-discount.controller.ts createLimitedDiscountSchema）：
 * - name(1-200)、discountType(PERCENTAGE|FIXED)、discountValue(>0)
 * - startTime、endTime、limitPerUser?、totalLimit?、status(DRAFT|ACTIVE|PAUSED 默认 DRAFT)
 * - description?(max2000)、applicableScope(ALL|SPECIFIC 默认 ALL)
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

interface CreateLimitedDiscountArgs {
  name: string;
  discountType: string;
  discountValue: number;
  startTime: string;
  endTime: string;
  limitPerUser?: number;
  totalLimit?: number;
  status: string;
  description?: string;
  applicableScope: string;
  confirm?: boolean;
}

@Injectable()
export class CreateLimitedDiscountTool implements ITool {
  private readonly logger = new Logger(CreateLimitedDiscountTool.name);

  readonly name = 'api_create_limited_discount';
  readonly description =
    '创建限量折扣活动（写操作，需用户确认）：指定商品限量折扣。' +
    '入参：name(活动名)、discountType(PERCENTAGE百分比/FIXED固定金额)、discountValue(折扣值)、' +
    'startTime/endTime(活动时间)、limitPerUser(每人限购,可选)、totalLimit(总限量,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '活动名称（必填）' },
      discountType: {
        type: 'string',
        enum: ['PERCENTAGE', 'FIXED'],
        description: '折扣类型（必填）：PERCENTAGE百分比/FIXED固定金额',
      },
      discountValue: {
        type: 'number',
        description:
          '折扣值（必填）：百分比时如 20 表示8折，固定金额时如 50 表示减50元',
      },
      startTime: {
        type: 'string',
        description: '开始时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'string',
        description: '结束时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      limitPerUser: { type: 'number', description: '每人限购（可选）' },
      totalLimit: { type: 'number', description: '总限量（可选）' },
      description: { type: 'string', description: '活动说明（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['name', 'discountType', 'discountValue', 'startTime', 'endTime'],
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
    const discountText =
      a.discountType === 'PERCENTAGE'
        ? `${(10 - a.discountValue / 10).toFixed(1)}折`
        : `减${a.discountValue}元`;

    if (a.confirm !== true) {
      return {
        success: true,
        preview: {
          operation: '创建限量折扣活动',
          summary: `新建限量折扣「${a.name}」：${discountText}，有效期 ${a.startTime} ~ ${a.endTime}`,
          details: {
            name: a.name,
            discountType: a.discountType,
            discountValue: a.discountValue,
            limitPerUser: a.limitPerUser ?? 0,
            totalLimit: a.totalLimit ?? 0,
            startTime: a.startTime,
            endTime: a.endTime,
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.MARKETING_LIMITED_DISCOUNTS,
        {
          name: a.name,
          discountType: a.discountType,
          discountValue: a.discountValue,
          startTime: a.startTime,
          endTime: a.endTime,
          limitPerUser: a.limitPerUser,
          totalLimit: a.totalLimit,
          status: a.status,
          description: a.description ?? '',
          applicableScope: a.applicableScope,
        },
        context,
      );
      this.logger.log(`创建限量折扣活动成功：${a.name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建限量折扣活动失败：${msg}`);
      return {
        success: false,
        error: `创建限量折扣活动失败：${msg}`,
        suggestion: '请检查折扣类型/值与时间格式后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateLimitedDiscountArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0)
      return {
        valid: false,
        error: '参数 name 必填',
        suggestion: '请提供活动名称',
      };
    const discountType = args.discountType;
    if (discountType !== 'PERCENTAGE' && discountType !== 'FIXED')
      return {
        valid: false,
        error: '参数 discountType 必须为 PERCENTAGE/FIXED',
        suggestion: '请选择折扣类型',
      };
    const discountValue = Number(args.discountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0)
      return {
        valid: false,
        error: '参数 discountValue 必须为大于 0 的数字',
        suggestion: '请检查折扣值',
      };
    if (
      discountType === 'PERCENTAGE' &&
      (discountValue < 0 || discountValue > 100)
    )
      return {
        valid: false,
        error: 'PERCENTAGE 类型 discountValue 必须在 0-100 之间',
        suggestion: '请检查折扣百分比',
      };
    const startTime = args.startTime;
    const endTime = args.endTime;
    if (
      typeof startTime !== 'string' ||
      typeof endTime !== 'string' ||
      !startTime ||
      !endTime
    )
      return {
        valid: false,
        error: '参数 startTime/endTime 必填',
        suggestion: '格式如 2026-09-01 00:00:00',
      };
    return {
      valid: true,
      data: {
        name: name.trim(),
        discountType,
        discountValue,
        startTime,
        endTime,
        limitPerUser:
          args.limitPerUser === undefined
            ? undefined
            : Number(args.limitPerUser),
        totalLimit:
          args.totalLimit === undefined ? undefined : Number(args.totalLimit),
        status: 'DRAFT',
        description:
          typeof args.description === 'string' ? args.description : undefined,
        applicableScope: 'ALL',
        confirm: args.confirm === true,
      },
    };
  }
}
