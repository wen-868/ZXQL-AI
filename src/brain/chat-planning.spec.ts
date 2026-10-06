/**
 * G-A chat-planning 纯函数单元测试
 *
 * 覆盖：复杂目标启发式（顺序连接词/并列动作/保守不误判）、计划上下文生成、
 * 工具命中计划步骤（去重）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
import {
  collectSkippedPlanStepIndexes,
  isComplexGoal,
  matchPlanStepsByTool,
  stepsToPlanContext,
} from './chat-planning';
import type { PlanStep } from './agent/agent.types';

/**
 * 步骤工厂：补齐 PlanStep 的必填字段（status/retryCount/时间戳）。
 * 这些字段与 chat-planning 的三个纯函数无关，逐个字面量重复会淹没有效信息。
 */
function step(
  s: Pick<PlanStep, 'id' | 'label' | 'type'> & Partial<PlanStep>,
): PlanStep {
  return {
    status: 'pending',
    retryCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...s,
  };
}

const STEPS: PlanStep[] = [
  step({ id: 's1', label: '查询库存', type: 'tool', tool: 'queryInventory' }),
  step({
    id: 's2',
    label: '生成补货单',
    type: 'tool',
    tool: 'createPurchaseOrder',
  }),
  // type 取值域是 tool|agent|condition|end（无 synthesis）；
  // 总结步用 agent 且不声明 tool —— 正是"永远无法精确命中"的那类步骤
  step({ id: 's3', label: '总结', type: 'agent', prompt: '汇总结果' }),
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

  // P2 修复回归（2026-10-06）：此前精确命中用 forEach 全量遍历，
  // 计划内多个同名工具步骤会一次全标 done —— "查杭州库存，再查北京库存"
  // 做完第 1 步就显示 2/2 完成（进度虚报）
  it('计划内多步同名工具 → 一次调用只推进最早一步（不虚报完成）', () => {
    const multi = [
      {
        id: 'q1',
        type: 'tool' as const,
        tool: 'queryInventory',
        label: '查杭州仓库存',
        status: 'pending' as const,
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'q2',
        type: 'tool' as const,
        tool: 'queryInventory',
        label: '查北京仓库存',
        status: 'pending' as const,
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const done = new Set<string>();

    // 第 1 次调用：只推进 q1
    expect(matchPlanStepsByTool(multi, 'queryInventory', done)).toEqual([0]);
    expect(done.has('q1')).toBe(true);
    expect(done.has('q2')).toBe(false);

    // 第 2 次调用：推进 q2（不能因"工具已声明过"直接返回空）
    expect(matchPlanStepsByTool(multi, 'queryInventory', done)).toEqual([1]);
    expect(done.has('q2')).toBe(true);
  });

  it('计划内多步同名工具 → 每次调用返回长度恒为 1（防全量标 done）', () => {
    const three = [
      {
        id: 't1',
        type: 'tool' as const,
        tool: 'queryStock',
        label: '步骤1',
        status: 'pending' as const,
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 't2',
        type: 'tool' as const,
        tool: 'queryStock',
        label: '步骤2',
        status: 'pending' as const,
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 't3',
        type: 'tool' as const,
        tool: 'queryStock',
        label: '步骤3',
        status: 'pending' as const,
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    const done = new Set<string>();
    const lens = [
      matchPlanStepsByTool(three, 'queryStock', done).length,
      matchPlanStepsByTool(three, 'queryStock', done).length,
      matchPlanStepsByTool(three, 'queryStock', done).length,
    ];
    expect(lens).toEqual([1, 1, 1]);
    expect(done.size).toBe(3);
    // 第 4 次：无未完成同名步骤 → 不推进
    expect(matchPlanStepsByTool(three, 'queryStock', done)).toEqual([]);
  });

  it('计划外工具 → 兜底推进最早未完成步骤（进度条不卡死）', () => {
    const done = new Set<string>();
    // unknownTool 不在计划内，按"严格按序推进"语义补一步
    expect(matchPlanStepsByTool(STEPS, 'unknownTool', done)).toEqual([0]);
    expect(done.has('s1')).toBe(true);
  });

  it('未声明工具的步骤（总结步），最终能被兜底推进', () => {
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

/**
 * collectSkippedPlanStepIndexes —— plan_step 收尾兜底（2026-10-03）
 *
 * 存在原因：LLM 用计划外工具完成任务时，matchPlanStepsByTool 命中不了那些步骤，
 * 计划卡会卡在 N/M。循环结束后把未匹配步骤标 skipped，避免虚报"N/N 完成"。
 */
describe('collectSkippedPlanStepIndexes', () => {
  /** 真实计划形态：末尾必有 type:'end' 的收尾步（planner.service.ts:324-325 强制补） */
  const PLAN_WITH_END: PlanStep[] = [
    step({ id: 's1', label: '查询库存', type: 'tool', tool: 'queryInventory' }),
    step({ id: 's2', label: '生成补货单', type: 'tool', tool: 'createOrder' }),
    step({ id: 'end', label: '完成', type: 'end' }),
  ];

  it('end 收尾步永远不进skipped（P0 回归：否则每张卡最后一步都显示"已跳过"）', () => {
    // 即便 s1/s2 全部完成、只剩 end 未匹配
    const done = new Set<string>(['s1', 's2', 'end']);
    expect(collectSkippedPlanStepIndexes(PLAN_WITH_END, done)).toEqual([]);
  });

  it('end 步不被匹配是必然的——反证：精确匹配与顺序兜底都碰不到它', () => {
    const done = new Set<string>();
    // 前两步依次被计划外工具推进
    matchPlanStepsByTool(PLAN_WITH_END, 'unknownA', done);
    matchPlanStepsByTool(PLAN_WITH_END, 'unknownB', done);
    expect([...done]).toEqual(['s1', 's2']);
    // end 步既没 tool 精确匹配、又是最后一个未完成项，顺序兜底也到不了
    expect(done.has('end')).toBe(false);
    // 所以兜底标记必须跳过它，否则用户永远看到"完成（已跳过）"
    expect(collectSkippedPlanStepIndexes(PLAN_WITH_END, done)).toEqual([]);
  });

  it('工具失败未写入 doneIds → 该步被如实标 skipped（不虚报完成）', () => {
    const done = new Set<string>(['s1']); // s2 的工具失败，未标 done
    expect(collectSkippedPlanStepIndexes(PLAN_WITH_END, done)).toEqual([1]);
  });

  it('计划外工具完成任务 → 未匹配的真实步骤被标 skipped', () => {
    const done = new Set<string>(['s1']); // s2 从未被任何工具命中
    expect(collectSkippedPlanStepIndexes(PLAN_WITH_END, done)).toEqual([1]);
  });

  it('下标升序且对应原数组位置（前端按index 渲染）', () => {
    const plan: PlanStep[] = [
      step({ id: 'a', label: 'A', type: 'tool' }),
      step({ id: 'b', label: 'B', type: 'tool' }),
      step({ id: 'c', label: 'C', type: 'tool' }),
      step({ id: 'end', label: '完成', type: 'end' }),
    ];
    expect(collectSkippedPlanStepIndexes(plan, new Set(['b']))).toEqual([0, 2]);
  });

  it('全部完成 → 无skipped（不产生多余事件）', () => {
    const done = new Set<string>(['s1', 's2', 'end']);
    expect(collectSkippedPlanStepIndexes(PLAN_WITH_END, done)).toEqual([]);
  });

  it('空计划 / 空数组 → 空结果，不抛异常', () => {
    expect(collectSkippedPlanStepIndexes([], new Set())).toEqual([]);
    expect(
      collectSkippedPlanStepIndexes(
        undefined as unknown as PlanStep[],
        new Set(),
      ),
    ).toEqual([]);
  });

  it('无 type 字段的旧数据按普通步骤处理（不误排除）', () => {
    const legacy = [
      { id: 'x', label: '旧步骤' } as PlanStep,
      { id: 'end', label: '完成' } as PlanStep,
    ];
    // 两步都没在 done 里 → 都应被标 skipped（含无 type 的 end 同名步）
    expect(collectSkippedPlanStepIndexes(legacy, new Set())).toEqual([0, 1]);
  });
});
