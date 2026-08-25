/**
 * PlannerService — 复合目标分解（批次2，文档 22.4）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 22.4
 * 「复合目标分解：Planner 模板（确定性任务，可审计）+ LLM 动态规划」
 *
 * 分解策略（三级降级）：
 * 1. 确定性模板：已知业务流（销售开单/采购计划/营销活动/库存盘点）→ 复用 BUILTIN_GRAPHS 转步骤
 * 2. LLM 动态规划：目标命中注册工具 → 生成步骤序列（工具名/参数/说明），逐项校验注册表
 * 3. 兜底：单 agent 步骤（交由 ReAct 子循环执行，退化为自由对话）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { ToolRegistry } from '../../tools/tool-registry';
import { AiConfigService } from '../../tenant/ai-config.service';
import { ProviderRouterService } from '../router/provider-router.service';
import { BUILTIN_GRAPHS } from '../graph/graph.types';
import type { ChatMessage } from '../../providers/provider.interface';
import { PLAN_TEMPLATE_HINTS, PlanStep, PlanStepType } from './agent.types';

/** 单计划最大步骤数（与 22.2 maxSteps=12 对齐） */
export const MAX_PLAN_STEPS = 12;

/** 规划输入 */
export interface PlanInput {
  tenantId: string;
  goal: string;
  /** 对话级模型标识（可选） */
  model?: string;
  /** 工具作用域：mgmt/platform */
  scope?: 'mgmt' | 'platform';
}

@Injectable()
export class PlannerService {
  private readonly logger = new Logger(PlannerService.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly router: ProviderRouterService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  /**
   * 目标分解为步骤序列（三级降级，永不抛异常——失败兜底为单 agent 步骤）
   */
  async plan(input: PlanInput): Promise<PlanStep[]> {
    // 1. 确定性模板
    const template = this.matchTemplate(input.goal);
    if (template) {
      this.logger.log(
        `Planner 命中模板：${template.id}（目标「${input.goal.slice(0, 40)}」）`,
      );
      return this.templateToSteps(template.id);
    }

    // 2. LLM 动态规划
    try {
      const llmSteps = await this.planWithLlm(input);
      if (llmSteps.length > 0) {
        return llmSteps;
      }
    } catch (err) {
      this.logger.warn(
        `LLM 动态规划失败（降级兜底）：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3. 兜底：单 agent 步骤（自由 ReAct 执行）
    this.logger.log(
      `Planner 兜底：单 agent 步骤（目标「${input.goal.slice(0, 40)}」）`,
    );
    return [this.newStep('agent', '执行任务', input.goal, {})];
  }

  /**
   * 填充工具步骤参数（工具步骤无参数时调用一次 LLM function calling 提取，
   * best-effort：失败保留空参数，交由执行期澄清/自愈）
   *
   * @param step  目标步骤（type=tool）
   * @param goal  用户目标（参数来源）
   * @returns 填充后的参数；失败返回原参数
   */
  async fillStepArgs(
    step: PlanStep,
    goal: string,
    input: PlanInput,
  ): Promise<Record<string, unknown>> {
    if (!step.tool || !this.registry.has(step.tool)) {
      return step.args ?? {};
    }
    try {
      const resolved = await this.aiConfigService.getResolvedConfig();
      const toolDef = this.registry
        .toToolDefinitionsForCategories([], input.scope)
        .find((d) => d.function.name === step.tool);
      if (!toolDef) {
        return step.args ?? {};
      }
      const messages: ChatMessage[] = [
        {
          role: 'system',
          content:
            '你是参数抽取助手。根据用户目标，为指定工具抽取 JSON 参数；' +
            '只能使用该工具 JSON Schema 中定义的字段，信息不足的字段省略，不得编造。',
        },
        {
          role: 'user',
          content: `用户目标：${goal}\n请为工具「${step.tool}」抽取参数（仅返回工具调用）。`,
        },
      ];
      const result = await this.router.chatSyncWithFallback(
        messages,
        { tools: [toolDef], temperature: 0.1, max_tokens: 1024 },
        {
          requestedModel: input.model,
          resolved,
          systemScope: this.router.getSystemScope(),
        },
      );
      const call = result.tool_calls?.[0];
      if (!call) {
        return step.args ?? {};
      }
      const parsed = JSON.parse(call.function.arguments) as Record<
        string,
        unknown
      >;
      if (parsed && typeof parsed === 'object') {
        this.logger.debug(
          `步骤参数填充成功：${step.tool} → ${JSON.stringify(parsed).slice(0, 120)}`,
        );
        return parsed;
      }
    } catch (err) {
      this.logger.debug(
        `步骤参数填充失败（保留原参数）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return step.args ?? {};
  }

  // ── 模板分解 ──

  /**
   * 命中已知业务模板（关键词匹配，返回图定义；未命中返回 null）
   */
  matchTemplate(goal: string): { id: string } | null {
    for (const hint of PLAN_TEMPLATE_HINTS) {
      if (hint.keywords.some((kw) => goal.includes(kw))) {
        return { id: hint.id };
      }
    }
    return null;
  }

  /**
   * 图定义 → PlanStep[]（初始全 pending）
   */
  templateToSteps(graphId: string): PlanStep[] {
    const graph = BUILTIN_GRAPHS[graphId];
    if (!graph) {
      return [];
    }
    const now = Date.now();
    return graph.nodes.map((node) => {
      const base: PlanStep = {
        id: node.id,
        label: node.label,
        type: node.type,
        next: node.next,
        status: 'pending',
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (node.type === 'tool') {
        base.tool = node.tool;
        base.args = node.args ?? {};
      }
      if (node.type === 'agent') {
        base.prompt =
          node.agent?.systemPrompt ??
          node.prompt ??
          `你是「${node.label}」域的专家 Agent。`;
      }
      return base;
    });
  }

  // ── LLM 动态规划 ──

  private async planWithLlm(input: PlanInput): Promise<PlanStep[]> {
    const resolved = await this.aiConfigService.getResolvedConfig();
    // 意图工具集（规划阶段只给工具名清单，不灌全部定义，控制 token）
    const toolNames = this.registry
      .toToolDefinitionsForCategories([], input.scope)
      .slice(0, 60)
      .map((d) => d.function.name);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          '你是任务规划 Agent。将用户目标分解为 1-12 步执行计划。' +
          '仅输出 JSON 数组，每步格式：' +
          '{"label":"步骤中文名","type":"tool","tool":"工具名","args":{}} 或 ' +
          '{"label":"步骤中文名","type":"agent","prompt":"子任务指令"}；' +
          '最后一步必须为 {"label":"完成","type":"end"}。' +
          '工具名只能从以下清单选择：' +
          JSON.stringify(toolNames) +
          '；不确定用哪个工具时使用 agent 步骤（不指定工具）。',
      },
      {
        role: 'user',
        content: `用户目标：${input.goal}`,
      },
    ];

    const result = await this.router.chatSyncWithFallback(
      messages,
      { temperature: 0.2, max_tokens: 2048 },
      {
        requestedModel: input.model,
        resolved,
        systemScope: this.router.getSystemScope(),
      },
    );

    const parsed = this.tryParsePlan(result.content);
    if (!parsed || parsed.length === 0) {
      return [];
    }
    return this.normalizeSteps(parsed, input.goal);
  }

  /** 解析 LLM 输出中的 JSON 数组（容忍 markdown 代码块包裹） */
  private tryParsePlan(content: string): Array<Record<string, unknown>> | null {
    if (!content) {
      return null;
    }
    const cleaned = content
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end <= start) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
      const arr = Array.isArray(parsed)
        ? (parsed as Array<Record<string, unknown>>)
        : null;
      return Array.isArray(arr) ? arr : null;
    } catch {
      return null;
    }
  }

