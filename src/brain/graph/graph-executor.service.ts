/**
 * GraphExecutorService — 有状态图执行引擎（完善度 P0-1/P0-2）
 *
 * 职责：
 * 1. 按图定义从入口节点顺序执行（tool / condition / agent / end）
 * 2. 工具节点复用 ToolExecutor（含写操作确认/审计链路）
 * 3. 每步经 Checkpointer 持久化状态（tenantId+sessionId），支持断点续跑
 * 4. 产出 SSE 事件流（node_start/node_end/tool_start/tool_result/text/graph_done/error）
 *
 * 当前边界（P0 骨架）：
 * - 工具节点参数为图定义静态 args（真实任务参数解析由后续 agent 节点完善）
 * - agent 节点为 LLM 单轮生成（多 Agent 协作后续扩展）
 * - needsReview 人工闸钩子预留（P0-4 对接审核流程）
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-1 Orchestrator graph 模式 / P0-2 Checkpointer
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ToolExecutor } from '../../tools/tool-executor';
import { ToolRegistry } from '../../tools/tool-registry';
import type { ToolCall } from '../../providers/provider.interface';
import type {
  ChatMessage,
  IModelProvider,
  ToolDefinition,
} from '../../providers/provider.interface';
import type { ToolContext, ToolResult } from '../../tools/tool.interface';
import { CheckpointerService } from './checkpointer.service';
import { ReviewTaskService } from '../review/review-task.service';
import { EvidenceLedgerService } from '../evidence/evidence-ledger.service';
import { ConfirmationService } from '../confirmation.service';
import { KnowledgeRulesService } from '../knowledge-rules.service';
import {
  BUILTIN_GRAPHS,
  GraphDefinition,
  LEGAL_TOOL_CATEGORIES,
} from './graph.types';

/** 图执行安全上限（防死循环） */
const MAX_NODE_STEPS = 50;

/** 图执行事件（对齐 Orchestrator SSE 风格） */
export type GraphRunEvent =
  | { type: 'node_start'; nodeId: string; label: string }
  | { type: 'node_end'; nodeId: string; label: string; success: boolean }
  | { type: 'tool_start'; tool: string }
  | {
      type: 'tool_result';
      tool: string;
      success: boolean;
      data?: unknown;
      error?: string;
    }
  | { type: 'text'; content: string }
  | {
      type: 'review_required';
      reviewId: number;
      tool: string;
      note: string;
      payload?: Record<string, unknown>;
    }
  | {
      type: 'pending_write';
      token: string;
      preview: ToolResult['preview'];
      writeType: string;
      expireAt: number;
    }
  | { type: 'await_confirm'; token: string; expireAt: number }
  | { type: 'graph_done'; graphId: string }
  | { type: 'error'; message: string };

@Injectable()
export class GraphExecutorService implements OnModuleInit {
  private readonly logger = new Logger(GraphExecutorService.name);

  constructor(
    private readonly executor: ToolExecutor,
    private readonly checkpointer: CheckpointerService,
    private readonly registry: ToolRegistry,
    private readonly reviewTaskService: ReviewTaskService,
    private readonly evidence: EvidenceLedgerService,
    private readonly knowledgeRules: KnowledgeRulesService,
    private readonly confirmationService: ConfirmationService,
  ) {}

  /**
   * 启动期校验内置图的 categories 声明（P3 修复 2026-10-04）：
   * 拼错的业务域会让 getRulesContext 静默返回 undefined，规则注入悄悄失效
   * 且无任何告警——启动时 warn 一次，让配置错误可见。
   */
  onModuleInit(): void {
    for (const graph of Object.values(BUILTIN_GRAPHS)) {
      for (const c of graph.categories ?? []) {
        if (!LEGAL_TOOL_CATEGORIES.has(c)) {
          this.logger.warn(
            `内置图 ${graph.id} 声明了非法业务域 "${c}"（不在 ToolCategory 枚举内），该域规则注入将静默失效`,
          );
        }
      }
    }
  }

  /**
   * 获取内置图（未知返回 null）
   */
  getGraph(graphId: string): GraphDefinition | null {
    return BUILTIN_GRAPHS[graphId] ?? null;
  }

  /**
   * 列出内置图（管理接口用）
   */
  listGraphs(): GraphDefinition[] {
    return Object.values(BUILTIN_GRAPHS);
  }

