/**
 * SelfHealLoopService — 自愈回路（批次2，文档 22.5）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 22.5
 * - Tool 执行失败不立刻报错：重试 → 基于错误类型推断修正建议 → 写回观察驱动 LLM 重新规划
 * - v3.3 升级：每次自愈的成功经验（修正路径、参数模式）写入 ai_db 的 ai_experience 表，
 *   反哺后续同类任务的规划与抽取（认知层进化入口）
 *
 * 错误分类：
 * - insufficient_stock：库存不足 → 建议减量/补货
 * - missing_args：参数缺失 → 澄清
 * - timeout：超时 → 稍后重试
 * - service_unavailable：服务不可用/熔断 → 重试
 * - tool_unknown：工具未注册 → 终止
 * - unknown：其他 → 重试一次后终止
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ToolResult } from '../../tools/tool.interface';
import { HealAction, HealSuggestion, PlanStep } from './agent.types';

/** 自愈最大重试次数 */
export const MAX_HEAL_RETRIES = 2;

/** 错误分类 */
export type HealErrorCategory =
  | 'insufficient_stock'
  | 'missing_args'
  | 'timeout'
  | 'service_unavailable'
  | 'tool_unknown'
  | 'unknown';

/** 自愈执行结果 */
export interface HealResult {
  ok: boolean;
  result?: ToolResult;
  error?: string;
  suggestion?: HealSuggestion;
  healLog: PlanStep['healLog'];
  gaveUp: boolean;
}

/** 自愈输入 */
export interface HealInput {
  step: PlanStep;
  goal: string;
  tenantId: string;
  error: string;
  /** 工具执行函数（TaskRunner 注入，重试时使用修正后参数） */
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  /** 经验回流（ai_db ai_experience，best-effort） */
  capture?: (outcome: 'success' | 'failed', detail: string) => Promise<void>;
}

@Injectable()
export class SelfHealLoopService {
  private readonly logger = new Logger(SelfHealLoopService.name);

  /**
   * 错误分类（关键词推断，供修正建议与经验回流使用）
   */
  classify(error: string): HealErrorCategory {
    const msg = error.toLowerCase();
    if (
      msg.includes('库存不足') ||
      msg.includes('库存不够') ||
      msg.includes('insufficient stock') ||
      msg.includes('库存余量不足') ||
      msg.includes('库存不足')
    ) {
      return 'insufficient_stock';
    }
    if (
      msg.includes('缺少') ||
      msg.includes('缺失') ||
      msg.includes('必填') ||
      msg.includes('required') ||
      msg.includes('参数不完整') ||
      msg.includes('请补充')
    ) {
      return 'missing_args';
    }
    if (
      msg.includes('timeout') ||
      msg.includes('超时') ||
      msg.includes('etimedout') ||
      msg.includes('timed out')
    ) {
      return 'timeout';
    }
    if (
      msg.includes('未注册') ||
      msg.includes('unknown tool') ||
      msg.includes('不存在的工具')
    ) {
      return 'tool_unknown';
    }
    if (
      msg.includes('服务不可用') ||
      msg.includes('熔断') ||
      msg.includes('503') ||
      msg.includes('circuit') ||
      msg.includes('暂时不可用') ||
      msg.includes('ecosystem') ||
      msg.includes('connect ec') ||
      msg.includes('econnrefused')
    ) {
      return 'service_unavailable';
    }
    return 'unknown';
  }

  /**
   * 修正建议（基于错误类型推断，供写回观察驱动 LLM 重新规划）
   */
  suggest(step: PlanStep, error: string): HealSuggestion {
    const category = this.classify(error);
    switch (category) {
      case 'insufficient_stock':
        return {
          action: 'clarify',
          message: '库存不足：请确认是否减少数量，或先生成补货/采购建议后重试',
        };
      case 'missing_args':
        return {
          action: 'clarify',
          message: `「${step.label}」缺少必要参数，请补充后重试`,
        };
      case 'timeout':
        return { action: 'retry', message: '执行超时，自动重试中' };
      case 'service_unavailable':
        return { action: 'retry', message: '服务暂时不可用，自动重试中' };
      case 'tool_unknown':
        return {
          action: 'give_up',
          giveUp: true,
          message: '工具不可用，已终止该步骤',
        };
      default:
        return {
          action: 'retry',
          message: '执行异常，自动重试一次',
        };
    }
  }

  /**
   * 自愈主循环：
   * 重试（≤ MAX_HEAL_RETRIES 次）→ 若仍失败按建议给用户澄清/终止；
   * 每次尝试结果（成功/失败）都回流 ai_db ai_experience。
   */
  async heal(input: HealInput): Promise<HealResult> {
    const { step, error, execute, capture } = input;
    let currentError = error;
    const healLog: PlanStep['healLog'] = [];
    const firstSuggestion = this.suggest(step, error);

    // tool_unknown 直接终止，不浪费重试
    if (firstSuggestion.giveUp) {
      healLog.push({
        at: Date.now(),
        action: firstSuggestion.action,
        detail: currentError.slice(0, 200),
      });
      await this.recordExperience(capture, 'failed', currentError);
      return {
        ok: false,
        error: currentError,
        suggestion: firstSuggestion,
        healLog,
        gaveUp: true,
      };
    }

    // 重试循环（含参数修正）
    let args = step.args ?? {};
    for (let i = 0; i < MAX_HEAL_RETRIES; i += 1) {
      if (firstSuggestion.action === 'fix_args' && firstSuggestion.args) {
        args = { ...args, ...firstSuggestion.args };
      }
      const action: HealAction = i === 0 ? firstSuggestion.action : 'retry';
      healLog.push({
        at: Date.now(),
        action,
        detail:
          i === 0
            ? `${currentError.slice(0, 200)}${firstSuggestion.message ? `｜${firstSuggestion.message}` : ''}`
            : '自动重试',
      });
      this.logger.log(
        `自愈重试 ${i + 1}/${MAX_HEAL_RETRIES}：step=${step.label} action=${action}`,
      );
      try {
        const result = await execute(args);
        if (result.success) {
          healLog.push({
            at: Date.now(),
            action: 'retry',
            detail: '自愈成功（重试后恢复）',
          });
          await this.recordExperience(
            capture,
            'success',
            `自愈成功：${result.data ? JSON.stringify(result.data).slice(0, 120) : '无数据'}`,
          );
          return { ok: true, result, healLog, gaveUp: false };
        }
        // 重试后仍失败：更新 error 继续（同类型问题不再重复重试）
        currentError = result.error ?? currentError;
      } catch (err) {
        currentError = err instanceof Error ? err.message : String(err);
      }
    }

    // 自愈耗尽
    const finalSuggestion: HealSuggestion = {
      action: 'clarify',
      message: `「${step.label}」执行失败且自动重试未恢复，请人工介入或调整请求`,
    };
    await this.recordExperience(capture, 'failed', currentError);
    return {
      ok: false,
      error: currentError,
      suggestion: finalSuggestion,
      healLog,
      gaveUp: false,
    };
  }

  /**
   * 经验回流（best-effort，ai_db 不可用不阻塞）
   */
  private async recordExperience(
    capture: HealInput['capture'],
    outcome: 'success' | 'failed',
    detail: string,
  ): Promise<void> {
    if (!capture) {
      return;
    }
    try {
      await capture(outcome, detail);
    } catch (err) {
      this.logger.debug(
        `自愈经验回流失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