  /** 规范化步骤：校验工具存在、裁剪超限、保证末步 end、补状态字段 */
  private normalizeSteps(
    raw: Array<Record<string, unknown>>,
    goal: string,
  ): PlanStep[] {
    const now = Date.now();
    const steps: PlanStep[] = [];
    for (const item of raw) {
      // 预留末步 end 的位置（上限 12 步含 end）
      if (steps.length >= MAX_PLAN_STEPS - 1) {
        break;
      }
      const label =
        typeof item.label === 'string' ? item.label.slice(0, 50) : '步骤';
      const type = this.normalizeType(item.type);
      if (type === 'end') {
        steps.push(this.newStep('end', label || '完成', undefined, {}, now));
        return steps;
      }
      if (type === 'tool') {
        const tool = typeof item.tool === 'string' ? item.tool : '';
        if (!tool || !this.registry.has(tool)) {
          // 未知工具 → 转 agent 步骤（不阻断规划）
          steps.push(
            this.newStep(
              'agent',
              label,
              `（规划转换）请用已有工具完成：${label}；用户目标：${goal}`,
              {},
              now,
            ),
          );
          continue;
        }
        const toolStep = this.newStep(
          'tool',
          label,
          undefined,
          item.args && typeof item.args === 'object'
            ? (item.args as Record<string, unknown>)
            : {},
          now,
        );
        toolStep.tool = tool;
        steps.push(toolStep);
        continue;
      }
      // agent 步骤
      steps.push(
        this.newStep(
          'agent',
          label,
          typeof item.prompt === 'string' ? item.prompt : label,
          {},
          now,
        ),
      );
    }

    // 保证末步 end
    const last = steps[steps.length - 1];
    if (!last || last.type !== 'end') {
      steps.push(this.newStep('end', '完成', undefined, {}, now));
    }
    return steps;
  }

  private normalizeType(type: unknown): PlanStepType {
    if (
      type === 'tool' ||
      type === 'agent' ||
      type === 'condition' ||
      type === 'end'
    ) {
      return type;
    }
    return 'agent';
  }

  private newStep(
    type: PlanStepType,
    label: string,
    prompt: string | undefined,
    args: Record<string, unknown>,
    now = Date.now(),
  ): PlanStep {
    return {
      id: `s_${now}_${Math.random().toString(36).slice(2, 8)}`,
      label,
      type,
      prompt,
      args,
      status: 'pending',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }
}
