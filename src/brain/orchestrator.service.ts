/**
 * Orchestrator — Agent Loop 编排器
 *
 * 职责：
 * 1. 编排完整的 Agent Loop：加载历史 → 构建上下文 → LLM调用 → 工具执行 → 结果处理
 * 2. 支持流式输出（AsyncGenerator 逐步 yield 事件）
 * 3. 最大 10 轮循环，防止死循环
 * 4. 对话历史持久化（MemoryManager）
 * 5. 审计日志记录（AuditLogger）
 *
 * Agent Loop 流程：
 *   用户消息 → 加载历史 → 构建上下文 → LLM调用 → 判断结果
 *     │
 *     ├─ 纯文本（stop）→ 流式输出 → 保存记忆 → 写审计日志 → 结束
 *     │
 *     ├─ 工具调用（tool_calls）→ 执行工具 → 结果加入上下文 → 回到 LLM调用
 *     │
 *     └─ 达到长度限制（length）→ 截断输出 → 结束
 *
 * 事件类型（OrchestratorEvent）：
 *   - { type: 'text', content: string }           — LLM 生成的增量文本
 *   - { type: 'tool_start', tool: string }         — 开始执行工具
 *   - { type: 'tool_result', tool: string, ... }   — 工具执行结果
 *   - { type: 'done', conversationId, usage }      — 对话完成
 *   - { type: 'error', message: string }           — 错误事件
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-开发文档.md 第八章 8.1 Orchestrator
 * - docs/ai-base/智享AI底座-架构设计文档.md 第九章 核心数据流
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { ToolExecutor } from '../tools/tool-executor';
import { ToolRegistry } from '../tools/tool-registry';
import { AuditLogger } from '../bridge/audit-logger';
import { AiConfigService } from '../tenant/ai-config.service';
import { TenantContext } from '../tenant/tenant-context';
import { ContextBuilder } from './context-builder.service';
import { MemoryManager } from './memory-manager.service';
import { ConfirmationService } from './confirmation.service';
import { StructuredExtractor } from './extraction/structured-extractor';
import { CaptureService } from '../evolution/capture.service';
import type { ChatMessage, ChatResult } from '../providers/provider.interface';
import type { ToolContext, ToolResult } from '../tools/tool.interface';
import { GraphExecutorService } from './graph/graph-executor.service';
import { ProviderRouterService } from './router/provider-router.service';
import { LearningService } from './learning/learning.service';
import { formatInventoryQty } from './inventory-format';
import { buildApiToolSummary } from './api-summary';
import { buildWriteSummary } from './write-summary';
import { detectIntentCategories } from './intent-detector';
import { resolveReference } from '../nlp/reference-resolver';

/** Agent Loop 最大迭代次数（防止死循环） */
const MAX_ITERATIONS = 10;

/** 将未知类型安全转为展示文本：字符串/数字/布尔原样返回，其余按兜底值处理（避免 [object Object]） */
function toText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  return fallback;
}

/**
 * Orchestrator 产出的事件
 *
 * ChatController 将此转为 SSE 格式发送给前端。
 */
/** 有状态图事件（P0-1 graph 模式，SSE 前端渲染步骤流） */
export type GraphOrchestratorEvent =
  | { type: 'node_start'; nodeId: string; label: string }
  | { type: 'node_end'; nodeId: string; label: string; success: boolean }
  | {
      type: 'review_required';
      reviewId: number;
      tool: string;
      note: string;
      payload?: Record<string, unknown>;
    }
  | { type: 'graph_done'; graphId: string };

/** 基础事件（react 模式 + 公共事件） */
export type OrchestratorBaseEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; tool: string }
  | {
      type: 'tool_result';
      tool: string;
      success: boolean;
      data?: unknown;
      error?: string;
      /** R70-15：写操作预览（工具返回 preview 时携带，供前端渲染确认卡片） */
      preview?: ToolResult['preview'];
      /** R70-15：待确认操作 ID（写操作预览时由 ConfirmationService 生成） */
      confirmationId?: string;
    }
  | {
      /**
       * P0-2：写入参数反问澄清（必填缺失/非法时下发，前端展示问题，
       * 不挂残缺草稿——本工具调用被跳过，等用户补充后重新发起）
       */
      type: 'clarify';
      message: string;
      issues?: Array<{
        field: string;
        reason: 'required' | 'type' | 'enum' | 'items';
        message: string;
        question: string;
      }>;
    }
  | {
      type: 'done';
      conversationId: string;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        latencyMs: number;
        iterations: number;
      };
    }
  | { type: 'error'; message: string };

