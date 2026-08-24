/**
 * api_create_purchase_payment 工具 — 创建采购付款单（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/purchase-payments
 * 后端服务：purchase-payment.service.ts create（字段 snake_case，状态 PENDING 待审批）
 * 入参：supplierId、supplierName、amount、paymentDate、paymentMethod(BANK/CASH...)、
 *       sourceType/sourceNo(关联采购单,可选)、bankAccount/voucherNo(可选)、remark(可选)
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

interface CreatePaymentArgs {
  supplier_id: number;
  supplier_name: string;
  payment_type: string;
  source_type?: string;
  source_no?: string;
  amount: number;
  payment_method: string;
  bank_account?: string;
  bank_account_name?: string;
  bank_name?: string;
  voucher_no?: string;
  payment_date: string;
  remark?: string;
  confirm?: boolean;
}

@Injectable()
export class CreatePurchasePaymentTool implements ITool {
  private readonly logger = new Logger(CreatePurchasePaymentTool.name);

  readonly name = 'api_create_purchase_payment';
  readonly description =
    '创建采购付款单（写操作，需用户确认）：向供应商付款，生成 PENDING 待审批付款单。' +
    '入参：supplierId、supplierName、amount(付款金额)、paymentDate(付款日期)、' +
    'paymentMethod(BANK/CASH等,可选)、sourceNo(关联采购单,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: { type: 'number', description: '供应商ID（必填）' },
      supplierName: { type: 'string', description: '供应商名称（必填）' },
      amount: { type: 'number', description: '付款金额（必填，>0）' },
      paymentDate: {
        type: 'string',
        description: '付款日期（必填，YYYY-MM-DD）',
      },
      paymentMethod: {
        type: 'string',
        description: '付款方式（可选，默认 BANK：BANK/CASH/TRANSFER）',
      },
      sourceNo: { type: 'string', description: '关联采购单号（可选）' },
      bankAccount: { type: 'string', description: '银行账号（可选）' },
      voucherNo: { type: 'string', description: '凭证号（可选）' },
      remark: { type: 'string', description: '备注（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['supplierId', 'supplierName', 'amount', 'paymentDate'],
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
          operation: '创建采购付款单',
          summary: `向${a.supplier_name}付款 ${a.amount} 元（${a.payment_date}）`,
          details: {
            supplierId: a.supplier_id,
            supplierName: a.supplier_name,
            amount: a.amount,
            paymentDate: a.payment_date,
            paymentMethod: a.payment_method,
            sourceNo: a.source_no ?? '',
            remark: a.remark ?? '',
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.PURCHASE_PAYMENTS,
        {
          supplier_id: a.supplier_id,
          supplier_name: a.supplier_name,
          payment_type: a.payment_type,
          source_type: a.source_type ?? null,
          source_no: a.source_no ?? null,
          amount: a.amount,
          payment_method: a.payment_method,
          bank_account: a.bank_account ?? null,
          bank_account_name: a.bank_account_name ?? null,
          bank_name: a.bank_name ?? null,
          voucher_no: a.voucher_no ?? null,
          payment_date: a.payment_date,
          remark: a.remark ?? null,
        },
        context,
      );
      this.logger.log(`创建采购付款单成功：${a.supplier_name} ${a.amount}元`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建采购付款单失败：${msg}`);
      return {
        success: false,
        error: `创建采购付款单失败：${msg}`,
        suggestion: '请确认供应商与金额后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreatePaymentArgs }
    | { valid: false; error: string; suggestion?: string } {
    const supplier_id = Number(args.supplierId);
    if (!Number.isInteger(supplier_id) || supplier_id <= 0) {
      return {
        valid: false,
        error: '参数 supplierId 必须为正整数',
        suggestion: '请提供供应商ID',
      };
    }
    const supplier_name = args.supplierName;
    if (
      typeof supplier_name !== 'string' ||
      supplier_name.trim().length === 0
    ) {
      return {
        valid: false,
        error: '参数 supplierName 必填',
        suggestion: '请提供供应商名称',
      };
    }
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        valid: false,
        error: '参数 amount 必须为大于 0 的数字',
        suggestion: '请检查付款金额',
      };
    }
    const payment_date = args.paymentDate;
    if (typeof payment_date !== 'string' || payment_date.length === 0) {
      return {
        valid: false,
        error: '参数 paymentDate 必填',
        suggestion: '格式如 2026-08-16',
      };
    }
    return {
      valid: true,
      data: {
        supplier_id,
        supplier_name: supplier_name.trim(),
        payment_type: 'ORDER',
        source_type:
          typeof args.sourceType === 'string' && args.sourceType
            ? args.sourceType
            : undefined,
        source_no:
          typeof args.sourceNo === 'string' && args.sourceNo
            ? args.sourceNo
            : undefined,
        amount,
        payment_method:
          typeof args.paymentMethod === 'string' ? args.paymentMethod : 'BANK',
        bank_account:
          typeof args.bankAccount === 'string' && args.bankAccount
            ? args.bankAccount
            : undefined,
        bank_account_name:
          typeof args.bankAccountName === 'string' && args.bankAccountName
            ? args.bankAccountName
            : undefined,
        bank_name:
          typeof args.bankName === 'string' && args.bankName
            ? args.bankName
            : undefined,
        voucher_no:
          typeof args.voucherNo === 'string' && args.voucherNo
            ? args.voucherNo
            : undefined,
        payment_date,
        remark:
          typeof args.remark === 'string' && args.remark
            ? args.remark
            : undefined,
        confirm: args.confirm === true,
      },
    };
  }
}
