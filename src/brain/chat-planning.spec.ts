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

  it('计划内工具重复调用 → 不算推进（返回空）', () => {
    const done = new Set<string>();
    expect(matchPlanStepsByTool(STEPS, 'queryInventory', done)).toEqual([0]);
    // 同一工具再查一次（如查第二个商品），不应把第 2 步误标完成
    expect(matchPlanStepsByTool(STEPS, 'queryInventory', done)).toEqual([]);
    expect(done.has('s2')).toBe(false);
  });

  it('计划外工具 → 兜底推进最早未完成步骤（进度条不卡死）', () => {
    const done = new Set<string>();
    // unknownTool 不在计划内，按"严格按序推进"语义补一步
    expect(matchPlanStepsByTool(STEPS, 'unknownTool', done)).toEqual([0]);
    expect(done.has('s1')).toBe(true);
  });

  it('未声明工具的 synthesis 步骤，最终能被兜底推进', () => {
    const done = new Set<string>(['s1', 's2']);
    // s3 是 synthesis，无 tool 字段，精确匹配永远命中不了；靠兜底完成
    expect(matchPlanStepsByTool(STEPS, 'unknownTool', done)).toEqual([2]);
    expect(done.has('s3')).toBe(true);
  });

  it('全部步骤完成后，兜底不再前进', () => {
    const done = new Set<string>(['s1', 's2', 's3']);
    expect(matchPlanStepsByTool(STEPS, 'unknownTool', done)).toEqual([]);
  });

  it('兜底不重复标记：连续两次计划外工具依次推进两步', () => {
    const done = new Set<string>();
    expect(matchPlanStepsByTool(STEPS, 'toolA', done)).toEqual([0]);
    expect(matchPlanStepsByTool(STEPS, 'toolB', done)).toEqual([1]);
    expect(matchPlanStepsByTool(STEPS, 'toolC', done)).toEqual([2]);
  });
});
