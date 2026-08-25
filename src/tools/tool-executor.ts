import { Injectable, Logger } from '@nestjs/common';
import type { ChatMessage, ToolCall } from '../providers/provider.interface';
import { ToolContext, ToolExecutionRecord, ToolResult } from './tool.interface';
import { ToolRegistry } from './tool-registry';
import { AuditLogger } from '../bridge/audit-logger';
import { CircuitBreakerService } from './circuit-breaker.service';
import { MetricsService } from '../common/metrics.service';
import { CustomerScopeGuard } from './customer-scope.guard';

/**
 * Tool 执行器
 *
 * 职责：
 * 1. 接收 LLM 返回的 function call（ToolCall），解析参数 JSON
 * 2. 按名称从 ToolRegistry 查找工具并执行
 * 3. 统一错误处理：工具不存在 / 参数解析失败 / 执行异常 均不抛错，返回 ToolResult.success=false
 * 4. 批量执行多个 tool_calls，返回 tool 角色 ChatMessage[] 供 LLM 下一轮调用
 * 5. 记录执行耗时和审计信息（通过 AuditLogger 异步写入 t_ai_audit_log 表）
 *
 * 设计原则：
 * - 永不抛异常：所有错误转化为 ToolResult，让 LLM 能理解失败原因并自我纠正
 * - 错误信息友好：不泄露内部栈，面向 LLM 描述问题 + 给出 suggestion
 * - 并发执行：LLM 一次可能返回多个 tool_calls，用 Promise.all 并发执行提升吞吐
 * - 审计可观测：每次执行生成 ToolExecutionRecord，通过 AuditLogger 异步写入数据库（不阻塞主流程）
 *
 * 用法（Brain Engine Agent Loop 内）：
 *   const toolCalls = llmResult.tool_calls;
 *   if (toolCalls) {
 *     const toolMessages = await executor.executeToolCalls(toolCalls, context);
 *     messages.push(...toolMessages); // 加入对话历史，再次调用 LLM
 *   }
 */
