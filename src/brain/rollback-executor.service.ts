/**
 * RollbackExecutorService — 写操作自动回滚（AI 底座完善度 P1）
 *
 * 背景：R70-15 撤销端点为"登记"模式，业务回退依赖人工流程。
 * 本服务在撤销时按写操作类型自动调用对应回滚工具（如取消采购单），
 * 无回滚映射的操作降级为"登记+引导"，保证撤销闭环且不阻塞。
 *
 * 映射原则：
 * - 只有后端存在对应取消/回滚端点的写操作才配置自动回滚
 * - 回滚工具复用现有 Tool 体系（ServiceClient 调后端），幂等由业务侧约束
 */
import { Injectable, Logger } from '@nestjs/common';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolContext, ToolResult } from '../tools/tool.interface';
import type { ExecutedOperation } from './confirmation.service';

/** 回滚配置：指定回滚工具 + 从已执行操作提取单据号 */
interface RollbackConfig {
  /** 回滚工具名称（如 cancelPurchaseOrder） */
  rollbackTool: string;
  /** 从操作记录提取单据号（args 或 result） */
  extractOrderNo: (operation: ExecutedOperation) => string | null;
}

/** 回滚执行结果 */
export interface RollbackResult {
  /** 是否命中自动回滚映射 */
  handled: boolean;
  /** 自动回滚是否成功（handled=true 时有效） */
  success?: boolean;
  /** 回滚执行返回数据 */
  data?: unknown;
  /** 提示信息 */
  message: string;
}

/** 写操作 → 自动回滚映射表（随后端回滚端点扩展逐步补充） */
const ROLLBACK_MAP: Record<string, RollbackConfig> = {
  createPurchaseOrder: {
    rollbackTool: 'cancelPurchaseOrder',
    extractOrderNo: (op) => {
      const fromArgs = (op.args?.orderNo as string | undefined) ?? null;
      if (fromArgs) return fromArgs;
      const result = op.result as
        { orderNo?: string; data?: { orderNo?: string } } | undefined;
      return result?.orderNo ?? result?.data?.orderNo ?? null;
    },
  },
};

@Injectable()
export class RollbackExecutorService {
  private readonly logger = new Logger(RollbackExecutorService.name);

  constructor(private readonly toolRegistry: ToolRegistry) {}

  /**
   * 执行自动回滚（撤销已执行操作）
   *
   * @param operation 已执行操作记录（含 toolName/args/result）
   * @param context   工具执行上下文（tenantId/authToken 等）
   */
  async executeRollback(
    operation: ExecutedOperation,
    context: ToolContext,
  ): Promise<RollbackResult> {
    const config = ROLLBACK_MAP[operation.toolName];
    if (!config) {
      return {
        handled: false,
        message: `操作类型 ${operation.toolName} 暂不支持自动回滚，请通过对应单据的取消/退货流程完成最终回退`,
      };
    }

    const tool = this.toolRegistry.get(config.rollbackTool);
    if (!tool) {
      return {
        handled: true,
        success: false,
        message: `回滚工具 ${config.rollbackTool} 未注册，请通过业务流程处理`,
      };
    }

    const orderNo = config.extractOrderNo(operation);
    if (!orderNo) {
      return {
        handled: true,
        success: false,
        message: '无法从操作记录提取单据号，请通过业务流程处理',
      };
    }

    const result: ToolResult = await tool.execute(
      { orderNo, reason: 'AI 助手撤销操作' },
      context,
    );

    this.logger.log(
      `自动回滚：op=${operation.operationId} tool=${operation.toolName} → ${config.rollbackTool} orderNo=${orderNo} success=${result.success}`,
    );

    return {
      handled: true,
      success: result.success,
      data: result.data,
      message: result.success
        ? `已自动回滚：${result.data && typeof result.data === 'object' && 'message' in result.data ? String((result.data as { message: string }).message) : '单据已取消'}`
        : `自动回滚失败：${result.error ?? '未知错误'}，请通过业务流程处理`,
    };
  }
}
