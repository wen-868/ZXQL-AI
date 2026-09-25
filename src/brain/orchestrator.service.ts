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
 *   - { type: 'plan_start', steps: [...] }         — G-A 复杂目标规划完成（步骤列表）
 *   - { type: 'plan_step', index, total, label, status } — G-A 计划步骤完成进度
 *   - { type: 'reflection', tool, action:'retry', recovered } — G-C 失败自动重试
 *   - { type: 'task_artifact', tool, artifact }    — G-B 任务产物（文件/链接）
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
import { ConfigService } from '@nestjs/config';
import { ToolExecutor } from '../tools/tool-executor';
import { ToolRegistry } from '../tools/tool-registry';
import { AuditLogger } from '../bridge/audit-logger';
import { AiConfigService } from '../tenant/ai-config.service';
import { TenantContext } from '../tenant/tenant-context';
import { detectTone, toneDirective } from '../nlp/tone-detector';
import { KnowledgeRulesService } from './knowledge-rules.service';
import { EvidenceLedgerService } from './evidence/evidence-ledger.service';
import { EmployeeService } from './employee/employee.service';
import {
  isComplexGoal,
  matchPlanStepsByTool,
  stepsToPlanContext,
} from './chat-planning';
import { PlannerService } from './agent/planner.service';
import type { PlanStep } from './agent/agent.types';
import { LongTermMemoryService } from './memory/long-term-memory.service';
import { ContextBuilder } from './context-builder.service';
import { MemoryManager } from './memory-manager.service';
import { ConfirmationService } from './confirmation.service';
import { StructuredExtractor } from './extraction/structured-extractor';
import { CaptureService } from '../evolution/capture.service';
import { MetricsService } from '../common/metrics.service';
import { BillingService } from '../tenant/billing.service';
import { AnswerSelfCheckService } from './answer-self-check.service';
import { WRITE_TOKEN_TTL_MS } from './write-guard.service';
import type { ChatMessage, ToolCall } from '../providers/provider.interface';
import type {
  ToolCategory,
  ToolContext,
  ToolResult,
} from '../tools/tool.interface';
import { GraphExecutorService } from './graph/graph-executor.service';
import {
  ChatResultWithFallback,
  FallbackMeta,
  ProviderRouterService,
} from './router/provider-router.service';
import { LearningService } from './learning/learning.service';
import { formatInventoryQty } from './inventory-format';
import { buildApiToolSummary } from './api-summary';
import { buildWriteSummary } from './write-summary';
import {
  buildLlmClassifierPrompt,
  resolveIntentCategories,
} from './intent-detector';
import { resolveReference } from '../nlp/reference-resolver';

/**
 * Agent Loop 最大迭代次数（防止死循环）
 *
 * 14 = MAX_PLAN_STEPS(12) + 规划首轮 + 总结轮：G-A 引入主链路规划后，
 * 复杂目标最多 12 步，上限必须 ≥ 步数否则多步计划会中途撞 AI_009。
 */