@Injectable()
export class ToolExecutor {
  private readonly logger = new Logger(ToolExecutor.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly auditLogger: AuditLogger,
    private readonly breaker: CircuitBreakerService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 执行单个工具调用
   *
   * @param toolCall LLM 返回的工具调用请求（含 id / function.name / function.arguments）
   * @param context  执行上下文（含 tenantId）
   * @returns 工具执行结果（永不抛异常）
   */
  async executeToolCall(
    toolCall: ToolCall,
    context: ToolContext,
  ): Promise<ToolResult> {
    const toolName = toolCall.function.name;
    const start = Date.now();

    // 1. 解析参数 JSON
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
    } catch (err) {
      const errorMsg = `参数 JSON 解析失败：${err instanceof Error ? err.message : String(err)}（原始参数：${toolCall.function.arguments.slice(0, 200)}）`;
      this.logger.warn(`工具 ${toolName} 执行失败：${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        suggestion: '请检查 function calling 参数是否为合法 JSON 对象',
      };
    }

    // 2. 查找工具
    const tool = this.registry.get(toolName);
    if (!tool) {
      const errorMsg = `工具 "${toolName}" 未注册`;
      this.logger.warn(`${errorMsg}（已注册工具：${this.registry.size()} 个）`);
      return {
        success: false,
        error: errorMsg,
        suggestion: `可用工具列表：${this.registry
          .list()
          .map((t) => t.name)
          .join(', ')}`,
      };
    }

    // 3. 校验上下文 tenantId（多租户隔离兜底）
    if (!context.tenantId) {
      const errorMsg =
        '执行上下文缺少 tenantId，无法执行工具（多租户隔离要求）';
      this.logger.error(`工具 ${toolName} 执行被拦截：${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        suggestion: '请确认请求已通过 TenantGuard 注入 tenantId',
      };
    }

    // 3.5 批次4 customerScope 隔离：运营客户端仅可访问本人数据与受控写操作，
    //     其余（内部经营/成本/资金/改价等）一律 AI_010 拒绝（允许名单制，安全默认全拒）
    const scopeGate = CustomerScopeGuard.check(toolName, tool, context);
    if (!scopeGate.ok) {
      this.logger.warn(
        `客户身份越权拦截：tool=${toolName} customer=${context.customerId ?? '-'} ${scopeGate.error}`,
      );
      return {
        success: false,
        error: scopeGate.error,
        suggestion: scopeGate.suggestion,
      };
    }

    // 3.5 P1-3 工具级熔断：微服务故障不得拖垮 AI 底座
    const gate = this.breaker.canProceed(toolName);
    if (!gate.ok) {
      this.logger.warn(`工具 ${toolName} 执行被熔断拦截：${gate.reason}`);
      return {
        success: false,
        error: gate.reason,
        suggestion: '服务暂时不可用，请稍后重试或联系管理员检查对应服务',
      };
    }

    // 4. 执行工具（try-catch 兜底，即使 tool.execute 内部抛异常也不影响 Agent Loop）
    try {
      this.logger.debug(
        `执行工具 ${toolName}（tenant=${context.tenantId}, isWriteOperation=${tool.isWriteOperation}）`,
      );
      const result = await tool.execute(args, context);
      const durationMs = Date.now() - start;
      // A5 Prometheus 指标：工具调用次数/耗时
      this.metrics.recordToolCall(
        toolName,
        result.success ? 'success' : 'fail',
      );
      this.metrics.recordToolDuration(toolName, durationMs);
      // 熔断状态记录（按结果）
      if (result.success) {
        this.breaker.recordSuccess(toolName);
      } else {
        this.breaker.recordFailure(toolName);
      }

      // 记录审计信息（当前打日志，R70-05 接入 AuditLogger 后改为异步写库）
      this.logExecution({
        toolName,
        isWriteOperation: tool.isWriteOperation,
        success: result.success,
        durationMs,
        error: result.error,
        args,
        context,
      });

      if (!result.success) {
        this.logger.warn(
          `工具 ${toolName} 执行返回失败（${durationMs}ms）：${result.error ?? '未知错误'}`,
        );
      } else {
        this.logger.debug(`工具 ${toolName} 执行成功（${durationMs}ms）`);
      }

      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      this.metrics.recordToolCall(toolName, 'fail');
      this.metrics.recordToolDuration(toolName, durationMs);
      this.breaker.recordFailure(toolName);
      const errorMsg = `工具执行异常：${err instanceof Error ? err.message : String(err)}`;
      this.logger.error(
        `工具 ${toolName} 执行抛异常（${durationMs}ms）：${errorMsg}`,
        err instanceof Error ? err.stack : undefined,
      );

      this.logExecution({
        toolName,
        isWriteOperation: tool.isWriteOperation,
        success: false,
        durationMs,
        error: errorMsg,
        args,
        context,
      });

      return {
        success: false,
        error: errorMsg,
        suggestion: '工具内部异常，请稍后重试或换一种方式表达需求',
      };
    }
  }

  /**
   * 批量执行多个工具调用
   *
   * LLM 一次可能返回多个 tool_calls（如同时查客户+查商品+查库存），
   * 并发执行后返回 tool 角色 ChatMessage[]，直接追加到对话历史供 LLM 下一轮调用。
   *
   * @param toolCalls LLM 返回的工具调用列表
   * @param context   执行上下文
   * @returns tool 角色 ChatMessage[]（与 toolCalls 一一对应，顺序一致）
   *
   * ChatMessage 格式遵循 OpenAI Function Calling 协议：
   *   { role: 'tool', tool_call_id: '<对应 toolCall.id>', name: '<工具名>', content: '<ToolResult JSON 字符串>' }
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    context: ToolContext,
  ): Promise<ChatMessage[]> {
    if (!toolCalls || toolCalls.length === 0) {
      return [];
    }

    this.logger.log(`批量执行 ${toolCalls.length} 个工具调用`);

    // 并发执行所有 tool_calls（独立无依赖时可提升吞吐）
    const results = await Promise.all(
      toolCalls.map((tc) => this.executeToolCall(tc, context)),
    );

    // 转换为 tool 角色 ChatMessage（与 toolCalls 顺序一致）
    return toolCalls.map((tc, idx) => ({
      role: 'tool' as const,
      tool_call_id: tc.id,
      name: tc.function.name,
      content: JSON.stringify(results[idx]),
    }));
  }

  /**
   * 记录工具执行审计信息
   *
   * 通过 AuditLogger 异步写入 t_ai_audit_log 表（fire-and-forget，不阻塞主流程）。
   * 审计字段含：tenant_id / user_id / tool_name / args / success / duration_ms / is_write_operation。
   * 写入失败仅记 warn 日志，不影响业务流程。
   */
  private logExecution(record: ToolExecutionRecord): void {
    this.logger.debug(
      `工具审计：${record.toolName} success=${record.success} ${record.durationMs}ms` +
        (record.error ? ` error=${record.error}` : ''),
    );
    // 异步写入审计日志（不 await，不阻塞 Agent Loop）
    this.auditLogger.logToolExecution(record);
  }
}
