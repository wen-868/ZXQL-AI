/**
 * EvidenceLedgerService — C10 证据优先验证（完善度 P0-7）
 *
 * 职责：
 * 1. 写操作副作用账本：每次工具写操作记录「意图+参数+结果」到审计日志
 * 2. 一致性核查：呈现前校验工具结果（成功必须有 data；金额/数量字段校验）
 * 3. 降低幻觉：工具结果异常时返回核查问题清单，供上层展示前修正
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-7 C10 证据验证
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditLogger } from '../../bridge/audit-logger';
import type { ToolContext, ToolResult } from '../../tools/tool.interface';

/** 核查结果 */
export interface VerificationResult {
  ok: boolean;
  issues: string[];
}

@Injectable()
export class EvidenceLedgerService {
  private readonly logger = new Logger(EvidenceLedgerService.name);

  constructor(private readonly auditLogger: AuditLogger) {}

  /**
   * 记录写操作副作用（意图+参数+结果 → 审计留痕）
   */
  recordWrite(
    context: ToolContext,
    tool: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ): void {
    this.auditLogger.logAiCall({
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: context.sessionId,
      intent: 'evidence_write_ledger',
      userMessage: tool,
      toolCalls: [
        {
          tool_name: tool,
          is_write_operation: true,
          success: result.success,
          duration_ms: 0,
          priority: 'important',
          content: JSON.stringify({
            args,
            result: result.data ?? result.error,
          }),
        },
      ],
      promptTokens: 0,
      completionTokens: 0,
      success: result.success,
    });
  }

  /**
   * 呈现前一致性核查
   *
   * 规则：
   * - 成功结果必须携带 data（缺 data 视为异常）
   * - 若 data 含 amount/totalAmount/quantity 且非数字 → 提示核查
   */
  verify(result: ToolResult): VerificationResult {
    const issues: string[] = [];
    if (result.success && result.data === undefined) {
      issues.push('工具返回成功但缺少 data（结果不可信）');
    }
    if (result.success && result.data !== undefined) {
      const d = result.data as Record<string, unknown>;
      if (d && typeof d === 'object') {
        for (const field of ['amount', 'totalAmount', 'quantity']) {
          const v = d[field];
          if (
            v !== undefined &&
            typeof v !== 'number' &&
            typeof v !== 'string'
          ) {
            issues.push(
              `字段 ${field} 类型异常：${
                typeof v === 'object'
                  ? JSON.stringify(v)
                  : typeof v === 'boolean'
                    ? String(v)
                    : '未知类型'
              }`,
            );
          }
        }
      }
    }
    if (issues.length > 0) {
      this.logger.warn(`证据核查发现问题：${issues.join('；')}`);
    }
    return { ok: issues.length === 0, issues };
  }
}
