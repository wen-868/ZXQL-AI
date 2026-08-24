/**
 * createCustomer 工具 — 创建客户（写操作，含预览机制）
 *
 * 用途：创建新客户（会员），录入名称/电话/客户类型/地址/结算方式/备注。
 * 这是写操作，必须先生成预览卡片，等待用户确认后真正执行。
 *
 * 对应后端 API：POST /api/admin/members
 * 后端路由：admin-customer.routes.ts（prefix: /api/admin，createCustomer）
 * 后端服务：customer.service.ts createCustomer（INSERT t_member，自动计算客户等级）
 *
 * 后端接收字段（以 customer.service.ts createCustomer 为准）：
 * - name: string（必填）
 * - mobile: string（可选，默认空串）
 * - customerType: string（可选，CASH=散客/WHOLESALE=批发/VIP=VIP客户，用于计算客户等级）
 * - staffId?: number（可选，所属业务员，本工具不提供）
 * - address?: string（可选）
 * - settlementType?: string（可选，默认 CASH；批发客户建议 ACCOUNT 账期）
 * - remark?: string（可选）
 * 返回：{ memberId, name, mobile, customerType, staffId, address, settlementType, remark }
 *
 * 注意：creditLimit（信用额度）后端 createCustomer 接口暂不支持自动写入，
 * 即使传入也不会落库（body 中被忽略）。本工具接收该参数仅用于预览提示，
 * 真正设置信用额度需在创建后到客户管理页人工配置。
 *
 * 确认机制（R70-15 完整实现，当前简化版，与 createSalesOrder/inventoryTransfer 一致）：
 * - 预览阶段（confirm=false）：返回 ToolResult.preview，不调用后端
 * - 执行阶段（confirm=true）：调用 POST /api/admin/members 创建客户
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import {
  ServiceClient,
  API_ENDPOINTS,
  BridgeError,
} from '../../bridge/service-client';

/** 合法客户类型（与 searchCustomer 的 translateCustomerType 映射一致） */
const CUSTOMER_TYPES = ['CASH', 'WHOLESALE', 'VIP'] as const;

type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** 客户类型中文标签 */
const CUSTOMER_TYPE_LABELS: Record<CustomerType, string> = {
  CASH: '散客（零售）',
  WHOLESALE: '批发客户',
  VIP: 'VIP客户',
};

/** 合法结算方式 */
const SETTLEMENT_TYPES = ['CASH', 'ACCOUNT'] as const;

/** 结算方式中文标签 */
const SETTLEMENT_TYPE_LABELS: Record<string, string> = {
  CASH: '现金结算',
  ACCOUNT: '账期结算',
};

/** 后端创建客户返回 */
interface CreateCustomerResult {
  memberId: number;
  name: string;
  mobile: string;
  customerType: string;
  staffId: number | null;
  address: string | null;
  settlementType: string;
  remark: string | null;
}

/** 后端客户列表项（查重用） */
interface CustomerListItem {
  memberId: number;
  name: string;
  mobile?: string;
  customerType?: string;
}

@Injectable()
export class CreateCustomerTool implements ITool {
  private readonly logger = new Logger(CreateCustomerTool.name);

