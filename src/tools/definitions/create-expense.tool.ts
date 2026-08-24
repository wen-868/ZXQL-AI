/**
 * api_create_expense 工具 — 创建费用单（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/expenses
 * 后端字段（expense.controller.ts createExpense）：
 * - expenseType、category、amount、payee、paymentMethod、
 * - bankAccountId?、invoiceNo?、expenseDate、remark?
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

interface CreateExpenseArgs {
  expenseType: string;
  category: string;
  amount: number;
  payee: string;
  paymentMethod: string;
  bankAccountId?: number;
  invoiceNo?: string;
  expenseDate: string;
  remark?: string;
  confirm?: boolean;
}

@Injectable()
export class CreateExpenseTool implements ITool {
  private readonly logger = new Logger(CreateExpenseTool.name);

  readonly name = 'api_create_expense';
  readonly description =
    '创建费用单（写操作，需用户确认）：登记经营费用支出。' +
    '入参：expenseType(费用类型)、category(费用分类)、amount(金额)、payee(收款方)、' +
    'paymentMethod(支付方式)、expenseDate(费用日期)、invoiceNo(发票号,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'finance' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      expenseType: {
        type: 'string',
        description: '费用类型（必填，如 OPERATING/STAFF/LOGISTICS）',
      },
      category: {
        type: 'string',
        description: '费用分类（必填，如 房租/水电/工资/运费）',
      },
      amount: { type: 'number', description: '金额（必填，>0）' },
      payee: { type: 'string', description: '收款方（必填）' },
      paymentMethod: {
        type: 'string',
        description: '支付方式（可选，如 BANK/CASH/ALIPAY）',
      },
      bankAccountId: { type: 'number', description: '银行账户ID（可选）' },
      invoiceNo: { type: 'string', description: '发票号（可选）' },
      expenseDate: {
        type: 'string',
        description: '费用日期（必填，YYYY-MM-DD）',
      },
      remark: { type: 'string', description: '备注（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['expenseType', 'category', 'amount', 'payee', 'expenseDate'],
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
          operation: '创建费用单',
          summary: `登记费用「${a.category}」${a.amount} 元（${a.expenseDate}，付给${a.payee}）`,
          details: {
            expenseType: a.expenseType,
            category: a.category,
            amount: a.amount,
            payee: a.payee,
            paymentMethod: a.paymentMethod,
            invoiceNo: a.invoiceNo ?? '',
            expenseDate: a.expenseDate,
            remark: a.remark ?? '',
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.EXPENSES,
        {
          expenseType: a.expenseType,
          category: a.category,
          amount: a.amount,
          payee: a.payee,
          paymentMethod: a.paymentMethod,
          bankAccountId: a.bankAccountId ?? null,
          invoiceNo: a.invoiceNo ?? null,
          expenseDate: a.expenseDate,
          remark: a.remark ?? null,
        },
        context,
      );
      this.logger.log(`创建费用单成功：${a.category} ${a.amount}元`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建费用单失败：${msg}`);
      return {
        success: false,
        error: `创建费用单失败：${msg}`,
        suggestion: '请检查费用信息后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateExpenseArgs }
    | { valid: false; error: string; suggestion?: string } {
    const expenseType = args.expenseType;
    const category = args.category;
    const payee = args.payee;
    if (typeof expenseType !== 'string' || expenseType.trim().length === 0)
      return {
        valid: false,
        error: '参数 expenseType 必填',
        suggestion: '请提供费用类型',
      };
    if (typeof category !== 'string' || category.trim().length === 0)
      return {
        valid: false,
        error: '参数 category 必填',
        suggestion: '请提供费用分类',
      };
    if (typeof payee !== 'string' || payee.trim().length === 0)
      return {
        valid: false,
        error: '参数 payee 必填',
        suggestion: '请提供收款方',
      };
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return {
        valid: false,
        error: '参数 amount 必须为大于 0 的数字',
        suggestion: '请检查费用金额',
      };
    const expenseDate = args.expenseDate;
    if (typeof expenseDate !== 'string' || expenseDate.length === 0)
      return {
        valid: false,
        error: '参数 expenseDate 必填',
        suggestion: '格式如 2026-08-16',
      };
    return {
      valid: true,
      data: {
        expenseType: expenseType.trim(),
        category: category.trim(),
        amount,
        payee: payee.trim(),
        paymentMethod:
          typeof args.paymentMethod === 'string' && args.paymentMethod
            ? args.paymentMethod
            : 'BANK',
        bankAccountId:
          args.bankAccountId === undefined
            ? undefined
            : Number(args.bankAccountId),
        invoiceNo:
          typeof args.invoiceNo === 'string' && args.invoiceNo
            ? args.invoiceNo
            : undefined,
        expenseDate,
        remark:
          typeof args.remark === 'string' && args.remark
            ? args.remark
            : undefined,
        confirm: args.confirm === true,
      },
    };
  }
}
