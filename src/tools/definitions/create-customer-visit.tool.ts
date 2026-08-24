/**
 * api_create_customer_visit 工具 — 创建客户拜访（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/customer-visits
 * 后端校验（customer-visit.service.ts createVisitSchema，字段 snake_case）：
 * - customer_id、customer_name、store_id、visit_date 必填
 * - visit_type(ONSITE/PHONE/ONLINE)、visit_purpose(ROUTINE/ORDER/COLLECTION/COMPLAINT/PROMOTION/AFTER_SALE)
 * - customer_mobile、start_time、end_time、address、contact_person、visit_summary 等可选
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

interface CreateVisitArgs {
  customer_id: number;
  customer_name: string;
  customer_mobile?: string;
  store_id: number;
  visit_type: string;
  visit_purpose: string;
  visit_date: string;
  start_time?: string;
  end_time?: string;
  address?: string;
  contact_person?: string;
  contact_mobile?: string;
  visit_summary?: string;
  follow_up_required: number;
  confirm?: boolean;
}

@Injectable()
export class CreateCustomerVisitTool implements ITool {
  private readonly logger = new Logger(CreateCustomerVisitTool.name);

  readonly name = 'api_create_customer_visit';
  readonly description =
    '创建客户拜访记录（写操作，需用户确认）：登记上门/电话/线上拜访。' +
    '入参：customerId、customerName、storeId、visitDate(拜访日期)、' +
    'visitType(ONSITE上门/PHONE电话/ONLINE线上,可选)、visitPurpose(拜访目的,可选)、' +
    'address(地址,可选)、visitSummary(拜访小结,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      customerId: { type: 'number', description: '客户ID（必填）' },
      customerName: { type: 'string', description: '客户名称（必填）' },
      storeId: { type: 'number', description: '所属门店ID（必填）' },
      visitDate: {
        type: 'string',
        description: '拜访日期（必填，YYYY-MM-DD）',
      },
      visitType: {
        type: 'string',
        enum: ['ONSITE', 'PHONE', 'ONLINE'],
        description: '拜访方式（默认 ONSITE）',
      },
      visitPurpose: {
        type: 'string',
        enum: [
          'ROUTINE',
          'ORDER',
          'COLLECTION',
          'COMPLAINT',
          'PROMOTION',
          'AFTER_SALE',
        ],
        description: '拜访目的（默认 ROUTINE）',
      },
      customerMobile: { type: 'string', description: '客户手机（可选）' },
      address: { type: 'string', description: '拜访地址（可选）' },
      contactPerson: { type: 'string', description: '联系人（可选）' },
      visitSummary: { type: 'string', description: '拜访小结（可选）' },
      followUpRequired: { type: 'boolean', description: '是否需跟进（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['customerId', 'customerName', 'storeId', 'visitDate'],
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
          operation: '创建客户拜访',
          summary:
            `拜访${a.customer_name}（${this.visitTypeLabel(a.visit_type)}），` +
            `${a.visit_date}${a.visit_summary ? `：${a.visit_summary}` : ''}`,
          details: {
            customerId: a.customer_id,
            customerName: a.customer_name,
            storeId: a.store_id,
            visitType: a.visit_type,
            visitPurpose: a.visit_purpose,
            visitDate: a.visit_date,
            address: a.address ?? '',
            visitSummary: a.visit_summary ?? '',
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.CUSTOMER_VISITS,
        {
          customer_id: a.customer_id,
          customer_name: a.customer_name,
          customer_mobile: a.customer_mobile ?? null,
          store_id: a.store_id,
          visit_type: a.visit_type,
          visit_purpose: a.visit_purpose,
          visit_date: a.visit_date,
          start_time: a.start_time ?? null,
          end_time: a.end_time ?? null,
          address: a.address ?? null,
          contact_person: a.contact_person ?? null,
          contact_mobile: a.contact_mobile ?? null,
          visit_summary: a.visit_summary ?? null,
          follow_up_required: a.follow_up_required,
        },
        context,
      );
      this.logger.log(`创建客户拜访成功：${a.customer_name}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建客户拜访失败：${msg}`);
      return {
        success: false,
        error: `创建客户拜访失败：${msg}`,
        suggestion: '请确认客户与门店信息后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateVisitArgs }
    | { valid: false; error: string; suggestion?: string } {
    const customer_id = Number(args.customerId);
    const store_id = Number(args.storeId);
    if (!Number.isInteger(customer_id) || customer_id <= 0)
      return {
        valid: false,
        error: '参数 customerId 必须为正整数',
        suggestion: '请提供客户ID',
      };
    if (!Number.isInteger(store_id) || store_id <= 0)
      return {
        valid: false,
        error: '参数 storeId 必须为正整数',
        suggestion: '请提供门店ID',
      };
    const customer_name = args.customerName;
    if (typeof customer_name !== 'string' || customer_name.trim().length === 0)
      return {
        valid: false,
        error: '参数 customerName 必填',
        suggestion: '请提供客户名称',
      };
    const visit_date = args.visitDate;
    if (typeof visit_date !== 'string' || visit_date.length === 0)
      return {
        valid: false,
        error: '参数 visitDate 必填',
        suggestion: '格式如 2026-08-16',
      };
    const visit_type = args.visitType;
    if (
      visit_type !== undefined &&
      visit_type !== 'ONSITE' &&
      visit_type !== 'PHONE' &&
      visit_type !== 'ONLINE'
    ) {
      return {
        valid: false,
        error: '参数 visitType 必须为 ONSITE/PHONE/ONLINE',
        suggestion: '请检查拜访方式',
      };
    }
    const visit_purpose = args.visitPurpose;
    const PURPOSES = [
      'ROUTINE',
      'ORDER',
      'COLLECTION',
      'COMPLAINT',
      'PROMOTION',
      'AFTER_SALE',
    ];
    if (
      visit_purpose !== undefined &&
      (typeof visit_purpose !== 'string' || !PURPOSES.includes(visit_purpose))
    ) {
      return {
        valid: false,
        error: '参数 visitPurpose 不在允许枚举内',
        suggestion: '请检查拜访目的',
      };
    }
    return {
      valid: true,
      data: {
        customer_id,
        customer_name: customer_name.trim(),
        customer_mobile:
          typeof args.customerMobile === 'string'
            ? args.customerMobile
            : undefined,
        store_id,
        visit_type: visit_type === undefined ? 'ONSITE' : visit_type,
        visit_purpose: visit_purpose === undefined ? 'ROUTINE' : visit_purpose,
        visit_date,
        start_time:
          typeof args.startTime === 'string' ? args.startTime : undefined,
        end_time: typeof args.endTime === 'string' ? args.endTime : undefined,
        address: typeof args.address === 'string' ? args.address : undefined,
        contact_person:
          typeof args.contactPerson === 'string'
            ? args.contactPerson
            : undefined,
        contact_mobile:
          typeof args.contactMobile === 'string'
            ? args.contactMobile
            : undefined,
        visit_summary:
          typeof args.visitSummary === 'string' ? args.visitSummary : undefined,
        follow_up_required: args.followUpRequired === true ? 1 : 0,
        confirm: args.confirm === true,
      },
    };
  }

  private visitTypeLabel(type: string): string {
    switch (type) {
      case 'ONSITE':
        return '上门';
      case 'PHONE':
        return '电话';
      case 'ONLINE':
        return '线上';
      default:
        return '拜访';
    }
  }
}