  /**
   * 执行有状态图（支持断点续跑）
   *
   * @param graph 图定义
   * @param sessionId 会话 ID
   * @param toolContext 工具上下文（tenantId/userId/authToken）
   * @param provider agent 节点用（可选，缺省时 agent 节点降级为直接跳转）
   */
  async *execute(
    graph: GraphDefinition,
    sessionId: string,
    toolContext: ToolContext,
    provider?: IModelProvider,
  ): AsyncGenerator<GraphRunEvent> {
    // 1. 恢复或初始化图状态
    let state =
      (await this.checkpointer.load(toolContext.tenantId, sessionId)) ?? null;
    if (!state || state.graphId !== graph.id || state.status === 'done') {
      state = {
        graphId: graph.id,
        tenantId: toolContext.tenantId,
        sessionId,
        currentNodeId: graph.entry,
        status: 'running',
        results: {},
        nodeOrder: [],
        history: [],
        updatedAt: Date.now(),
      };
    } else {
      this.logger.log(
        `图 ${graph.id} 从断点续跑：session=${sessionId} node=${state.currentNodeId}`,
      );
      // P0-4：暂停态先查审核结果（approved 续跑 / pending 等待 / rejected 终止）
      // P1 修复（2026-10-04）：带租户条件——工单归属租户校验
      if (state.status === 'paused' && state.pendingReviewId) {
        let review;
        try {
          review = await this.reviewTaskService.get(
            state.pendingReviewId,
            toolContext.tenantId,
          );
        } catch {
          review = null;
        }
        if (!review || review.status === 'pending') {
          yield {
            type: 'review_required',
            reviewId: state.pendingReviewId,
            tool: '待审工单',
            note: '等待人工审核，请审批后重试',
          };
          return;
        }
        if (review.status === 'rejected') {
          state.status = 'error';
          state.error = `人工审核已驳回：${review.rejectReason ?? '未说明原因'}`;
          await this.checkpointer.save(state);
          yield { type: 'error', message: state.error };
          return;
        }
        // approved：恢复运行
        state.status = 'running';
        state.pendingReviewId = undefined;
        // P1 修复（2026-10-04）：登记已放行节点——审核通过=人工批准执行，
        // 续跑时跳过闸（否则重新建单→暂停→死循环）并以 allowConfirm 真执行
        state.approvedNodeIds = [
          ...(state.approvedNodeIds ?? []),
          state.currentNodeId,
        ];
        this.logger.log(
          `图 ${graph.id} 人工审核通过，继续执行：node=${state.currentNodeId}`,
        );
      }

      // P1 修复（2026-10-04）：写操作确认挂起的续跑分支——
      // 检查 WriteGuard 令牌状态：confirmed=写已执行（取回执行结果标记节点
      // 完成并推进）；pending=仍在等待（重新下发确认事件）；其余（取消/
      // 过期/记录丢失）按节点失败终止图。
      const resume = state;
      if (resume.status === 'paused' && resume.pendingWriteToken) {
        const writeToken = resume.pendingWriteToken;
        const write = await this.confirmationService.getByTenant(
          writeToken,
          toolContext.tenantId,
        );
        if (!write) {
          state.status = 'error';
          resume.pendingWriteToken = undefined;
          resume.error = '写操作确认已失效（令牌过期或已删除），图执行终止';
          await this.checkpointer.save(resume);
          yield { type: 'error', message: resume.error };
          return;
        }
        if (write.status === 'pending') {
          await this.checkpointer.save(resume);
          yield {
            type: 'await_confirm',
            token: writeToken,
            expireAt: write.expiresAt,
          };
          return;
        }
        if (write.status === 'cancelled') {
          resume.status = 'error';
          resume.pendingWriteToken = undefined;
          resume.error = '写操作已被用户取消，图执行终止';
          await this.checkpointer.save(resume);
          yield { type: 'error', message: resume.error };
          return;
        }
        // confirmed：写已由确认端点真执行——回填节点产物并推进
        resume.pendingWriteToken = undefined;
        const executed = this.confirmationService.getExecutedByConfirmation(
          writeToken,
          toolContext.tenantId,
        );
        const writeNode = graph.nodes.find(
          (n) => n.id === resume.currentNodeId,
        );
        resume.results[resume.currentNodeId] = executed?.result ?? {
          confirmedExecuted: true,
        };
        resume.history.push({
          nodeId: resume.currentNodeId,
          label: writeNode?.label ?? resume.currentNodeId,
          success: true,
        });
        this.logger.log(
          `图 ${graph.id} 写操作确认已完成，节点续跑：node=${resume.currentNodeId}${executed ? '' : '（执行结果已随撤销窗口过期，产物以占位标记）'}`,
        );
        resume.status = 'running';
        resume.currentNodeId = writeNode?.next ?? 'end';
        await this.checkpointer.save(resume);
      }
    }

    let steps = 0;
    while (steps < MAX_NODE_STEPS) {
      steps += 1;
      const node = graph.nodes.find((n) => n.id === state.currentNodeId);
      if (!node) {
        yield {
          type: 'error',
          message: `图节点不存在：${state.currentNodeId}`,
        };
        await this.checkpointer.clear(toolContext.tenantId, sessionId);
        return;
      }

      yield { type: 'node_start', nodeId: node.id, label: node.label };
      state.nodeOrder.push(node.id);

      try {
        switch (node.type) {
          case 'end': {
            state.status = 'done';
            state.history.push({
              nodeId: node.id,
              label: node.label,
              success: true,
            });
            yield {
              type: 'node_end',
              nodeId: node.id,
              label: node.label,
              success: true,
            };
            yield { type: 'graph_done', graphId: graph.id };
            // 完成后清除检查点，避免脏状态
            await this.checkpointer.clear(toolContext.tenantId, sessionId);
            return;
          }

          case 'tool': {
            if (!node.tool) {
              throw new Error(`工具节点缺少 tool 名：${node.id}`);
            }
            // P0-5/P0-4：工具风险 high 或节点显式 needsReview → 人工闸
            const tool = this.registry.get(node.tool);
            // P1 修复（2026-10-04）：默认与 chat/MCP 通道对齐为 medium（此前 low 更宽松）
            const toolRisk = tool?.risk ?? 'medium';
            const approvedByReview = (state.approvedNodeIds ?? []).includes(
              node.id,
            );
            const needsReview =
              !approvedByReview &&
              (node.needsReview || tool?.needsReview || toolRisk === 'high');
            if (needsReview) {
              const review = await this.reviewTaskService.create({
                tenantId: toolContext.tenantId,
                sessionId,
                graphId: graph.id,
                nodeId: node.id,
                toolName: node.tool,
                payload: node.reviewPayload ?? {
                  nodeLabel: node.label,
                  args: node.args ?? {},
                  reviewNote: node.reviewNote,
                },
                createdBy: toolContext.userId,
              });
              state.status = 'paused';
              state.pendingReviewId = review.id;
              // P2 顺手改（验收意见）：挂起不写 history——中性标记，
              // 节点成败由执行后的真实结果入史（success:true/false 都是误导）
              await this.checkpointer.save(state);
              yield {
                type: 'review_required',
                reviewId: review.id,
                tool: node.tool,
                note: node.reviewNote ?? `「${node.label}」需要人工审核`,
                payload: review.payload ?? undefined,
              };
              return;
            }
            const toolCall: ToolCall = {
              id: `graph_${node.id}_${Date.now()}`,
              type: 'function',
              function: {
                name: node.tool,
                arguments: JSON.stringify(node.args ?? {}),
              },
            };
            yield { type: 'tool_start', tool: node.tool };
            // P2 修复（2026-10-04）：与 chat 通道同口径的超时闸门——
            // 此前直接 await，卡死的工具会无限挂起图执行与 SSE 流，
            // checkpointer 永远停在 running
            // P1 修复（2026-10-04）：审核放行的节点带 allowConfirm 真执行
            // （审核=人工确认；否则 confirm 门强制降级 preview，写永不落地）
            const result = approvedByReview
              ? await this.executor.executeToolCall(toolCall, toolContext, {
                  allowConfirm: true,
                })
              : await this.executeToolWithTimeout(toolCall, toolContext);
            // P1 修复（2026-10-04）：写工具返回 preview（confirm 门强制降级，
            // 未真执行）→ 挂 WriteGuard 确认并暂停图——此前 preview 被当作
            // "节点成功"继续跑到 graph_done，业务单据根本没创建且无确认入口
            if (tool?.isWriteOperation && result.success && result.preview) {
              const write = await this.confirmationService.create({
                tenantId: toolContext.tenantId,
                conversationId: sessionId,
                toolName: node.tool,
                risk: toolRisk,
                args: node.args ?? {},
                preview: result.preview,
                operationLabel: `图「${graph.name}」节点「${node.label}」`,
              });
              state.status = 'paused';
              state.pendingWriteToken = write.confirmationId;
              // P2 顺手改（验收意见）：挂起不写 history——awaiting 状态既非
              // 成功也非失败，节点结果由确认续跑回填后再入史
              await this.checkpointer.save(state);
              const expireAt = Date.now() + 24 * 60 * 60 * 1000;
              yield {
                type: 'pending_write',
                token: write.confirmationId,
                preview: result.preview,
                writeType: node.tool,
                expireAt,
              };
              yield {
                type: 'await_confirm',
                token: write.confirmationId,
                expireAt,
              };
              return;
            }
            // C10 证据优先（P0-7）：写操作账本 + 呈现前核查
            // P2 修复（2026-10-04）：与 chat 通道口径对齐——仅写工具、非
            // preview、执行成功才记台账（此前只读查询/失败调用/预览都会
            // 打 is_write_operation=true，污染证据台账的撤销/追责溯源）
            if (
              node.tool &&
              this.isWriteTool(node.tool) &&
              !result.preview &&
              result.success
            ) {
              this.evidence.recordWrite(
                toolContext,
                node.tool,
                node.args ?? {},
                result,
              );
              const verification = this.evidence.verify(result);
              if (!verification.ok) {
                this.logger.warn(
                  `图节点 ${node.id} 证据核查：${verification.issues.join('；')}`,
                );
              }
            }
            state.results[node.id] = result.data;
            state.history.push({
              nodeId: node.id,
              label: node.label,
              success: result.success,
            });
            yield {
              type: 'tool_result',
              tool: node.tool,
              success: result.success,
              data: result.data,
              error: result.error,
            };
            yield {
              type: 'node_end',
              nodeId: node.id,
              label: node.label,
              success: result.success,
            };
            if (!result.success) {
              state.status = 'error';
              state.error = result.error ?? '工具执行失败';
              await this.checkpointer.save(state);
              yield { type: 'error', message: state.error };
              return;
            }
            state.currentNodeId = node.next ?? 'end';
            break;
          }

          case 'condition': {
            const next = node.condition ? node.condition(state) : undefined;
            state.history.push({
              nodeId: node.id,
              label: node.label,
              success: true,
            });
            yield {
              type: 'node_end',
              nodeId: node.id,
              label: node.label,
              success: true,
            };
            state.currentNodeId = next ?? node.next ?? 'end';
            break;
          }

          case 'agent': {
            // P0-3 多 Agent 协作：域 Agent 节点 = 带工具白名单的小型 Agent Loop
            if (!provider) {
              state.currentNodeId = node.next ?? 'end';
              yield {
                type: 'node_end',
                nodeId: node.id,
                label: node.label,
                success: true,
              };
              break;
            }

            // 1. 组装系统提示（域 Agent 职责 + 当前图状态产物）
            // 统一编排器（2026-10-03）：agent 节点系统提示追加图业务域规则，
            // 与 chat/agent 通道同源（KnowledgeRulesService），三通道规则注入齐平。
            const basePrompt =
              node.agent?.systemPrompt ??
              node.prompt ??
              `你是「${node.label}」域的专家 Agent。`;
            const graphRules = this.knowledgeRules.getRulesContext(
              graph.categories,
            );
            const systemPrompt = graphRules
              ? `${basePrompt}\n\n以下是本业务域的权威规则，执行时必须遵守：\n${graphRules}`
              : basePrompt;
            const agentMessages: ChatMessage[] = [
              {
                role: 'system',
                content: systemPrompt,
              },
              {
                role: 'user',
                content: `请基于当前图状态产物完成本节点任务：${JSON.stringify(
                  state.results,
                ).slice(0, 2000)}`,
              },
            ];

            // 2. 工具白名单定义（agent.tools 未配置则仅文本生成）
            let agentTools: ToolDefinition[] | undefined;
            if (node.agent?.tools && node.agent.tools.length > 0) {
              agentTools = this.registry
                .toToolDefinitions()
                .filter((d) => node.agent!.tools!.includes(d.function.name));
              const unknown = node.agent.tools.filter(
                (name) => !this.registry.has(name),
              );
              if (unknown.length > 0) {
                this.logger.warn(
                  `agent 节点 ${node.id} 工具白名单包含未注册工具：${unknown.join(', ')}`,
                );
              }
            }

            // 3. 节点内 Agent Loop（≤ maxToolRounds 轮）
            const maxRounds = node.agent?.maxToolRounds ?? 3;
            let agentText = '';
            const nodeToolResults: ToolResult[] = [];
            for (let round = 0; round < maxRounds; round += 1) {
              const generator = provider.chat(agentMessages, {
                tools: agentTools,
              });
              let roundText = '';
              let chatResult:
                | { tool_calls?: ChatMessage['tool_calls']; content?: string }
                | undefined;
              // 手动迭代：done=true 时 value 为 ChatResult（含 tool_calls/usage）
              for (;;) {
                const { value, done } = await generator.next();
                if (done) {
                  chatResult = value;
                  break;
                }
                roundText += value;
                yield { type: 'text', content: value };
              }
              agentText += roundText;

              if (chatResult?.content) {
                agentText = chatResult.content;
              }
              if (
                !chatResult?.tool_calls ||
                chatResult.tool_calls.length === 0
              ) {
                break;
              }

              // 4. 执行工具调用并追加结果到上下文
              const toolMessages = await this.executor.executeToolCalls(
                chatResult.tool_calls,
                toolContext,
              );
              for (const m of toolMessages) {
                const parsed = this.tryParseToolMessage(m);
                if (parsed) nodeToolResults.push(parsed);
                yield {
                  type: 'tool_result',
                  tool: m.tool_call_id ?? 'agent_tool',
                  success: parsed?.success ?? true,
                  data: parsed?.data,
                  error: parsed?.error,
                };
              }
              agentMessages.push(
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: chatResult.tool_calls,
                },
                ...toolMessages,
              );
            }

            // 5. 产物入状态（文本 + 工具结果）
            state.results[node.id] = {
              text: agentText,
              toolResults: nodeToolResults,
            };
            state.history.push({
              nodeId: node.id,
              label: node.label,
              success: true,
            });
            yield {
              type: 'node_end',
              nodeId: node.id,
              label: node.label,
              success: true,
            };
            state.currentNodeId = node.next ?? 'end';
            break;
          }

          default:
            throw new Error(
              `未知图节点类型：${(node as { type: string }).type}`,
            );
        }
      } catch (err) {
        state.status = 'error';
        state.error = err instanceof Error ? err.message : String(err);
        await this.checkpointer.save(state);
        yield { type: 'error', message: state.error };
        return;
      }

      // 每步持久化（断点续跑）
      await this.checkpointer.save(state);
    }

