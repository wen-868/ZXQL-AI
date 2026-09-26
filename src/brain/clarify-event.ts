/**
 * clarify-event — 写参数澄清事件载荷构造（2026-09-26）
 *
 * 背景：桌面端渲染澄清卡读的是 `questions`（每项取 question ?? message），
 * 而 Orchestrator 此前只下发 `issues` 与 `message`，导致澄清卡**渲染为空白**。
 *
 * 本模块把载荷构造抽成纯函数，做三件事：
 * 1. questions 与 issues 同源（ExtractionIssue[]），两个字段一并下发，前后端各自消费；
 * 2. issues 缺失时 questions 归一为空数组，不让前端拿到 undefined；
 * 3. message 兜底文案集中一处，避免各调用点口径不一致。
 *
 * 纯函数、零依赖，便于单测锁死前后端契约。
 *
 * 负责人: 苏然 | 创建日期: 2026-09-26
 */
import type { ExtractionIssue } from './extraction/structured-extractor';

/** 无澄清问题明细时的兜底文案 */
export const CLARIFY_FALLBACK_MESSAGE = '请补充必要信息后再试';

/** 澄清事件载荷（SSE type='clarify' 的除 type 外全部字段） */
export interface ClarifyPayload {
  message: string;
  /** 澄清问题明细（前端渲染用） */
  questions: ExtractionIssue[];
  /** 问题明细（后端/测试消费用，与 questions 同源） */
  issues: ExtractionIssue[];
}

/**
 * 是否需要对本次工具调用补一次「写参数澄清判定」
 *
 * 背景：写工具**必填缺失**时返回 `success:false` 且**不带 preview**（如
 * createSalesOrder 缺 items → parseArgs 直接失败）。Orchestrator 原先只在
 * `toolResult.preview` 为真时才跑 tryEnhance，于是这条路径的澄清**永远不可达**——
 * 用户只收到一句自然语言反问，前端渲染不出结构化澄清卡。
 *
 * 判定（三条全满足才补判）：
 * 1. 没有 preview（有 preview 的由主流程处理，不重复）；
 * 2. 调用失败；
 * 3. 该工具是写操作（读工具失败不该反问写参数）。
 *
 * 纯函数，便于单测——Orchestrator 有 23 个依赖，整体单测成本过高。
 */
export function needsWriteFailureClarifyCheck(
  result: { success: boolean; preview?: unknown },
  isWriteOperation: boolean,
): boolean {
  if (result.preview) return false;
  return !result.success && isWriteOperation;
}

/**
 * 由 StructuredExtractor 的增强结果构造澄清事件载荷
 *
 * @param enhance.questions 面向用户的澄清问句（string[]，用于拼 message）
 * @param enhance.issues    问题明细（含 field/reason/message/question）
 */
export function buildClarifyPayload(enhance: {
  questions?: string[];
  issues?: ExtractionIssue[];
}): ClarifyPayload {
  const issues = enhance.issues ?? [];
  const message =
    enhance.questions?.join('；') ||
    issues.map((i) => i.question || i.message).join('；') ||
    CLARIFY_FALLBACK_MESSAGE;
  return { message, questions: issues, issues };
}
