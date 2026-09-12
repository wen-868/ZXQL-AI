/**
 * AnswerSelfCheckService — S2 回答自检（2026-09-05 细化：独立服务，逻辑全测试覆盖）
 *
 * 像人交报告前核一遍数字：工具已用且答案包含数字时，让 LLM 拿工具结果
 * 复核答案中的业务数字/名称是否有依据，失真即返回更正说明（调用方追发给用户）。
 *
 * 细化点（相比首版内联实现）：
 * - 证据摘要逐工具 600 字符、回答 1200 字符，降低长结果被截断导致误判的概率；
 * - 明确"口径换算（箱→瓶）不算错误"，避免把合理换算误报为失真；
 * - 判决解析容错：剥 markdown 围栏 + 提取首个 JSON 对象 + ok 必须为布尔；
 * - 指标留痕：ai_answer_selfcheck_total{result=pass|corrected|skip|error}。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../common/metrics.service';

/** 自检输入的工具结果（与 orchestrator 内部记录结构一致） */
export interface SelfCheckToolResult {
  tool: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

/** 自检判决 */
export interface SelfCheckVerdict {
  ok: boolean;
  correction?: string;
}

/** 自检执行器签名（调用方注入 provider.chatSync，避免依赖具体 Provider） */
export type SelfCheckChatFn = (prompt: string) => Promise<string>;

@Injectable()
export class AnswerSelfCheckService {
  private readonly logger = new Logger(AnswerSelfCheckService.name);

  constructor(private readonly metrics: MetricsService) {}

  /**
   * 是否需要自检：用过工具且答案含数字（业务数字必然含数字；纯寒暄不触发）
   */
  shouldCheck(answer: string, toolResultCount: number): boolean {
    if (toolResultCount <= 0) return false;
    return /\d/.test((answer ?? '').trim());
  }

  /**
   * 构建核对提示词（证据摘要逐工具 600 字符，回答 1200 字符）
   */
  buildVerifyPrompt(
    toolResults: SelfCheckToolResult[],
    answer: string,
  ): string {
    const digest = toolResults
      .slice(0, 6)
      .map(
        (t) =>
          `${t.tool}（${t.success ? '成功' : '失败'}）：${JSON.stringify(
            t.data ?? t.error ?? {},
          ).slice(0, 600)}`,
      )
      .join('\n');
    return (
      `任务：核对回答中的业务数字/单号/名称是否有依据。\n【工具结果】\n${digest}\n【回答】\n${answer.slice(0, 1200)}\n` +
      '仅当回答中的数字、单号或名称在工具结果中找不到依据时才需要更正；' +
      '口径换算（如箱→瓶、元→万元）不算错误。只输出 JSON：' +
      '{"ok":true} 或 {"ok":false,"correction":"更正说明（含正确数字）"}'
    );
  }

  /**
   * 解析判决：剥 markdown 围栏 → 提取首个 JSON 对象 → ok 必须为布尔；
   * 解析失败返回 null（视为自检未产出结论，不更正）
   */
  parseVerdict(content: string): SelfCheckVerdict | null {
    let text = (content ?? '').trim();
    if (text.startsWith('```')) {
      const nl = text.indexOf('\n');
      if (nl >= 0) text = text.slice(nl + 1);
      if (text.endsWith('```')) text = text.slice(0, -3);
      text = text.trim();
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as {
        ok?: unknown;
        correction?: unknown;
      };
      if (typeof parsed.ok !== 'boolean') return null;
      if (parsed.ok) return { ok: true };
      if (typeof parsed.correction === 'string' && parsed.correction.trim()) {
        return { ok: false, correction: parsed.correction.trim() };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 执行自检：触发条件不满足记 skip；LLM 异常记 error 且不阻断业务
   *
   * @param chat      执行器（调用方注入：provider.chatSync 包一层取 content）
   * @param toolResults 本轮工具结果
   * @param answer    最终回答文本
   * @returns 失真时返回 { ok:false, correction }；通过/未触发/异常返回 null 或 {ok:true}
   */
  async verify(
    chat: SelfCheckChatFn,
    toolResults: SelfCheckToolResult[],
    answer: string,
  ): Promise<SelfCheckVerdict | null> {
    if (!this.shouldCheck(answer, toolResults.length)) {
      this.metrics.recordAnswerSelfCheck('skip');
      return null;
    }
    try {
      const content = await chat(this.buildVerifyPrompt(toolResults, answer));
      const verdict = this.parseVerdict(content);
      if (!verdict) {
        this.metrics.recordAnswerSelfCheck('error');
        this.logger.warn('S2 自检判决解析失败（视为未产出结论）');
        return null;
      }
      this.metrics.recordAnswerSelfCheck(verdict.ok ? 'pass' : 'corrected');
      if (!verdict.ok) {
        this.logger.warn(
          `S2 自检发现数字失真：${verdict.correction?.slice(0, 80)}`,
        );
      }
      return verdict;
    } catch (err) {
      this.metrics.recordAnswerSelfCheck('error');
      this.logger.warn(
        `S2 回答自检失败（忽略）：${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