/** Orchestrator 产出事件（react + graph） */
export type OrchestratorEvent = OrchestratorBaseEvent | GraphOrchestratorEvent;

/**
 * Orchestrator 执行参数
 */
export interface OrchestratorParams {
  /** 用户消息 */
  message: string;
  /** 会话 ID（不传则自动生成） */
  conversationId?: string;
  /** 租户 ID（不传则从 TenantContext 获取） */
  tenantId?: string;
  /** 用户 ID */
  userId?: string;
  /** 用户角色 */
  role?: string;
  /** JWT auth token（透传给 ServiceClient） */
  authToken?: string;
  /** 对话级模型标识（可选；已注册的内置/外部模型名，覆盖租户/平台默认） */
  model?: string;
  /** 执行模式：react（单 Agent 循环，默认）/ graph（有状态图） */
  mode?: 'react' | 'graph';
  /** graph 模式下：图 ID（如 sale_create_graph） */
  graphId?: string;
  /** 工具作用域（可选）：mgmt=租户域（默认）/ platform=总台域（暴露 api_platform_*） */
  scope?: 'mgmt' | 'platform';
}

@Injectable()
export class Orchestrator {
  private readonly logger = new Logger(Orchestrator.name);

  constructor(
    private readonly executor: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly auditLogger: AuditLogger,
    private readonly aiConfigService: AiConfigService,
    private readonly tenantContext: TenantContext,
    private readonly contextBuilder: ContextBuilder,
    private readonly memoryManager: MemoryManager,
    private readonly confirmationService: ConfirmationService,
    private readonly graphExecutor: GraphExecutorService,
    private readonly router: ProviderRouterService,
    private readonly learning: LearningService,
    private readonly extractor: StructuredExtractor,
    private readonly capture: CaptureService,
  ) {}

