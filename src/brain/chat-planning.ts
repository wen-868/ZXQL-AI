/**
 * chat-planning — G-A 主链路规划桥（2026-09-05）
 *
 * 依据：AI Agent 参考架构对照审计 G-A——PlannerService 此前仅在 /ai/agent 通道，
 * chat 主链路的多步目标直接 ReAct 盲跑。本模块提供三个纯函数桥接件：
 * 1. isComplexGoal：复杂目标启发式分诊（顺序连接词/并列动作），保守判定；
 * 2. stepsToPlanContext：PlanStep[] → 系统提示词"执行计划"块；
 * 3. matchPlanStepsByTool：工具名 → 命中的计划步骤（plan_step 进度事件用）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import type { PlanStep } from './agent/agent.types';

/** 顺序连接词（多步目标的最强信号） */
const SEQUENTIAL_RE = /(然后|接着|再帮我|之后再|最后一步|第一步|第二步|第三步)/;
/** 并列动作词（"查A并开B"） */
const PARALLEL_ACTION_RE =
  /并[^，。]{0,12}(开|查|发|生成|导出|调|发个|发一张|给|创建|更新)/;

/**
 * 复杂目标启发式判定（保守：宁可不规划也不错判简单问题）
 *
 * 规则：顺序连接词命中 → 复杂；"并+动作"并列 → 复杂；
 * 其余（含超长闲聊）一律 false。
 */
export function isComplexGoal(message: string): boolean {
  const t = (message ?? '').trim();
  if (!t || t.length > 200) return false;
  if (SEQUENTIAL_RE.test(t)) return true;
  return PARALLEL_ACTION_RE.test(t);
}

/**
 * PlanStep[] → 系统提示词"执行计划"块（无步骤返回 undefined）
 */
export function stepsToPlanContext(steps: PlanStep[]): string | undefined {
  if (!steps || steps.length === 0) return undefined;
  const lines = steps
    .map((s, i) => `${i + 1}. ${s.label}${s.tool ? `（工具 ${s.tool}）` : ''}`)
    .join('\n');
  return `## 执行计划（强制：严格按以下步骤推进，每步完成后通过工具结果确认再进入下一步；全部完成后再给用户总结）\n${lines}`;
}

/**
 * 工具名 → 命中的计划步骤下标列表（plan_step 进度事件用）
 *
 * 两级匹配：
 * 1. 精确命中：步骤声明的 tool 与本次调用同名（跨工具去重）；
 * 2. 顺序推进兜底（2026-09-26）：该工具不在计划内且仍有未完成步骤时，
 *    把最早一个未完成步骤标记为完成，保证进度单调前进。
 *
 * 兜底的必要性：`PlanStep.tool` 是可选字段，未声明工具的步骤（如 synthesis 总结步）
 * **永远无法**被精确命中；LLM 也可能临时改用计划外工具。两种情况都会让 plan_step
 * 进度停在原地，前端进度条永久卡住——这是显示层缺陷，比"多标记一步"更影响体验。
 *
 * 不兜底的边界：计划内已声明过该工具 → 判为重复调用（同一工具查两次），
 * 不算推进，返回空。否则"查 A 再查 B"会把后续步骤误标完成。
 *
 * 取舍：兜底按"严格按序推进"的提示词语义前进，若 LLM 调用了与计划无关的探索性工具，
 * 会多标记一步（偏乐观）；但不兜底则进度永久停滞（更糟）。此处取前者。
 *
 * @param doneIds 已完成步骤 id 集合（跨工具去重，函数内会写入命中/兜底的 id）
 */
export function matchPlanStepsByTool(
  steps: PlanStep[],
  toolName: string,
  doneIds: Set<string>,
): number[] {
  // 1. 精确命中
  const hits: number[] = [];
  steps.forEach((s, i) => {
    if (s.tool === toolName && !doneIds.has(s.id)) {
      doneIds.add(s.id);
      hits.push(i);
    }
  });
  if (hits.length > 0) return hits;

  // 计划内已声明该工具 → 重复调用，不算推进
  if (steps.some((s) => s.tool === toolName)) return [];

  // 2. 顺序推进兜底：全部已完成时不再前进（findIndex 返回 -1）
  const nextIdx = steps.findIndex((s) => !doneIds.has(s.id));
  if (nextIdx < 0) return [];

  doneIds.add(steps[nextIdx].id);
  return [nextIdx];
}
