/**
 * Agent 自主执行内核 — 类型定义（批次2，文档 22 章）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md
 * - 22.2 自主执行闭环（ReAct）
 * - 22.4 长任务（TaskRunner）：任务/步骤状态枚举统一口径、断点续跑、人工介入、单步容错
 * - 22.5 自愈回路（SelfHealLoop）
 * - 22.8 决策 25：agent_step SSE 事件（前端实时看到"思考→调用→观察"）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */

/** 步骤状态（22.4 统一口径六态） */
export type PlanStepStatus =
  | 'pending' // 待执行
  | 'running' // 执行中
  | 'success' // 成功
  | 'failed' // 失败（触发自愈或单步容错）
  | 'suspended' // 挂起待人工确认
  | 'skipped'; // 跳过

/** 计划级状态（与步骤级六态一致） */
export type PlanState = PlanStepStatus;

/** 计划步骤类型 */
export type PlanStepType = 'tool' | 'agent' | 'condition' | 'end';

/** 计划步骤（持久化到 ai_execution_plan.steps JSON） */
export interface PlanStep {
  /** 步骤唯一 ID（计划内） */
  id: string;
  /** 中文名（SSE 展示，如"搜索客户"） */
  label: string;
  /** 步骤类型 */
  type: PlanStepType;
  /** type=tool：工具名 */
  tool?: string;
  /** type=tool：工具参数 */
  args?: Record<string, unknown>;
  /** type=agent：节点指令/目标 */
  prompt?: string;
  /** 默认下一节点 ID（end 可省略） */
  next?: string;
  /** 步骤状态 */
  status: PlanStepStatus;
  /** 执行结果 data */
  result?: unknown;
  /** 失败原因 */
  error?: string;
  /** 自愈重试次数 */
  retryCount: number;
  /** 自愈记录（修正路径，回流认知层） */
  healLog?: Array<{
    at: number;
    action: 'retry' | 'fix_args' | 'clarify' | 'give_up';
    detail?: string;
  }>;
  /** 写操作挂起令牌（WriteGuard token，await_confirm 用） */
  pendingToken?: string;
  /** 写操作预览（确认卡渲染） */
  preview?: Record<string, unknown>;
  /** 创建/更新时间戳 */
  createdAt: number;
  updatedAt: number;
}

/** 计划对象（内存模型，持久化为 entity） */
export interface ExecutionPlan {
  /** 计划 ID（ai_execution_plan.id） */
  id: number;
  tenantId: string;
  goal: string;
  steps: PlanStep[];
  state: PlanState;
  createdBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

/** 自愈动作 */
export type HealAction = 'retry' | 'fix_args' | 'clarify' | 'give_up';

/** 自愈建议结果 */
export interface HealSuggestion {
  action: HealAction;
  /** 修正后的参数（fix_args 时携带） */
  args?: Record<string, unknown>;
  /** 给 LLM/用户的说明（clarify 时携带问题） */
  message?: string;
  /** 是否仍失败则终止（give_up） */
  giveUp?: boolean;
}

/** Agent 内核产出事件（SSE，决策 25 agent_step 过程可见） */
export type AgentRunEvent =
  | {
      /** 思考/执行步骤流转（前端实时展示"思考→调用→观察"） */
      type: 'agent_step';
      planId: number;
      stepId: string;
      label: string;
      status: PlanStepStatus;
      detail?: string;
    }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; tool: string; args?: Record<string, unknown> }
  | {
      type: 'tool_result';
      tool: string;
      success: boolean;
      data?: unknown;
      error?: string;
      preview?: Record<string, unknown>;
      confirmationId?: string;
    }
  | {
      type: 'pending_write';
      token: string;
      preview?: Record<string, unknown>;
      writeType: string;
      expireAt: number;
    }
  | { type: 'await_confirm'; token: string; expireAt: number }
  | {
      type: 'done';
      planId: number;
      state: PlanState;
      usage: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        latencyMs: number;
        steps: number;
      };
    }
  | { type: 'error'; message: string; code?: string };

/** 计划执行上下文 */
export interface PlanRunContext {
  tenantId: string;
  userId?: string;
  role?: string;
  /** 客户 ID（运营客户端 customerScope 隔离） */
  customerId?: string;
  authToken?: string;
  sessionId?: string;
  /** 对话级模型标识（可选） */
  model?: string;
  /** 工具作用域：mgmt=租户域（默认）/ platform=总台域 */
  scope?: 'mgmt' | 'platform';
}

/** 已知业务模板（Planner 确定性分解，映射 BUILTIN_GRAPHS） */
export const PLAN_TEMPLATE_HINTS: Array<{
  id: string;
  keywords: string[];
  description: string;
}> = [
  {
    id: 'sale_create_graph',
    keywords: ['开单', '建单', '下单', '销售单', '卖', '出单', '打单'],
    description: '销售开单',
  },
  {
    id: 'purchase_plan_graph',
    keywords: ['采购', '补货', '进货', '订货'],
    description: '采购计划',
  },
  {
    id: 'marketing_create_graph',
    keywords: ['营销', '优惠券', '秒杀', '满减', '拼团', '赠品', '活动'],
    description: '营销活动配置',
  },
  {
    id: 'stock_check_graph',
    keywords: ['盘点', '库存盘点'],
    description: '库存盘点',
  },
];
