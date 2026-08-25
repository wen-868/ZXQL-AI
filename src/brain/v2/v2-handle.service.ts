/**
 * V2HandleService — 自然语言入口（批次3，文档 11.3 POST /ai/v2/handle）
 *
 * 语义（写全审核定调）：
 * - 读/分析意图：直接返回结论（intent=analysis），全程自动
 * - 写意图：LLM 选写工具 → StructuredExtractor 增强校验 → 预览执行
 *   → WriteGuard 挂起令牌（intent=write，返回 pendingWrite JSON），不执行
 * - 参数缺失/非法：返回 intent=clarify 反问澄清（不挂残缺草稿）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { Injectable, Logger } from '@nestjs/common';
import { ToolExecutor } from '../../tools/tool-executor';
import { ToolRegistry } from '../../tools/tool-registry';
import { ConfirmationService } from '../confirmation.service';
import { Orchestrator } from '../orchestrator.service';
import { StructuredExtractor } from '../extraction/structured-extractor';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import type { ToolContext } from '../../tools/tool.interface';
import type { ExtractionIssue } from '../extraction/structured-extractor';

/** v2/handle 请求上下文 */
export interface V2HandleContext {
  tenantId: string;
  userId?: string;
  role?: string;
  authToken?: string;
  sessionId?: string;
  model?: string;
  scope?: 'mgmt' | 'platform';
}

/** v2/handle 响应（写全审核定调：读自动 / 写挂起 / 缺参澄清） */
export type V2HandleResult =
  | {
      intent: 'analysis';
      message: string;
      usage?: { latencyMs: number };
    }
  | {
      intent: 'write';
      pendingWrite: {
        token: string;
        docType: string;
        risk: string;
        summary?: string;
        operationLabel?: string;
        preview?: Record<string, unknown>;
      };
      message: string;
    }
  | {
      intent: 'clarify';
      message: string;
      issues?: ExtractionIssue[];
    };

/** 写意图提示词（命中任一即优先走写分支；未命中默认分析） */
const WRITE_HINT_KEYWORDS = [
  '开单',
  '建单',
  '下单',
  '创建',
  '新增',
  '建档',
  '修改',
  '调整',
  '改价',
  '删除',
  '取消',
  '撤销',
  '发货',
  '退货',
  '收款',
  '付款',
  '审批',
  '调拨',
  '盘点',
  '优惠券',
  '秒杀',
  '满减',
  '拼团',
  '赠品',
  '活动',
  '结算',
  '回款',
];

@Injectable()
export class V2HandleService {
  private readonly logger = new Logger(V2HandleService.name);

