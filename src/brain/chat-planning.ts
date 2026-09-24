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
 * @param doneIds 已完成步骤 id 集合（跨工具去重）
 */
export function matchPlanStepsByTool(
  steps: PlanStep[],
  toolName: string,
  doneIds: Set<string>,
): number[] {
  const hits: number[] = [];
  steps.forEach((s, i) => {
    if (s.tool === toolName && !doneIds.has(s.id)) {
      doneIds.add(s.id);
      hits.push(i);
    }
  });
  return hits;
}