const MAX_ITERATIONS = 14;

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
      /**
       * A7 文档 12.1：写意图被挂起（写全审核）——返回预览+令牌，
       * 等待前端回传 /confirm。与 tool_result.preview 配套（兼容现有前端）。
       */
      type: 'pending_write';
      token: string;
      preview?: ToolResult['preview'];
      writeType: string;
      expireAt: number;
    }
  | {
      /** A7 文档 12.1：写令牌已生成/刷新，前端据此弹确认框并倒计时 */
      type: 'await_confirm';
      token: string;
      expireAt: number;
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
  | {
      type: 'error';
      message: string;
      /** A3 文档 11.5：标准错误码（如 AI_009） */
      code?: string;
    }
  | {
      /**
       * G-A（2026-09-05 参考架构对照）：复杂目标规划完成——
       * steps 为拆解后的步骤列表（前端可展示"第 N 步/共 M 步"进度）。
       */
      type: 'plan_start';
      steps: Array<{ id: string; label: string; tool: string | null }>;
    }
  | {
      /** G-A：计划步骤完成（工具命中该步骤时下发，status=done） */
      type: 'plan_step';
      index: number;
      total: number;
      label: string;
      status: 'done';
    }
  | {
      /**
       * G-C：工具失败自动重试（Reflection 显式化）——
       * retry 前发一次（recovered=false），重试后再发一次携带结果。
       */
      type: 'reflection';
      tool: string;
      action: 'retry';
      recovered: boolean;
    }
  | {
      /**
       * G-B：任务产物（文件/链接）——工具结果 data.artifact 透传，
       * 前端渲染可下载/可预览的产物卡片（Final Answer 之外的 Task 出口）。
       */
      type: 'task_artifact';
      tool: string;
      artifact: Record<string, unknown>;
    };

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
  /** 客户 ID（可选，运营客户端 customerScope 隔离：role=customer 时必填） */
  customerId?: string;
  /** 数字员工 UID（可选：本次执行以某数字员工身份运行——人设/工具子集/记忆/审计按员工隔离） */
  employeeUid?: string;
  /** 派发深度（可选：数字员工链式派发的嵌套层数，0=用户直接发起） */
  dispatchDepth?: number;
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
    private readonly metrics: MetricsService,
    private readonly billing: BillingService,
    private readonly configService: ConfigService,
    private readonly selfCheck: AnswerSelfCheckService,
    private readonly knowledgeRules: KnowledgeRulesService,
    private readonly evidence: EvidenceLedgerService,
    private readonly employeeService: EmployeeService,
    private readonly planner: PlannerService,
    private readonly ltm: LongTermMemoryService,
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
    const customerId = params.customerId ?? ctxData?.customerId;
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
        customerId,
      );
      if (history.length > 0) {
        this.logger.debug(`加载对话历史：${history.length} 条消息`);
      }

      // ── 3.5 S-G2 自动纠错捕获（进化飞轮输入端，2026-09-05 智能达标审计补全）──
      // 用户指出 AI 上轮答错（"不对/错了/应该是…"）时，把"上轮回答 + 本轮纠正"
      // 存为纠正样本入 ai_db → 萃取 → E5 回归 → few-shot 回流，闭环不再依赖
      // 人工去管理端点录入。误报由萃取层兜底（无改善价值的样本萃取不出来）。
      const prevAssistant = [...history]
        .reverse()
        .find((m) => m.role === 'assistant' && m.content);
      if (
        prevAssistant?.content &&
        /(不对|错了|搞错|说错|重查|应该是)/.test(params.message) &&
        this.configService.get<string>(
          'ENABLE_AUTO_CORRECTION_CAPTURE',
          'true',
        ) === 'true'
      ) {
        try {
          await this.capture.captureCorrection({
            tenantId,
            taskType: 'dialog_correction',
            wrongPayload: {
              answer: String(prevAssistant.content).slice(0, 1000),
            },
            rightPayload: { userCorrection: params.message.slice(0, 500) },
            reason: '对话中用户主动纠错（自动捕获）',
          });
          this.logger.log(`自动纠错已捕获：tenant=${tenantId}`);
        } catch (err) {
          this.logger.warn(
            `自动纠错捕获失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── 3.8 数字员工维度（2026-09-05 MVP）：以员工身份运行时，
      // 人设/工具子集/记忆/审计按员工隔离——岗位即预分诊，跳过 LLM 分诊 ──
      let employee = null;
      let employeePersona: string | null = null;
      if (params.employeeUid) {
        employee = await this.employeeService.getByUid(
          params.employeeUid,
          tenantId,
        );
        if (!employee || employee.status !== 1) {
          yield {
            type: 'error',
            code: 'AI_001',
            message: `数字员工不存在或已停用：${params.employeeUid}`,
          };
          return;
        }
        employeePersona = employee.personaPrompt;
        this.logger.log(
          `数字员工执行：${employee.name}（${employee.post}）tenant=${tenantId}`,
        );
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

      // ── 4. 意图分诊双通道（先于上下文构建：G1 业务规则注入依赖分诊结果）──
      // 关键词快车道 + LLM 分诊兜底，新话术不再回退全量慢车道；用指代消解后的消息。
      // 辅助调用 token 全部计入用量与计费（#3：此前三处 chatSync 的 token 少报）
      // 数字员工运行：岗位工具子集即预分诊，跳过 LLM 分诊（省一次调用）
      let auxPromptTokens = 0;
      let auxCompletionTokens = 0;
      const intent = employee
        ? {
            categories: (employee.toolCategories ?? undefined) as
              ToolCategory[] | undefined,
            lane: 'rules' as const,
          }
        : await resolveIntentCategories(userMessage, async (msg) => {
            const prompt = buildLlmClassifierPrompt(msg);
            const res = await provider.chatSync(
              [{ role: 'user', content: prompt }],
              { temperature: 0, max_tokens: 100 },
            );
            auxPromptTokens += res.prompt_tokens ?? 0;
            auxCompletionTokens += res.completion_tokens ?? 0;
            const content = res.content?.trim() ?? '';
            const match = content.match(/\[[\s\S]*\]/);
            if (!match) return null;
            try {
              return JSON.parse(match[0]) as string[];
            } catch {
              return null;
            }
          });

      // ── 4.1 O7 规划先行启动（与分诊并行，2026-09-05 性能优化）──
      // 复杂目标时 Planner LLM 调用与意图分诊并发执行，省一次串行等待（约 1-2s）。
      // graph 模式自带图编排，不重复规划。
      const plannerEnabled =
        params.mode !== 'graph' &&
        this.configService.get<string>('ENABLE_CHAT_PLANNER', 'true') ===
          'true';
      const shouldPlan =
        plannerEnabled && isComplexGoal(userMessage) && intent.lane !== 'chat';
      const planPromise: Promise<PlanStep[]> = shouldPlan
        ? this.planner
            .plan({
              tenantId,
              goal: userMessage,
              model: params.model,
              scope: params.scope,
            })
            .catch((err) => {
              this.logger.warn(
                `G-A 规划失败（降级直跑）：${err instanceof Error ? err.message : String(err)}`,
              );
              return [];
            })
        : Promise.resolve([]);

      // ── 4.2 G1 业务规则：按意图分类取 knowledge/ 相关运营规则注入提示词 ──
      const rulesContext = this.knowledgeRules.getRulesContext(
        intent.categories,
      );

      // ── 4.3 G-A 复杂目标显式规划（Planner 进主链路，参考架构对照）──
      // 顺序连接词/并列动作 → PlannerService 拆步骤 → plan_start 事件（前端可展示
      // "第 N 步/共 M 步"）→ 计划注入系统提示词，ReAct 循环按步骤推进。
      let chatPlan: PlanStep[] = [];
      if (shouldPlan) {
        chatPlan = await planPromise;
        if (chatPlan.length > 0) {
          yield {
            type: 'plan_start',
            steps: chatPlan.map((s) => ({
              id: s.id,
              label: s.label,
              tool: s.tool ?? null,
            })),
          };
          this.logger.log(
            `G-A 复杂目标已规划：${chatPlan.length} 步（目标「${userMessage.slice(0, 30)}」）`,
          );
          this.metrics.recordPlan();
        }
      }
      const planContext = stepsToPlanContext(chatPlan);

      // O1 系统提示词工具清单瘦身：分诊命中域时只注入相关域工具描述；
      // O6 chat 车道（纯寒暄）注入空清单（零工具直答，省 2 万+ token/次）
      const allTools = this.registry.list();
      let promptTools =
        intent.lane === 'chat'
          ? []
          : intent.categories && intent.categories.length > 0
            ? allTools.filter((t) => intent.categories!.includes(t.category))
            : allTools;

      // ── 5. 构建上下文 ──
      // R70-21：build 已升级为异步（内部做 RAG 知识库检索注入，embedding 未配置时自动跳过）
      const messages = await this.contextBuilder.build(
        {
          tenantId,
          userId,
          role,
          customerId,
          userMessage,
          history,
          // 数字员工：岗位人设覆盖默认助手提示词，并附加员工身份
          systemPrompt:
            employeePersona ?? systemPrompt ?? undefined ?? undefined,
          employeeIdentity: employee
            ? {
                name: employee.name,
                post: employee.post,
                department: employee.department,
                replyStyle: employee.replyStyle ?? '',
                dispatchable: (employee.dispatchUids?.length ?? 0) > 0,
              }
            : undefined,
          // S4 语气适配：按用户语气注入节奏指令（急迫先结论/轻松简短/正式敬语）
          toneDirective: toneDirective(detectTone(userMessage)),
          // G1 业务规则：相关域运营规则（默认 RAG 关闭时规则也能进上下文）
          rulesContext,
          // G-A 执行计划：复杂目标拆解的步骤块
          planContext,
          // O1 系统提示词工具清单（分诊子集；O6 chat 车道为空）
          toolListForPrompt: promptTools,
        },
        this.registry,
      );

      // O6 chat 车道：零工具定义（LLM 直接回答，不进 function calling）
      let toolDefinitions =
        intent.lane === 'chat'
          ? []
          : this.registry.toToolDefinitionsForCategories(
              intent.categories,
              params.scope,
            );
      // 数字员工且有派发权：追加派发工具定义（system 类工具不在岗位子集内，
      // 但有下级的员工必须能看到自己的派发能力）
      if (employee && (employee.dispatchUids?.length ?? 0) > 0) {
        const dispatchMeta = this.registry
          .list()
          .find((t) => t.name === 'dispatchEmployeeTask');
        if (
          dispatchMeta &&
          !toolDefinitions.some(
            (d) => d.function.name === 'dispatchEmployeeTask',
          )
        ) {
          toolDefinitions = [
            ...toolDefinitions,
            {
              type: 'function' as const,
              function: {
                name: dispatchMeta.name,
                description: dispatchMeta.description,
                parameters: dispatchMeta.parameters,
              },
            },
          ];
          promptTools = [...promptTools, dispatchMeta];
        }
      }
      this.logger.debug(
        `意图分诊：lane=${intent.lane} 工具集=${toolDefinitions.length} 个 规则=${rulesContext ? '注入' : '无'}（消息「${params.message.slice(0, 20)}」）`,
      );

      // 构造工具执行上下文（数字员工运行时携带员工身份与派发深度）
      const toolContext: ToolContext = {
        tenantId,
        userId,
        sessionId: conversationId,
        role,
        customerId,
        authToken,
        employeeUid: params.employeeUid,
        dispatchDepth: params.dispatchDepth ?? 0,
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
      // G-A 计划步骤完成跟踪（plan_step 事件去重）
      const doneStepIds = new Set<string>();
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
      let fallbackUsed: FallbackMeta | undefined;

      for (; iteration < MAX_ITERATIONS; iteration++) {
        this.logger.debug(`Agent Loop 第 ${iteration + 1} 轮`);

        // 调用 LLM（流式 + P1-3 降级链：云端默认 → 本地 Ollama 兜底 → 备用云端）
        const generator = this.router.chatWithFallback(
          messages,
          {
            tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
            temperature: resolvedConfig.temperature,
            max_tokens: resolvedConfig.maxTokens,
          },
          {
            requestedModel: params.model,
            resolved: resolvedConfig,
            systemScope: this.router.getSystemScope(),
          },
        );

        // 消费流式生成器
        let chatResult: ChatResultWithFallback;
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
        // P1-3 降级可观测：记录本次降级信息供审计
        if (chatResult!.fallback?.used) {
          fallbackUsed = chatResult!.fallback;
          this.logger.warn(
            `Provider 降级：${fallbackUsed.from} → ${fallbackUsed.to}（${fallbackUsed.reason}，耗时 ${fallbackUsed.latencyMs}ms）`,
          );
        }

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

          let toolResult = await this.executeToolWithTimeout(tc, toolContext);

          // ── G-C Reflection 显式化：失败自动重试一次（仅只读工具）──
          // 查询类失败多为瞬时抖动，重试直接恢复；
          // 写操作（isWriteOperation）不自动重试：confirm=true 后服务端可能已
          // 实际执行（超时/响应丢失场景），重试有重复开单风险——写失败交给 LLM
          // 如实告知用户处理。reflection 事件供前端展示"已自动重试"。
          const toolMeta = this.registry.get(tc.function.name);
          if (
            !toolResult.success &&
            toolMeta?.isWriteOperation !== true &&
            this.configService.get<string>('ENABLE_TOOL_AUTO_RETRY', 'true') ===
              'true'
          ) {
            yield {
              type: 'reflection',
              tool: tc.function.name,
              action: 'retry',
              recovered: false,
            };
            const retried = await this.executeToolWithTimeout(tc, toolContext);
            if (retried.success) {
              toolResult = retried;
              this.logger.log(
                `G-C 工具失败已自动重试成功：${tc.function.name}`,
              );
            } else {
              this.logger.warn(
                `G-C 工具自动重试仍失败：${tc.function.name} err=${retried.error ?? '-'}`,
              );
            }
            this.metrics.recordToolRetry(toolResult.success);
            yield {
              type: 'reflection',
              tool: tc.function.name,
              action: 'retry',
              recovered: toolResult.success,
            };
          }

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
                customerId,
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

          // A7 文档 12.1：写意图挂起补充 pending_write + await_confirm 事件
          // （与 tool_result.preview 并存，兼容现有前端确认卡）
          if (confirmationId) {
            const expireAt = Date.now() + WRITE_TOKEN_TTL_MS;
            yield {
              type: 'pending_write',
              token: confirmationId,
              preview: toolResult.preview,
              writeType: tc.function.name,
              expireAt,
            };
            yield {
              type: 'await_confirm',
              token: confirmationId,
              expireAt,
            };
          }

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

          // C2 写操作逐笔证据台账（2026-09-05 能力补齐：EvidenceLedger 接入主链路，
          // 此前仅 graph 模式使用）：写工具经确认实际执行（非预览）时记录
          // 意图+参数+结果 → 审计留痕，供撤销/追责/评测溯源
          if (
            toolMeta?.isWriteOperation === true &&
            !toolResult.preview &&
            toolResult.success
          ) {
            try {
              this.evidence.recordWrite(
                toolContext,
                tc.function.name,
                execArgs,
                toolResult,
              );
            } catch (err) {
              this.logger.warn(
                `写台账记录失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // ── G-B Task 任务产物协议（2026-09-05 参考架构对照）──
          // 工具结果 data.artifact = {name, kind, url?, summary?} 时下发
          // task_artifact 事件（前端渲染可下载/可预览的产物卡片）。
          const maybeArtifact = (
            toolResult.data as
              { artifact?: Record<string, unknown> } | undefined
          )?.artifact;
          if (
            maybeArtifact &&
            typeof maybeArtifact === 'object' &&
            typeof (maybeArtifact as { name?: unknown }).name === 'string'
          ) {
            yield {
              type: 'task_artifact',
              tool: tc.function.name,
              artifact: maybeArtifact,
            };
          }

          // ── G-A plan_step 进度：工具命中计划步骤 → 标记该步完成 ──
          if (chatPlan.length > 0) {
            for (const idx of matchPlanStepsByTool(
              chatPlan,
              tc.function.name,
              doneStepIds,
            )) {
              yield {
                type: 'plan_step',
                index: idx,
                total: chatPlan.length,
                label: chatPlan[idx].label,
                status: 'done',
              };
            }
          }

          // 工具结果加入消息历史
          // O11 瘦身：剔除 null/undefined 字段（如库存行的 boxRatio:null 等，
          // 对 LLM 无信息量），下一轮 prompt 与后续轮历史都省 token
          const toolMsg: ChatMessage = {
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify(toolResult, (_k, v) =>
              v === null || v === undefined ? undefined : v,
            ),
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
        // B7 文档 11.5 AI_009：循环超限向前端下发明确错误事件
        yield {
          type: 'error',
          code: 'AI_009',
          message: `Agent 循环超过 ${MAX_ITERATIONS} 轮上限，已强制终止；请简化请求或检查工具定义`,
        };
      }

      // ── 5.5 兜底总结：模型未输出任何文本但执行过工具时，用工具结果生成摘要 ──
      // 解决模型在工具调用后直接结束（无总结文本）导致前端只显示工具 JSON 的问题
      let fallbackSummary = '';
      if (finalAssistantText.trim().length === 0 && toolResults.length > 0) {
        fallbackSummary = this.buildFallbackSummary(toolResults);
        yield { type: 'text', content: fallbackSummary };
        // 将兜底摘要写入最后一条 assistant 消息（供对话历史保存）
        for (let i = newMessagesToSave.length - 1; i >= 0; i--) {
          const m = newMessagesToSave[i];
          if (m.role === 'assistant' && !m.content) {
            m.content = fallbackSummary;
            break;
          }
        }
      }

      // ── 5.7 S2 回答自检（细化：独立服务+指标，见 answer-self-check.service）──
      // 性能门槛（O12）：短答案（< 自检最小长度，默认 60 字符）跳过——单事实句
      // 幻觉空间小，省一次串行 LLM 调用（约 1-1.5s）；长多数据回答仍全检。
      const answerForCheck = finalAssistantText.trim() || fallbackSummary;
      const selfCheckMinChars = Number(
        this.configService.get<number>('SELF_CHECK_MIN_CHARS', 60),
      );
      if (
        this.configService.get<string>('ENABLE_ANSWER_SELF_CHECK', 'true') ===
          'true' &&
        answerForCheck.length >= selfCheckMinChars
      ) {
        const fix = await this.selfCheck.verify(
          (prompt) =>
            provider
              .chatSync([{ role: 'user', content: prompt }], {
                temperature: 0,
                max_tokens: 200,
              })
              .then((r) => {
                // #3 辅助调用 token 计入用量与计费
                auxPromptTokens += r.prompt_tokens ?? 0;
                auxCompletionTokens += r.completion_tokens ?? 0;
                return r.content ?? '';
              }),
          toolResults,
          answerForCheck,
        );
        if (fix && fix.ok === false && fix.correction) {
          const note = `\n\n⚠ 数字自检更正：${fix.correction}`;
          yield { type: 'text', content: note };
          // 更正并入历史最后一条 assistant 消息，保持上下文一致
          for (let i = newMessagesToSave.length - 1; i >= 0; i--) {
            const m = newMessagesToSave[i];
            if (m.role === 'assistant' && m.content) {
              m.content += note;
              break;
            }
          }
          finalAssistantText += note;
        }
      }

      // ── 5.9 G-D 偏好自动沉淀（参考架构对照：Memory 长期记忆写入端）──
      // 用户表达稳定偏好（"记住/以后都/我喜欢/别再"）时，LLM 提炼一条档案写入
      // LTM —— S1 人格一致性从此有米下锅。仅在有 userId 时执行（偏好按人存）。
      // #6 触发词收紧：去掉裸"以后"（"以后价格会变吗"类疑问不再误触发）。
      if (
        userId &&
        this.configService.get<string>('ENABLE_PREFERENCE_DISTILL', 'true') ===
          'true' &&
        /(记住|帮我记住|以后都|以后请|以后固定|以后直接|我喜欢|我不喜欢|别再)/.test(
          params.message,
        )
      ) {
        try {
          const prefRes = await provider.chatSync(
            [
              {
                role: 'user',
                content:
                  `从用户消息中提炼一条**稳定**的长期偏好（称呼方式/关注指标/详略习惯/流程习惯）。\n消息：「${params.message.slice(0, 200)}」\n` +
                  '只输出 JSON：{"key":"称呼|指标优先|详略|流程习惯","value":"一句话偏好"}；若只是一次性要求而非稳定偏好，输出 {"skip":true}',
              },
            ],
            { temperature: 0, max_tokens: 120 },
          );
          // #3 辅助调用 token 计入用量与计费
          auxPromptTokens += prefRes.prompt_tokens ?? 0;
          auxCompletionTokens += prefRes.completion_tokens ?? 0;
          const pm = (prefRes.content ?? '').match(/\{[\s\S]*\}/);
          if (pm) {
            const pref = JSON.parse(pm[0]) as {
              skip?: boolean;
              key?: string;
              value?: string;
            };
            if (!pref.skip && pref.key && pref.value) {
              await this.ltm.upsertProfile(
                tenantId,
                `pref:${pref.key}`,
                pref.value,
                'user',
                userId,
              );
              this.logger.log(
                `G-D 用户偏好已沉淀：user=${userId} key=${pref.key}`,
              );
            }
          }
        } catch (err) {
          this.logger.warn(
            `G-D 偏好沉淀失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // #3 辅助调用 token 并入总账（意图分诊/S2 自检/G-D 偏好提炼三处，
      // 此前少报导致 usage 行低估、billing.consume 少扣）
      totalPromptTokens += auxPromptTokens;
      totalCompletionTokens += auxCompletionTokens;

      // ── 6. 保存对话历史 ──
      await this.memoryManager.saveHistory(
        tenantId,
        conversationId,
        newMessagesToSave,
        customerId,
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
      // A5 Prometheus 指标记录
      this.metrics.recordRequest(
        tenantId,
        providerName,
        toolResults.some((r) => !r.success) ? 'fail' : 'success',
      );
      this.metrics.recordDuration(latencyMs);
      this.metrics.recordTokens(totalPromptTokens, totalCompletionTokens);
      this.metrics.recordAgentIterations(iteration + 1);

      // A4 会话冷备归档 + B5 计费消耗（best-effort，不阻塞）
      try {
        await this.memoryManager.archiveSession(
          tenantId,
          conversationId,
          userId,
          messages,
        );
        await this.billing.consume(
          tenantId,
          totalPromptTokens + totalCompletionTokens,
        );
      } catch (err) {
        this.logger.debug(
          `会话归档/计费消耗失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
        );
      }

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
        employeeUid: params.employeeUid,
        provider: providerName,
        model: modelName,
        intent: 'chat',
        userMessage: params.message,
        toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        latencyMs,
        success: true,
        fallback: fallbackUsed,
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
        employeeUid: params.employeeUid,
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
   * #5 工具执行超时闸门（2026-09-05 找茬审计）：
   * executor 层此前无超时保护，非 HTTP 路径的工具逻辑卡死会挂住整个 SSE 流。
   * 超时（默认 60s，TOOL_TIMEOUT_MS 可调）转为失败结果交 LLM 处理，
   * 不再无限等待。底层 promise 无法真正取消，但流程不再被挂起。
   */
  private async executeToolWithTimeout(
    tc: ToolCall,
    toolContext: ToolContext,
  ): Promise<ToolResult> {
    const timeoutMs = Number(
      this.configService.get<number>('TOOL_TIMEOUT_MS', 60000),
    );
    return await Promise.race([
      this.executor.executeToolCall(tc, toolContext),
      new Promise<ToolResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              success: false,
              error: `工具执行超时（${timeoutMs}ms），请稍后重试或简化请求`,
            }),
          timeoutMs,
        ),
      ),
    ]);
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