  constructor(
    private readonly orchestrator: Orchestrator,
    private readonly extractor: StructuredExtractor,
    private readonly confirmationService: ConfirmationService,
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly router: ProviderRouterService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  /**
   * 自然语言入口：判断写/读意图并分发
   */
  async handle(input: string, ctx: V2HandleContext): Promise<V2HandleResult> {
    const isWriteHint = WRITE_HINT_KEYWORDS.some((kw) => input.includes(kw));
    if (!isWriteHint) {
      return this.analysis(input, ctx);
    }
    return this.write(input, ctx);
  }

  // ── 写分支：LLM 选工具 → 增强校验 → 预览 → 挂起令牌 ──

  private async write(
    input: string,
    ctx: V2HandleContext,
  ): Promise<V2HandleResult> {
    try {
      // 1. 写工具白名单（读工具不参与写分支）
      const writeTools = this.registry
        .toToolDefinitionsForCategories([], ctx.scope)
        .filter((d) => this.registry.get(d.function.name)?.isWriteOperation);
      if (writeTools.length === 0) {
        return this.analysis(input, ctx);
      }

      // 2. LLM 选择写工具并抽取参数（function calling）
      const resolved = await this.aiConfigService.getResolvedConfig();
      const chat = await this.router.chatSyncWithFallback(
        [
          {
            role: 'system',
            content:
              '你是写入参数抽取助手。根据用户意图选择唯一写工具并抽取参数；' +
              '与写入无关时不要调用工具。',
          },
          { role: 'user', content: input },
        ],
        { tools: writeTools, temperature: 0.1, max_tokens: 2048 },
        {
          requestedModel: ctx.model,
          resolved,
          systemScope: this.router.getSystemScope(),
        },
      );
      const toolCall = chat.tool_calls?.[0];
      if (!toolCall) {
        // LLM 判定非写入 → 转分析
        return this.analysis(input, ctx);
      }
      const toolName = toolCall.function.name;
      const rawArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;

      // 3. StructuredExtractor 增强（必填/枚举/数量语义），缺失则澄清
      const enhance = await this.extractor.tryEnhance({
        toolName,
        utterance: input,
        args: rawArgs,
        model: ctx.model,
      });
      if (enhance.needsClarification) {
        return {
          intent: 'clarify',
          message: enhance.questions?.join('；') ?? '请补充必要信息后再试',
          issues: enhance.issues,
        };
      }
      const args = enhance.args ?? rawArgs;

      // 4. 预览执行（confirm=false，不落地）
      const toolContext = this.toToolContext(ctx);
      const result = await this.executor.executeToolCall(
        {
          id: `v2_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        },
        toolContext,
      );
      if (!result.success) {
        return {
          intent: 'clarify',
          message: result.error ?? '无法生成草稿，请补充或调整信息',
        };
      }
      if (!result.preview) {
        // 写工具未返回预览（异常）→ 按失败处理，不静默放行
        this.logger.warn(
          `写工具未返回预览：tool=${toolName} tenant=${ctx.tenantId}，拒绝自动执行`,
        );
        return {
          intent: 'clarify',
          message: '该操作需要人工确认，请通过对话确认后执行',
        };
      }

      // 5. WriteGuard 挂起令牌
      const tool = this.registry.get(toolName);
      const risk = tool?.risk ?? 'medium';
      const confirmation = await this.confirmationService.create({
        tenantId: ctx.tenantId,
        conversationId: ctx.sessionId,
        toolName,
        docType: toolName,
        risk,
        needsReview: tool?.needsReview ?? risk === 'high',
        args,
        preview: result.preview,
        operationLabel: result.preview.operation ?? toolName,
      });

      this.logger.log(
        `v2/handle 写意图挂起：tenant=${ctx.tenantId} tool=${toolName} risk=${risk} token=${confirmation.confirmationId.slice(0, 12)}…`,
      );
      return {
        intent: 'write',
        pendingWrite: {
          token: confirmation.confirmationId,
          docType: confirmation.docType,
          risk: confirmation.risk,
          summary: result.preview.summary,
          operationLabel: confirmation.operationLabel,
          preview: result.preview,
        },
        message: '已生成草稿，待你确认后执行。',
      };
    } catch (err) {
      this.logger.warn(
        `v2/handle 写分支异常（降级分析）：${err instanceof Error ? err.message : String(err)}`,
      );
      return this.analysis(input, ctx);
    }
  }

  // ── 分析分支：Orchestrator 执行到结束，汇总文本结论 ──

  private async analysis(
    input: string,
    ctx: V2HandleContext,
  ): Promise<V2HandleResult> {
    const start = Date.now();
    let message = '';
    try {
      for await (const event of this.orchestrator.run({
        message: input,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: ctx.role,
        authToken: ctx.authToken,
        conversationId: ctx.sessionId,
        model: ctx.model,
        scope: ctx.scope,
      })) {
        if (event.type === 'text') {
          message += event.content;
        }
        if (event.type === 'error') {
          this.logger.warn(
            `v2/handle 分析分支错误：${event.message} code=${event.code ?? '-'}`,
          );
          message = message || event.message;
        }
      }
    } catch (err) {
      message = `处理失败：${err instanceof Error ? err.message : String(err)}`;
    }
    return {
      intent: 'analysis',
      message: message.trim() || '已完成处理。',
      usage: { latencyMs: Date.now() - start },
    };
  }

  private toToolContext(ctx: V2HandleContext): ToolContext {
    return {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId: ctx.sessionId,
      role: ctx.role,
      authToken: ctx.authToken,
    };
  }
}