  /**
   * 执行 Agent Loop（流式）
   *
   * 返回 AsyncGenerator，调用方逐个消费事件。
   *
   * 用法：
   *   for await (const event of orchestrator.run(params)) {
   *     // 处理事件（转 SSE / 转 WebSocket / ...）
   *   }
   */
  async *run(params: OrchestratorParams): AsyncGenerator<OrchestratorEvent> {
    // ── 1. 解析租户信息 ──
    const ctxData = this.tenantContext.getData();
    const tenantId = params.tenantId ?? ctxData?.tenantId;
    const userId = params.userId ?? ctxData?.userId;
    const role = params.role ?? ctxData?.role;
    const authToken = params.authToken ?? ctxData?.authToken;

    if (!tenantId) {
      yield {
        type: 'error',
        message: '未认证：无法确定租户身份（无 JWT 且未传入 tenantId）',
      };
      return;
    }

    // 生成或复用会话 ID
    const conversationId =
      params.conversationId ?? this.memoryManager.generateSessionId();

    this.logger.log(
      `Agent Loop 启动：tenant=${tenantId} user=${userId ?? 'anonymous'} session=${conversationId} msg="${params.message.slice(0, 50)}..."`,
    );

    // ── 2. 获取租户 AI 配置 ──
    let providerName = 'unknown';
    let modelName: string | undefined;
    let systemPrompt: string | null = null;

    try {
      const resolvedConfig = await this.aiConfigService.getResolvedConfig();
      providerName = resolvedConfig.provider;
      modelName = resolvedConfig.model;
      systemPrompt = resolvedConfig.systemPrompt;

      // C9 自适应路由（P0-6）：用户指定模型 > 租户/平台配置 > 内置默认
      const routed = this.router.route({
        requestedModel: params.model,
        resolved: resolvedConfig,
        systemScope: this.router.getSystemScope(),
      });
      providerName = routed.providerName;
      const provider = routed.provider;
      this.logger.log(
        `C9 路由：${routed.reason}；租户 ${tenantId} model=${modelName} source=${resolvedConfig.source}`,
      );

      // ── 3. 加载对话历史 ──
      const history = await this.memoryManager.loadHistory(
        tenantId,
        conversationId,
      );
      if (history.length > 0) {
        this.logger.debug(`加载对话历史：${history.length} 条消息`);
      }

      // 多轮指代消解：检测"上一单/那个客户/它"并从历史提取上下文提示
      let userMessage = params.message;
      const reference = resolveReference(params.message, history);
      if (reference.hasReference && reference.context) {
        userMessage = `${reference.context}\n用户消息：${params.message}`;
        this.logger.debug(
          `指代消解注入上下文：${reference.context.slice(0, 60)}`,
        );
      }

      // ── 4. 构建上下文 ──
      // R70-21：build 已升级为异步（内部做 RAG 知识库检索注入，embedding 未配置时自动跳过）
      const messages = await this.contextBuilder.build(
        {
          tenantId,
          userId,
          role,
          userMessage,
          history,
          systemPrompt: systemPrompt ?? undefined,
        },
        this.registry,
      );

      // 工具定义（供 LLM function calling）：意图驱动减负（只带相关域工具）+ scope 隔离
      const toolDefinitions = this.registry.toToolDefinitionsForCategories(
        detectIntentCategories(params.message),
        params.scope,
      );
      this.logger.debug(
        `意图工具集：${toolDefinitions.length} 个（消息「${params.message.slice(0, 20)}」）`,
      );

      // 构造工具执行上下文
      const toolContext: ToolContext = {
        tenantId,
        userId,
        sessionId: conversationId,
        role,
        authToken,
      };

      // ── 4.5 有状态图模式（P0-1）：按图执行工具/条件/Agent 节点，Checkpointer 持久化 ──
      if (params.mode === 'graph') {
        if (!params.graphId) {
          yield { type: 'error', message: 'graph 模式必须指定 graphId' };
          return;
        }
        const graph = this.graphExecutor.getGraph(params.graphId);
        if (!graph) {
          yield {
            type: 'error',
            message: `未知图：${params.graphId}（可用：${this.graphExecutor
              .listGraphs()
              .map((g) => g.id)
              .join(', ')}）`,
          };
          return;
        }
        this.logger.log(
          `graph 模式启动：graph=${graph.id} tenant=${tenantId} session=${conversationId}`,
        );
        const graphStartTime = Date.now();
        for await (const event of this.graphExecutor.execute(
          graph,
          conversationId,
          toolContext,
          provider,
        )) {
          yield event;
        }
        yield {
          type: 'done',
          conversationId,
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            latencyMs: Date.now() - graphStartTime,
            iterations: 0,
          },
        };
        return;
      }

      // ── 5. Agent Loop ──
      const startTime = Date.now();
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      const allToolCalls: Record<string, unknown>[] = [];
      // 工具结果记录：模型未输出总结文本时用于生成兜底摘要
      const toolResults: Array<{
        tool: string;
        success: boolean;
        data?: unknown;
        error?: string;
      }> = [];
      let finalAssistantText = '';
      const newMessagesToSave: ChatMessage[] = [
        { role: 'user', content: params.message },
      ];

      let iteration = 0;

      for (; iteration < MAX_ITERATIONS; iteration++) {
        this.logger.debug(`Agent Loop 第 ${iteration + 1} 轮`);

        // 调用 LLM（流式）
        const generator = provider.chat(messages, {
          tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
          temperature: resolvedConfig.temperature,
          max_tokens: resolvedConfig.maxTokens,
        });

        // 消费流式生成器
        let chatResult: ChatResult;
        let contentBuf = '';

        try {
          while (true) {
            const { value, done } = await generator.next();
            if (done) {
              chatResult = value;
              break;
            }
            // value 是增量文本
            contentBuf += value;
            yield { type: 'text', content: value };
          }
        } catch (genErr) {
          throw new Error(
            `LLM 流式生成失败：${genErr instanceof Error ? genErr.message : String(genErr)}`,
          );
        }

        // 累计 token
        totalPromptTokens += chatResult!.prompt_tokens;
        totalCompletionTokens += chatResult!.completion_tokens;

        // 检查工具调用
        const toolCalls = chatResult!.tool_calls;
        if (!toolCalls || toolCalls.length === 0) {
          // 无工具调用，对话结束
          finalAssistantText = contentBuf;
          // assistant 消息加入待保存列表
          newMessagesToSave.push({
            role: 'assistant',
            content: contentBuf,
          });
          break;
        }

        // 有工具调用
        // 先把 assistant 消息（含 tool_calls）加入上下文
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: contentBuf,
          tool_calls: toolCalls,
        };
        messages.push(assistantMsg);
        newMessagesToSave.push(assistantMsg);

        // 执行工具
        for (const tc of toolCalls) {
          yield {
            type: 'tool_start',
            tool: tc.function.name,
          };

          this.logger.debug(`执行工具：${tc.function.name}`);

          const toolResult = await this.executor.executeToolCall(
            tc,
            toolContext,
          );

          // ── P0-2 StructuredExtractor：写参数结构化抽取增强 ──
          // 写工具返回 preview 后，用原始用户消息做结构化抽取：
          // - 必填缺失/非法 → 下发 clarify 事件反问澄清，**不挂残缺草稿**（跳过本工具）
          // - 抽取成功 → 合并补缺（缺失字段填充），确认执行时使用增强后参数
          // - LLM 异常/未命中 Schema → 降级原流程，不阻断业务
          const rawArgs = JSON.parse(tc.function.arguments) as Record<
            string,
            unknown
          >;
          let execArgs = rawArgs;
          if (toolResult.preview) {
            const enhance = await this.extractor.tryEnhance({
              toolName: tc.function.name,
              utterance: params.message,
              args: rawArgs,
              model: params.model,
            });
            if (enhance.needsClarification) {
              yield {
                type: 'clarify',
                message:
                  enhance.questions?.join('；') ?? '请补充必要信息后再试',
                issues: enhance.issues,
              };
              continue;
            }
            if (enhance.args) {
              execArgs = enhance.args;
            }
          }

          // ── R70-15 + P0-1 WriteGuard：写操作预览 → 挂起令牌 ──
          // 工具返回 preview（写操作未确认）时，由 ConfirmationService 经
          // WriteGuardService 生成令牌（confirmationId），并在 tool_result 事件
          // 中携带，供前端渲染确认卡片。risk/needsReview 取自工具注册元信息，
          // 高危写（资金/删除/批量）触发二次确认。
          let confirmationId: string | undefined;
          if (toolResult.preview) {
            try {
              const tool = this.registry.get(tc.function.name);
              const risk = tool?.risk ?? 'medium';
              const confirmation = await this.confirmationService.create({
                tenantId,
                conversationId,
                toolName: tc.function.name,
                docType: tc.function.name,
                risk,
                needsReview: tool?.needsReview ?? risk === 'high',
                args: execArgs,
                preview: toolResult.preview,
                operationLabel:
                  toolResult.preview.operation ?? tc.function.name,
              });
              confirmationId = confirmation.confirmationId;
            } catch (err) {
              this.logger.warn(
                `注册待确认操作失败：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          yield {
            type: 'tool_result',
            tool: tc.function.name,
            success: toolResult.success,
            data: toolResult.data,
            error: toolResult.error,
            preview: toolResult.preview,
            confirmationId,
          };

          allToolCalls.push({
            tool_name: tc.function.name,
            success: toolResult.success,
            error: toolResult.error,
          });
          toolResults.push({
            tool: tc.function.name,
            success: toolResult.success,
            data: toolResult.data,
            error: toolResult.error,
          });

          // 工具结果加入消息历史
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify(toolResult),
          };
          messages.push(toolMsg);
          newMessagesToSave.push(toolMsg);
        }

        // 工具执行完毕，继续下一轮 LLM 调用
      }

      if (iteration >= MAX_ITERATIONS) {
        this.logger.warn(
          `Agent Loop 达到最大迭代次数 ${MAX_ITERATIONS}，强制终止`,
        );
      }

      // ── 5.5 兜底总结：模型未输出任何文本但执行过工具时，用工具结果生成摘要 ──
      // 解决模型在工具调用后直接结束（无总结文本）导致前端只显示工具 JSON 的问题
      if (finalAssistantText.trim().length === 0 && toolResults.length > 0) {
        const fallbackText = this.buildFallbackSummary(toolResults);
        yield { type: 'text', content: fallbackText };
        // 将兜底摘要写入最后一条 assistant 消息（供对话历史保存）
        for (let i = newMessagesToSave.length - 1; i >= 0; i--) {
          const m = newMessagesToSave[i];
          if (m.role === 'assistant' && !m.content) {
            m.content = fallbackText;
            break;
          }
        }
      }

      // ── 6. 保存对话历史 ──
      await this.memoryManager.saveHistory(
        tenantId,
        conversationId,
        newMessagesToSave,
      );

      // ── 6.5 P2 自主学习：基于工具结果吸收反馈（失败/成功经验回流，不阻塞主流程） ──
      try {
        if (toolResults.length > 0) {
          const failed = toolResults.find((r) => !r.success);
          await this.learning.absorb(
            tenantId,
            {
              taskName: '对话任务',
              success: !failed,
              error: failed?.error,
              tool: failed?.tool,
            },
            userId,
          );
        }
      } catch (err) {
        this.logger.debug(
          `学习吸收失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── 6.7 P1-1 ai_db 采集：任务结束落经验/样本（脱敏入库，不阻塞主流程） ──
      try {
        const captureFailed = toolResults.find((r) => !r.success);
        const firstTool = allToolCalls[0];
        const toolName =
          typeof firstTool?.tool_name === 'string'
            ? firstTool.tool_name
            : undefined;
        const isWrite = toolName
          ? (this.registry.get(toolName)?.isWriteOperation ?? false)
          : false;
        await this.capture.captureTask({
          tenantId,
          domain: isWrite ? 'write' : 'analysis',
          intent: toolName ?? 'chat',
          userMessage: params.message,
          toolCalls: allToolCalls,
          outcome: captureFailed ? 'failed' : 'success',
          reply: finalAssistantText.trim() || undefined,
          error: captureFailed?.error,
        });
      } catch (err) {
        this.logger.debug(
          `ai_db 任务采集失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── 6.6 对话级经验沉淀：纯咨询对话（无工具调用）也记录情节经验 ──
      try {
        if (toolResults.length === 0 && finalAssistantText.trim().length > 0) {
          await this.learning.noteConversation(
            tenantId,
            params.message,
            finalAssistantText,
          );
        }
      } catch (err) {
        this.logger.debug(
          `对话经验沉淀失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // ── 7. 发送 done 事件 ──
      const latencyMs = Date.now() - startTime;
      yield {
        type: 'done',
        conversationId,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          latencyMs,
          iterations: iteration + 1,
        },
      };

      // ── 8. 审计日志 ──
      this.auditLogger.logAiCall({
        tenantId,
        userId,
        sessionId: conversationId,
        provider: providerName,
        model: modelName,
        intent: 'chat',
        userMessage: params.message,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        latencyMs,
        success: true,
      });

      this.logger.log(
        `Agent Loop 完成：session=${conversationId} iterations=${iteration + 1} tokens=${totalPromptTokens + totalCompletionTokens} latency=${latencyMs}ms tools=${allToolCalls.length}`,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Agent Loop 失败：${errorMsg}`,
        err instanceof Error ? err.stack : undefined,
      );

      yield {
        type: 'error',
        message: `对话处理失败：${errorMsg}`,
      };

      // 审计日志：记录失败的 AI 调用
      this.auditLogger.logAiCall({
        tenantId,
        userId,
        sessionId: conversationId,
        provider: providerName,
        model: modelName,
        intent: 'chat',
        userMessage: params.message,
        promptTokens: 0,
        completionTokens: 0,
        latencyMs: 0,
        success: false,
        errorMessage: errorMsg,
      });
    }
  }

  /**
   * 工具结果兜底摘要：模型未输出总结时，从工具返回数据生成可读中文摘要。
   * 覆盖高频工具（销售单/报表/查询类），未覆盖的工具给出通用提示。
   */
  private buildFallbackSummary(
    toolResults: Array<{
      tool: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }>,
  ): string {
    const parts: string[] = [];
    for (const tr of toolResults) {
      if (!tr.success) {
        parts.push(`「${tr.tool}」执行失败：${tr.error || '未知错误'}`);
        continue;
      }
      const d = (tr.data ?? {}) as Record<string, unknown>;
      switch (tr.tool) {
        case 'createSalesOrder': {
          const items = Array.isArray(d.items)
            ? (d.items as Array<Record<string, unknown>>)
            : [];
          const itemText = items
            .map((it) => {
              const name = toText(it.skuName) || toText(it.productName);
              const box = it.boxQty ? `${toText(it.boxQty)}箱` : '';
              const bottle = it.bottleQty ? `${toText(it.bottleQty)}瓶` : '';
              const price =
                it.totalPrice != null ? `（¥${toText(it.totalPrice)}）` : '';
              return [name, box, bottle, price].filter(Boolean).join(' ');
            })
            .filter(Boolean)
            .join('、');
          parts.push(
            `销售单 ${toText(d.billNo)} 创建成功：客户 ${toText(d.customerName, '未知')}，` +
              `${itemText || `${toText(d.itemCount)} 种商品`}，` +
              `总金额 ¥${toText(d.totalAmount, '未知')}。`,
          );
          break;
        }
        case 'salesReport': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(
            `销售报表查询完成：${d.reportType === 'trend' ? '趋势报表' : '日报'}，` +
              `日期 ${toText(d.dateStart, '-')} 至 ${toText(d.dateEnd, '-')}，` +
              `共 ${list.length} 条记录。`,
          );
          break;
        }
        case 'querySaleBills': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(`共查询到 ${list.length} 张销售单。`);
          break;
        }
        case 'searchProduct': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(`共找到 ${list.length} 个匹配商品。`);
          break;
        }
        case 'searchCustomer': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(`共找到 ${list.length} 个匹配客户。`);
          break;
        }
        case 'checkInventory': {
          // 直接给出库存结论（不展示过程）：现在{商品}的库存有{N}
          const list = (
            Array.isArray(d.records)
              ? d.records
              : Array.isArray(d.list)
                ? d.list
                : []
          ) as Array<Record<string, unknown>>;
          if (list.length === 0) {
            parts.push('未查询到相关库存记录。');
          } else {
            for (const it of list) {
              const name = toText(it.skuName) || '商品';
              const qty = formatInventoryQty(it.availableQty ?? it.totalQty, {
                boxRatio: it.boxRatio,
                boxUnit: it.boxUnit,
                baseUnit: it.baseUnit,
              });
              const store = toText(it.storeName);
              parts.push(
                store
                  ? `现在${name}的库存有${qty}（${store}）`
                  : `现在${name}的库存有${qty}`,
              );
            }
          }
          break;
        }
        case 'queryInventory': {
          const list = (
            Array.isArray(d.records)
              ? d.records
              : Array.isArray(d.list)
                ? d.list
                : []
          ) as Array<Record<string, unknown>>;
          if (list.length === 0) {
            parts.push('未查询到相关库存记录。');
          } else {
            for (const it of list) {
              const name = toText(it.skuName) || '商品';
              const qty = formatInventoryQty(
                it.availableQty ?? it.physicalQty ?? it.totalQty,
                {
                  boxRatio: it.boxRatio,
                  boxUnit: it.boxUnit,
                  baseUnit: it.baseUnit,
                },
              );
              const store = toText(it.storeName);
              parts.push(
                store
                  ? `现在${name}的库存有${qty}（${store}）`
                  : `现在${name}的库存有${qty}`,
              );
            }
          }
          break;
        }
        case 'queryReceivables': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(`应收账款查询完成，共 ${list.length} 条记录。`);
          break;
        }
        case 'queryPayables': {
          const list = Array.isArray(d.list) ? d.list : [];
          parts.push(`应付账款查询完成，共 ${list.length} 条记录。`);
          break;
        }
        default: {
          if (tr.tool.startsWith('api_')) {
            // 写操作精调工具：结构化成功总结；目录查询工具：通用总结
            parts.push(
              buildWriteSummary(tr.tool, d) ?? buildApiToolSummary(tr.tool, d),
            );
          } else {
            parts.push(`「${tr.tool}」执行完成。`);
          }
        }
      }
    }
    return parts.join('\n');
  }
}