    state.status = 'error';
    state.error = `图执行超过 ${MAX_NODE_STEPS} 步（疑似死循环）`;
    await this.checkpointer.save(state);
    yield { type: 'error', message: state.error };
  }

  /** 解析 tool 角色消息中的 ToolResult（供事件与产物收集） */
  private tryParseToolMessage(message: ChatMessage): ToolResult | null {
    if (message.role !== 'tool' || !message.content) return null;
    try {
      return JSON.parse(message.content) as ToolResult;
    } catch {
      return null;
    }
  }

  /**
   * 工具执行超时闸门（P2 修复 2026-10-04，与 chat 通道同口径）：
   * TOOL_TIMEOUT_MS（默认 60s）超时按失败落账，防卡死工具无限挂起图执行。
   */
  private async executeToolWithTimeout(
    toolCall: ToolCall,
    toolContext: ToolContext,
  ): Promise<ToolResult> {
    // P0 修复（2026-10-06 验收返工）：env 非数字/空串三重守卫——
    // `Number("60s")=NaN` 时 setTimeout 按 1ms 触发（全站工具即时超时）；
    // 空串更隐蔽（`?? 60000` 只兜 null/undefined，`Number("")=0` 同样归零）。
    // 模式与 employee.service.ts 的 MAX_DISPATCH_DEPTH 守卫一致。
    const parsedTimeout = Number.parseInt(
      String(process.env.TOOL_TIMEOUT_MS ?? '60000').trim(),
      10,
    );
    const timeoutMs =
      Number.isFinite(parsedTimeout) && parsedTimeout > 0
        ? parsedTimeout
        : 60000;
    return await Promise.race([
      this.executor.executeToolCall(toolCall, toolContext),
      new Promise<ToolResult>((resolve) => {
        const timer = setTimeout(
          () =>
            resolve({
              success: false,
              error: `工具执行超时（${timeoutMs}ms），已中止图节点`,
            }),
          timeoutMs,
        );
        // 超时是兜底路径：正常完成时不让 timer 挂住进程/测试退出
        timer.unref?.();
      }),
    ]);
  }

  /** 是否写操作工具（证据台账只记写操作，与 chat 通道口径对齐） */
  private isWriteTool(toolName: string): boolean {
    return this.registry.get(toolName)?.isWriteOperation === true;
  }
}
