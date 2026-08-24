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
import { Injectable, Logger } from '@nestjs/common';
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
import { BUILTIN_GRAPHS, GraphDefinition } from './graph.types';

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
  | { type: 'graph_done'; graphId: string }
  | { type: 'error'; message: string };

@Injectable()
export class GraphExecutorService {
  private readonly logger = new Logger(GraphExecutorService.name);

  constructor(
    private readonly executor: ToolExecutor,
    private readonly checkpointer: CheckpointerService,
    private readonly registry: ToolRegistry,
    private readonly reviewTaskService: ReviewTaskService,
    private readonly evidence: EvidenceLedgerService,
  ) {}

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
      if (state.status === 'paused' && state.pendingReviewId) {
        let review;
        try {
          review = await this.reviewTaskService.get(state.pendingReviewId);
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
        this.logger.log(
          `图 ${graph.id} 人工审核通过，继续执行：node=${state.currentNodeId}`,
        );
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
            const toolRisk = tool?.risk ?? 'low';
            const needsReview =
              node.needsReview || tool?.needsReview || toolRisk === 'high';
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
              state.history.push({
                nodeId: node.id,
                label: node.label,
                success: true,
              });
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
            const result = await this.executor.executeToolCall(
              toolCall,
              toolContext,
            );
            // C10 证据优先（P0-7）：写操作账本 + 呈现前核查
            if (node.tool) {
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
            const systemPrompt =
              node.agent?.systemPrompt ??
              node.prompt ??
              `你是「${node.label}」域的专家 Agent。`;
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
}
