/**
 * api_create_coupon_template 工具 — 创建优惠券模板（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/marketing/coupons/templates
 * 后端路由：admin-marketing-coupon.routes.ts（prefix: /api/admin/marketing）
 * 后端校验（marketing-coupon.controller.ts createCouponTemplate zod schema）：
 * - name: string(1-128) 必填
 * - type: FIXED|PERCENT|SHIPPING|FREE_GIFT 必填
 * - value: number>=0 必填
 * - minAmount: number>=0 默认 0
 * - maxDiscount: number>=0 可空
 * - applicableScope: ALL|CATEGORY|BRAND|SKU 默认 ALL
 * - applicableIds: number[] 可空
 * - totalCount: int>=0 默认 0（0 表示不限量）
 * - startTime / endTime: string 必填
 * - description: string max512 默认 ""
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

/** 创建优惠券模板入参（与后端 zod schema 对齐） */
interface CreateCouponArgs {
  name: string;
  type: string;
  value: number;
  minAmount?: number;
  maxDiscount?: number | null;
  applicableScope?: string;
  applicableIds?: number[] | null;
  totalCount?: number;
  startTime: string;
  endTime: string;
  description?: string;
  confirm?: boolean;
}

/** 创建结果 */
interface CreateCouponResult {
  id?: number;
  templateId?: number;
  name?: string;
  [key: string]: unknown;
}

@Injectable()
export class CreateCouponTemplateTool implements ITool {
  private readonly logger = new Logger(CreateCouponTemplateTool.name);

  readonly name = 'api_create_coupon_template';
  readonly description =
    '创建优惠券模板（写操作，需用户确认）：支持固定金额/折扣/免邮/赠品四类。' +
    '入参：name(名称)、type(FIXED固定金额/PERCENT折扣/SHIPPING免邮/FREE_GIFT赠品)、' +
    'value(面值/折扣比例)、minAmount(满减门槛,可选)、startTime/endTime(生效时间)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'marketing' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: '优惠券名称（必填，1-128字）' },
      type: {
        type: 'string',
        enum: ['FIXED', 'PERCENT', 'SHIPPING', 'FREE_GIFT'],
        description: '优惠券类型（必填）',
      },
      value: {
        type: 'number',
        description: '面值（固定金额元）或折扣比例（PERCENT时如 8 折=20）',
      },
      minAmount: {
        type: 'number',
        description: '满减门槛金额（可选，默认 0）',
      },
      maxDiscount: {
        type: 'number',
        description: '最大优惠金额（可选，PERCENT 类限额）',
      },
      applicableScope: {
        type: 'string',
        enum: ['ALL', 'CATEGORY', 'BRAND', 'SKU'],
        description: '适用范围（默认 ALL）',
      },
      applicableIds: {
        type: 'array',
        items: { type: 'number' },
        description: '适用对象ID列表（scope 为 CATEGORY/BRAND/SKU 时必填）',
      },
      totalCount: {
        type: 'number',
        description: '发行总量（可选，0=不限量）',
      },
      startTime: {
        type: 'string',
        description: '生效时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      endTime: {
        type: 'string',
        description: '失效时间（必填，YYYY-MM-DD HH:mm:ss）',
      },
      description: { type: 'string', description: '活动说明（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['name', 'type', 'value', 'startTime', 'endTime'],
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

    // ── 预览阶段 ──
    if (a.confirm !== true) {
      const typeLabel = this.typeLabel(a.type);
      return {
        success: true,
        preview: {
          operation: '创建优惠券模板',
          summary:
            `新建${typeLabel}「${a.name}」` +
            `（面值 ${a.value}${a.type === 'PERCENT' ? '%' : '元'}，` +
            `有效期 ${a.startTime} ~ ${a.endTime}）`,
          details: {
            name: a.name,
            type: a.type,
            value: a.value,
            minAmount: a.minAmount ?? 0,
            applicableScope: a.applicableScope ?? 'ALL',
            totalCount: a.totalCount ?? 0,
            startTime: a.startTime,
            endTime: a.endTime,
            description: a.description ?? '',
          },
        },
      };
    }

    // ── 执行阶段 ──
    try {
      const result = await this.serviceClient.post<CreateCouponResult>(
        API_ENDPOINTS.MARKETING_COUPONS,
        {
          name: a.name,
          type: a.type,
          value: a.value,
          minAmount: a.minAmount ?? 0,
          maxDiscount: a.maxDiscount ?? null,
          applicableScope: a.applicableScope ?? 'ALL',
          applicableIds: a.applicableIds ?? null,
          totalCount: a.totalCount ?? 0,
          startTime: a.startTime,
          endTime: a.endTime,
          description: a.description ?? '',
        },
        context,
      );
      this.logger.log(`创建优惠券模板成功：${a.name}`);
      return {
        success: true,
        data: result,
      };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建优惠券模板失败：${msg}`);
      return {
        success: false,
        error: `创建优惠券模板失败：${msg}`,
        suggestion: '请检查参数（类型/面值/时间格式）后重试',
      };
    }
  }

  /** 参数校验与归一化 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateCouponArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      name.length > 128
    ) {
      return {
        valid: false,
        error: '参数 name 必须为 1-128 字字符串',
        suggestion: '请提供优惠券名称',
      };
    }
    const type = args.type;
    const TYPES = ['FIXED', 'PERCENT', 'SHIPPING', 'FREE_GIFT'];
    if (typeof type !== 'string' || !TYPES.includes(type)) {
      return {
        valid: false,
        error: '参数 type 必须为 FIXED/PERCENT/SHIPPING/FREE_GIFT',
        suggestion: '请检查优惠券类型',
      };
    }
    const value = Number(args.value);
    if (!Number.isFinite(value) || value < 0) {
      return {
        valid: false,
        error: '参数 value 必须为不小于 0 的数字',
        suggestion: '请检查面值',
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
        error: '参数 startTime/endTime 必须为时间字符串',
        suggestion: '格式如 2026-09-01 00:00:00',
      };
    }
    const minAmount = args.minAmount === undefined ? 0 : Number(args.minAmount);
    if (!Number.isFinite(minAmount) || minAmount < 0) {
      return {
        valid: false,
        error: '参数 minAmount 必须为不小于 0 的数字',
        suggestion: '请检查门槛金额',
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
        type,
        value,
        minAmount,
        maxDiscount:
          args.maxDiscount === null || args.maxDiscount === undefined
            ? null
            : Number(args.maxDiscount),
        applicableScope: scope === undefined ? 'ALL' : scope,
        applicableIds: Array.isArray(args.applicableIds)
          ? args.applicableIds.map(Number)
          : null,
        totalCount: args.totalCount === undefined ? 0 : Number(args.totalCount),
        startTime,
        endTime,
        description:
          typeof args.description === 'string' ? args.description : '',
        confirm: args.confirm === true,
      },
    };
  }

  private typeLabel(type: string): string {
    switch (type) {
      case 'FIXED':
        return '满减券';
      case 'PERCENT':
        return '折扣券';
      case 'SHIPPING':
        return '免邮券';
      case 'FREE_GIFT':
        return '赠品券';
      default:
        return '优惠券';
    }
  }
}
