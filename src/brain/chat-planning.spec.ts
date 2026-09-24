/**
 * G-A chat-planning 纯函数单元测试
 *
 * 覆盖：复杂目标启发式（顺序连接词/并列动作/保守不误判）、计划上下文生成、
 * 工具命中计划步骤（去重）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import {
  isComplexGoal,
  matchPlanStepsByTool,
  stepsToPlanContext,
} from './chat-planning';
import type { PlanStep } from './agent/agent.types';

const STEPS: PlanStep[] = [
  { id: 's1', label: '查询库存', type: 'tool', tool: 'queryInventory' },
  { id: 's2', label: '生成补货单', type: 'tool', tool: 'createPurchaseOrder' },
  { id: 's3', label: '总结', type: 'synthesis' },
];

describe('G-A isComplexGoal（复杂目标分诊）', () => {
  it('顺序连接词 → 复杂', () => {
    expect(isComplexGoal('查一下库存然后给供应商下补货单')).toBe(true);
    expect(isComplexGoal('第一步查销售，第二步看毛利')).toBe(true);
  });

  it('并列动作（并+动词）→ 复杂', () => {
    expect(isComplexGoal('查一下五粮液的库存并生成对账单')).toBe(true);
  });

  it('简单问题 → 不规划（保守不误判）', () => {
    expect(isComplexGoal('查一下五粮液的库存')).toBe(false);
    expect(isComplexGoal('你好')).toBe(false);
    expect(isComplexGoal('')).toBe(false);
  });

  it('超长消息（>200字）不规划', () => {
    expect(isComplexGoal('然后'.repeat(120))).toBe(false);
  });
});

describe('G-A stepsToPlanContext（计划注入块）', () => {
  it('生成带步骤序号与工具提示的强制计划块', () => {
    const ctx = stepsToPlanContext(STEPS);
    expect(ctx).toContain('执行计划');
    expect(ctx).toContain('1. 查询库存（工具 queryInventory）');
    expect(ctx).toContain('3. 总结');
  });

  it('空计划 → undefined', () => {
    expect(stepsToPlanContext([])).toBeUndefined();
  });
});

describe('G-A matchPlanStepsByTool（步骤进度）', () => {
  it('工具命中计划步骤 → 返回下标并去重', () => {
    const done = new Set<string>();
    expect(matchPlanStepsByTool(STEPS, 'queryInventory', done)).toEqual([0]);
    // 同工具第二次不重复报完成
    expect(matchPlanStepsByTool(STEPS, 'queryInventory', done)).toEqual([]);
    expect(matchPlanStepsByTool(STEPS, 'createPurchaseOrder', done)).toEqual([
      1,
    ]);
  });

  it('无工具步骤（synthesis）不因工具命中', () => {
    const done = new Set<string>();
    expect(matchPlanStepsByTool(STEPS, 'unknownTool', done)).toEqual([]);
  });
});