  readonly name = 'createCustomer';
  readonly description =
    '创建客户（写操作，需用户确认）：新建客户（会员），可录入名称、电话、客户类型、地址、结算方式、备注。' +
    '首次调用 confirm=false 生成预览（含客户名称、电话、类型、地址、结算方式），' +
    '用户确认后 confirm=true 正式创建客户。' +
    '注意：信用额度（creditLimit）后端暂不支持自动写入，创建后需到客户管理页人工设置。' +
    '示例参数：{"name":"兴旺超市","phone":"13800000000","customerType":"WHOLESALE","settlementType":"ACCOUNT","address":"解放路88号","remark":"周结客户","confirm":false}';
  readonly category = 'customer' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      name: {
        type: 'string',
        description: '客户名称（必填，非空字符串）',
      },
      phone: {
        type: 'string',
        description: '联系电话/手机号（必填，t_member 唯一键约束）',
      },
      customerType: {
        type: 'string',
        enum: [...CUSTOMER_TYPES],
        description:
          '客户类型（可选，默认 CASH）：CASH=散客（零售）、WHOLESALE=批发客户、VIP=VIP客户',
      },
      address: {
        type: 'string',
        description: '地址（可选）',
      },
      settlementType: {
        type: 'string',
        enum: [...SETTLEMENT_TYPES],
        description:
          '结算方式（可选，默认 CASH）：CASH=现金结算、ACCOUNT=账期结算（批发客户建议 ACCOUNT）',
      },
      creditLimit: {
        type: 'number',
        description:
          '信用额度（可选，仅用于预览提示。后端 createCustomer 暂不支持自动写入，创建后需在客户管理页人工设置）',
      },
      remark: {
        type: 'string',
        description: '备注（可选）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=生成预览，true=正式创建。默认false）',
      },
    },
    required: ['name'],
  };

  constructor(private readonly serviceClient: ServiceClient) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // ── 1. 参数校验 ──
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }

    const customerArgs = parsed.data;
    const confirm = customerArgs.confirm === true;
    const customerTypeLabel = CUSTOMER_TYPE_LABELS[customerArgs.customerType];
    const settlementTypeLabel =
      SETTLEMENT_TYPE_LABELS[customerArgs.settlementType] ??
      customerArgs.settlementType;

    // ── 2. 预览阶段 ──
    if (!confirm) {
      const details: Record<string, unknown> = {
        name: customerArgs.name,
        phone: customerArgs.phone ?? null,
        customerType: customerArgs.customerType,
        customerTypeLabel,
        address: customerArgs.address ?? null,
        settlementType: customerArgs.settlementType,
        settlementTypeLabel,
        remark: customerArgs.remark ?? null,
        // 信用额度后端暂不支持自动写入，仅预览提示
        creditLimit: customerArgs.creditLimit ?? null,
        creditLimitNote:
          customerArgs.creditLimit !== undefined
            ? '信用额度暂不支持通过AI创建时自动写入，创建后请到客户管理页人工设置'
            : undefined,
      };

      this.logger.log(
        `生成创建客户预览：${customerArgs.name}（${customerTypeLabel}）`,
      );

      return {
        success: true,
        preview: {
          operation: '创建客户',
          summary:
            `新建客户「${customerArgs.name}」` +
            (customerArgs.phone ? `（电话 ${customerArgs.phone}）` : '') +
            `，类型：${customerTypeLabel}` +
            (customerArgs.creditLimit !== undefined
              ? '（信用额度需创建后人工设置）'
              : ''),
          details,
        },
      };
    }

    // ── 3. 执行阶段：调用后端创建客户 ──
    try {
      // ── 查重：同租户已存在同名客户则不重复创建，直接复用 ──
      const existed = await this.findExistingCustomer(
        customerArgs.name,
        context,
      );
      if (existed) {
        this.logger.log(
          `客户「${customerArgs.name}」已存在（memberId=${existed.memberId}），跳过创建`,
        );
        return {
          success: true,
          data: {
            memberId: existed.memberId,
            name: existed.name,
            mobile: existed.mobile ?? '',
            customerType: existed.customerType ?? 'CASH',
            customerTypeLabel:
              CUSTOMER_TYPE_LABELS[
                (existed.customerType ?? 'CASH') as CustomerType
              ] ?? existed.customerType,
            duplicate: true,
            message: `客户「${existed.name}」已存在（客户ID=${existed.memberId}），已直接复用，未重复创建`,
          },
        };
      }

      // t_member.mobile 必填且有全局唯一键：未提供手机号时不伪造，明确要求用户补充（真实商用，不造假数据）
      if (!customerArgs.phone || !customerArgs.phone.trim()) {
        return {
          success: false,
          error: '创建客户必须提供手机号',
          suggestion: '请向用户确认客户手机号后再创建客户',
        };
      }
      const mobile = customerArgs.phone.trim();

      // 对齐后端 createCustomer 支持字段（creditLimit 后端不支持，不发送）
      const requestBody = {
        name: customerArgs.name,
        mobile,
        customerType: customerArgs.customerType,
        address: customerArgs.address ?? undefined,
        settlementType: customerArgs.settlementType,
        remark: customerArgs.remark ?? undefined,
      };

      const result = await this.serviceClient.post<CreateCustomerResult>(
        API_ENDPOINTS.CUSTOMERS,
        requestBody,
        context,
      );

      this.logger.log(
        `创建客户成功：memberId=${result.memberId} name=${result.name}`,
      );

      return {
        success: true,
        data: {
          memberId: result.memberId,
          name: result.name,
          mobile: result.mobile,
          customerType: result.customerType,
          customerTypeLabel:
            CUSTOMER_TYPE_LABELS[result.customerType as CustomerType] ??
            result.customerType,
          address: result.address,
          settlementType: result.settlementType,
          remark: result.remark,
          message: `客户「${result.name}」创建成功，客户ID=${result.memberId}`,
          note:
            customerArgs.creditLimit !== undefined
              ? '信用额度已提示但未写入，请到客户管理页人工设置'
              : undefined,
        },
      };
    } catch (err) {
      const errorMsg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);

      this.logger.error(`创建客户失败：${errorMsg}`);
      return {
        success: false,
        error: `创建客户失败：${errorMsg}`,
        suggestion:
          '请确认后端服务是否正常运行，客户名称不能为空，客户类型必须是 CASH/WHOLESALE/VIP',
      };
    }
  }

  // ── 私有方法 ──

  /** 按名称查重（精确匹配，防止重复创建客户） */
  private async findExistingCustomer(
    name: string,
    context: ToolContext,
  ): Promise<CustomerListItem | undefined> {
    const result = await this.serviceClient.get<{
      records?: CustomerListItem[];
      list?: CustomerListItem[];
    }>(
      `${API_ENDPOINTS.CUSTOMERS}?keyword=${encodeURIComponent(name)}&page=1&pageSize=10`,
      context,
    );
    const customers = result?.records ?? result?.list ?? [];
    return customers.find((c) => c.name === name);
  }

  /** 解析并校验参数 */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateCustomerArgs }
    | { valid: false; error: string; suggestion?: string } {
    const name = args.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
      return {
        valid: false,
        error: '参数 name 必须为非空字符串',
        suggestion: '请输入客户名称',
      };
    }

    let customerType: CustomerType = 'CASH';
    if (args.customerType !== undefined) {
      if (
        typeof args.customerType !== 'string' ||
        !(CUSTOMER_TYPES as readonly string[]).includes(args.customerType)
      ) {
        return {
          valid: false,
          error: `参数 customerType 必须是 ${CUSTOMER_TYPES.join(' / ')} 之一`,
          suggestion: '请确认客户类型（CASH=散客/WHOLESALE=批发/VIP=VIP客户）',
        };
      }
      customerType = args.customerType as CustomerType;
    }

    let settlementType = 'CASH';
    if (args.settlementType !== undefined) {
      if (
        typeof args.settlementType !== 'string' ||
        !(SETTLEMENT_TYPES as readonly string[]).includes(args.settlementType)
      ) {
        return {
          valid: false,
          error: `参数 settlementType 必须是 ${SETTLEMENT_TYPES.join(' / ')} 之一`,
          suggestion: '请确认结算方式（CASH=现金结算/ACCOUNT=账期结算）',
        };
      }
      settlementType = args.settlementType;
    }

    let creditLimit: number | undefined;
    if (args.creditLimit !== undefined) {
      if (typeof args.creditLimit !== 'number' || args.creditLimit < 0) {
        return {
          valid: false,
          error: '参数 creditLimit 必须为不小于 0 的数字',
          suggestion: '请输入合法的信用额度（不小于 0）',
        };
      }
      creditLimit = args.creditLimit;
    }

    return {
      valid: true,
      data: {
        name: name.trim(),
        phone: typeof args.phone === 'string' ? args.phone : undefined,
        customerType,
        address: typeof args.address === 'string' ? args.address : undefined,
        settlementType,
        creditLimit,
        remark: typeof args.remark === 'string' ? args.remark : undefined,
        confirm: typeof args.confirm === 'boolean' ? args.confirm : false,
      },
    };
  }
}

/** 创建客户参数（解析后） */
interface CreateCustomerArgs {
  name: string;
  phone?: string;
  customerType: CustomerType;
  address?: string;
  settlementType: string;
  creditLimit?: number;
  remark?: string;
  confirm: boolean;
}
