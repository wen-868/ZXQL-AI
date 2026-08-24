/**
 * api_create_purchase_contract 工具 — 创建采购合同（写操作，预览确认）
 *
 * 对应后端 API：POST /api/admin/purchase-contracts
 * 后端校验（purchase-contract.controller.ts createPurchaseContractSchema）：
 * - supplierId、contractName(1-200)、contractType(1-50)、totalAmount(>=0)
 * - signDate/startDate/endDate（可选）、remark（可选 max500）
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

interface CreateContractArgs {
  supplierId: number;
  contractName: string;
  contractType: string;
  totalAmount: number;
  signDate?: string;
  startDate?: string;
  endDate?: string;
  remark?: string;
  confirm?: boolean;
}

@Injectable()
export class CreatePurchaseContractTool implements ITool {
  private readonly logger = new Logger(CreatePurchaseContractTool.name);

  readonly name = 'api_create_purchase_contract';
  readonly description =
    '创建采购合同（写操作，需用户确认）：登记与供应商的采购合同信息。' +
    '入参：supplierId(供应商ID)、contractName(合同名称)、contractType(合同类型)、' +
    'totalAmount(合同金额)、signDate(签订日期,可选)、startDate/endDate(有效期,可选)。' +
    '首次调用 confirm=false 生成预览，用户确认后 confirm=true 正式创建。';
  readonly category = 'purchase' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      supplierId: { type: 'number', description: '供应商ID（必填）' },
      contractName: { type: 'string', description: '合同名称（必填）' },
      contractType: {
        type: 'string',
        description: '合同类型（必填，如框架协议/年度采购）',
      },
      totalAmount: { type: 'number', description: '合同金额（必填，>=0）' },
      signDate: { type: 'string', description: '签订日期（可选，YYYY-MM-DD）' },
      startDate: { type: 'string', description: '生效日期（可选）' },
      endDate: { type: 'string', description: '失效日期（可选）' },
      remark: { type: 'string', description: '备注（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（false=预览，true=创建，默认 false）',
      },
    },
    required: ['supplierId', 'contractName', 'contractType', 'totalAmount'],
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
          operation: '创建采购合同',
          summary: `登记采购合同「${a.contractName}」（${a.contractType}），金额 ${a.totalAmount} 元`,
          details: {
            supplierId: a.supplierId,
            contractName: a.contractName,
            contractType: a.contractType,
            totalAmount: a.totalAmount,
            signDate: a.signDate ?? '',
            startDate: a.startDate ?? '',
            endDate: a.endDate ?? '',
            remark: a.remark ?? '',
          },
        },
      };
    }

    try {
      const result = await this.serviceClient.post(
        API_ENDPOINTS.PURCHASE_CONTRACTS,
        {
          supplierId: a.supplierId,
          contractName: a.contractName,
          contractType: a.contractType,
          totalAmount: a.totalAmount,
          signDate: a.signDate ?? null,
          startDate: a.startDate ?? null,
          endDate: a.endDate ?? null,
          remark: a.remark ?? null,
        },
        context,
      );
      this.logger.log(`创建采购合同成功：${a.contractName}`);
      return { success: true, data: result };
    } catch (err) {
      const msg =
        err instanceof BridgeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      this.logger.warn(`创建采购合同失败：${msg}`);
      return {
        success: false,
        error: `创建采购合同失败：${msg}`,
        suggestion: '请确认供应商与合同信息后重试',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateContractArgs }
    | { valid: false; error: string; suggestion?: string } {
    const supplierId = Number(args.supplierId);
    if (!Number.isInteger(supplierId) || supplierId <= 0)
      return {
        valid: false,
        error: '参数 supplierId 必须为正整数',
        suggestion: '请提供供应商ID',
      };
    const contractName = args.contractName;
    const contractType = args.contractType;
    if (
      typeof contractName !== 'string' ||
      contractName.trim().length === 0 ||
      contractName.length > 200
    )
      return {
        valid: false,
        error: '参数 contractName 必填（1-200字）',
        suggestion: '请提供合同名称',
      };
    if (
      typeof contractType !== 'string' ||
      contractType.trim().length === 0 ||
      contractType.length > 50
    )
      return {
        valid: false,
        error: '参数 contractType 必填（1-50字）',
        suggestion: '请提供合同类型',
      };
    const totalAmount = Number(args.totalAmount);
    if (!Number.isFinite(totalAmount) || totalAmount < 0)
      return {
        valid: false,
        error: '参数 totalAmount 必须为不小于 0 的数字',
        suggestion: '请检查合同金额',
      };
    return {
      valid: true,
      data: {
        supplierId,
        contractName: contractName.trim(),
        contractType: contractType.trim(),
        totalAmount,
        signDate:
          typeof args.signDate === 'string' && args.signDate
            ? args.signDate
            : undefined,
        startDate:
          typeof args.startDate === 'string' && args.startDate
            ? args.startDate
            : undefined,
        endDate:
          typeof args.endDate === 'string' && args.endDate
            ? args.endDate
            : undefined,
        remark:
          typeof args.remark === 'string' && args.remark
            ? args.remark
            : undefined,
        confirm: args.confirm === true,
      },
    };
  }
}
