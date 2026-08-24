/**
 * 有状态图（Graph）类型定义 — 完善度 P0-1/P0-2
 *
 * 依据《管理系统AI底座完善计划》P0-1/P0-2：
 * - Orchestrator 支持 react（单 Agent 循环）与 graph（有状态图）双模式
 * - graph 节点 = 域 Agent / 工具 / 条件 / 结束；边 = 流转条件
 * - 状态由 Checkpointer 按 tenantId+sessionId 持久化（Redis），支持暂停/恢复/续跑
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */

/** 图节点类型 */
export type GraphNodeType = 'agent' | 'tool' | 'condition' | 'end';

/** 图节点 */
export interface GraphNode {
  /** 节点唯一 ID（图内） */
  id: string;
  /** 中文名（SSE 展示，如"搜索客户"） */
  label: string;
  /** 节点类型 */
  type: GraphNodeType;
  /** type=tool 时：要执行的工具名 */
  tool?: string;
  /** type=tool 时：工具参数（P0 骨架静态参数；真实任务参数解析由 agent 节点完善） */
  args?: Record<string, unknown>;
  /** type=agent 时：节点指令（追加到系统提示，引导该域 Agent） */
  prompt?: string;
  /** type=agent 时：域 Agent 配置（P0-3 多 Agent 协作） */
  agent?: {
    /** Agent 系统提示（覆盖 prompt，体现域职责） */
    systemPrompt?: string;
    /** 该 Agent 可调用的工具白名单（工具名列表；不填则仅文本生成） */
    tools?: string[];
    /** 节点内最大工具循环轮数（默认 3） */
    maxToolRounds?: number;
  };
  /** 默认下一节点 ID（end 节点可省略） */
  next?: string;
  /** type=condition 时：条件流转，返回下一节点 ID；返回 undefined 走 next */
  condition?: (state: GraphState) => string | undefined;
  /** 命中人工闸（P0-4 对接审核流程；当前预留钩子） */
  needsReview?: boolean;
  /** 人工闸说明（SSE 展示确认点） */
  reviewNote?: string;
  /** 人工闸审核载荷（提交给工单的说明/明细） */
  reviewPayload?: Record<string, unknown>;
}

/** 图定义 */
export interface GraphDefinition {
  /** 图唯一 ID（如 sale_create_graph） */
  id: string;
  /** 图名（中文） */
  name: string;
  /** 入口节点 ID */
  entry: string;
  /** 全部节点 */
  nodes: GraphNode[];
}

/** 图状态（Checkpointer 持久化） */
export interface GraphState {
  graphId: string;
  tenantId: string;
  sessionId: string;
  /** 当前节点 ID（断点续跑位置） */
  currentNodeId: string;
  /** 状态：running 执行中 / paused 暂停（人工闸） / done 完成 / error 错误 */
  status: 'running' | 'paused' | 'done' | 'error';
  /** 节点产物（nodeId → 工具返回 data） */
  results: Record<string, unknown>;
  /** 已执行节点顺序（time-travel 回放） */
  nodeOrder: string[];
  /** 节点执行历史（含 label，SSE 步骤流） */
  history: Array<{ nodeId: string; label: string; success: boolean }>;
  /** 错误信息 */
  error?: string;
  /** 暂停等待的待审工单 ID（P0-4 人工闸） */
  pendingReviewId?: number;
  /** 更新时间戳 */
  updatedAt: number;
}

/** 图执行事件（Orchestrator SSE 输出） */
export type GraphEvent =
  | { type: 'node_start'; nodeId: string; label: string }
  | { type: 'node_end'; nodeId: string; label: string; success: boolean }
  | { type: 'graph_done'; graphId: string };

/** 内置图注册表（管理系统域，先落地骨架示例） */
export const BUILTIN_GRAPHS: Record<string, GraphDefinition> = {
  sale_create_graph: {
    id: 'sale_create_graph',
    name: '销售开单图',
    entry: 'search_customer',
    nodes: [
      {
        id: 'search_customer',
        label: '搜索客户',
        type: 'tool',
        tool: 'searchCustomer',
        next: 'check_inventory',
      },
      {
        id: 'check_inventory',
        label: '库存校验',
        type: 'tool',
        tool: 'checkInventory',
        next: 'create_sale',
      },
      {
        id: 'create_sale',
        label: '创建销售单',
        type: 'tool',
        tool: 'createSalesOrder',
        next: 'end',
      },
      { id: 'end', label: '完成', type: 'end' },
    ],
  },
  // 采购闭环图：补货分析 → 生成采购计划 → 结果总结（agent 节点带工具白名单）
  purchase_plan_graph: {
    id: 'purchase_plan_graph',
    name: '采购计划图',
    entry: 'analyze',
    nodes: [
      {
        id: 'analyze',
        label: '补货分析',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是补货分析 Agent。根据用户需求调用 api_suggest_purchase_plan 获取智能补货建议，' +
            '分析后输出建议摘要（商品、建议量、原因）。',
          tools: ['api_suggest_purchase_plan'],
          maxToolRounds: 2,
        },
        next: 'plan',
      },
      {
        id: 'plan',
        label: '生成采购计划',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是采购计划生成 Agent。基于补货建议整理采购明细，' +
            '调用 api_create_purchase_plan 创建采购计划（先 confirm=false 预览，向用户确认后再 confirm=true 执行）。',
          tools: ['api_create_purchase_plan', 'api_query_purchase_plans'],
          maxToolRounds: 4,
        },
        needsReview: true,
        reviewNote: '采购计划创建涉及采购资金，需人工确认',
        next: 'summarize',
      },
      {
        id: 'summarize',
        label: '结果总结',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是结果总结 Agent。汇总采购计划结果，用简洁中文向用户说明：计划单号、商品数、建议总量、下一步操作。',
        },
        next: 'end',
      },
      { id: 'end', label: '完成', type: 'end' },
    ],
  },
  // 营销活动配置图：解析意图 → 创建活动 → 激活 → 总结
  marketing_create_graph: {
    id: 'marketing_create_graph',
    name: '营销活动配置图',
    entry: 'understand',
    nodes: [
      {
        id: 'understand',
        label: '活动意图理解',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是营销活动 Agent。理解用户想创建的活动类型（优惠券/秒杀/满减/拼团/赠品/限量折扣），' +
            '调用对应创建工具（api_create_coupon_template / api_create_flash_sale / api_create_full_reduction / ' +
            'api_create_group_buy / api_create_gift_rule / api_create_limited_discount），' +
            '先 confirm=false 预览，向用户确认后再 confirm=true 创建。',
          tools: [
            'api_create_coupon_template',
            'api_create_flash_sale',
            'api_create_full_reduction',
            'api_create_group_buy',
            'api_create_gift_rule',
            'api_create_limited_discount',
            'api_query_coupon_templates',
            'api_query_flash_sales',
            'api_query_marketing_overview',
          ],
          maxToolRounds: 6,
        },
        needsReview: true,
        reviewNote: '营销活动创建涉及对外优惠，需人工确认',
        next: 'activate',
      },
      {
        id: 'activate',
        label: '活动激活建议',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是活动运营 Agent。活动创建后询问用户是否激活，确认后调用 ' +
            'api_set_marketing_activity_status 激活活动。',
          tools: ['api_set_marketing_activity_status'],
          maxToolRounds: 3,
        },
        next: 'summarize',
      },
      {
        id: 'summarize',
        label: '结果总结',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是结果总结 Agent。汇总营销活动配置结果：活动名称、类型、状态、生效时间，用简洁中文向用户说明。',
        },
        next: 'end',
      },
      { id: 'end', label: '完成', type: 'end' },
    ],
  },
  // 库存盘点图：库存分析 → 创建盘点 → 差异处理建议
  stock_check_graph: {
    id: 'stock_check_graph',
    name: '库存盘点图',
    entry: 'analyze',
    nodes: [
      {
        id: 'analyze',
        label: '库存分析',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是库存分析 Agent。调用 api_query_stock_warnings / api_query_inventory_batches 了解库存与预警，' +
            '分析需要盘点的门店与重点商品。',
          tools: [
            'api_query_stock_warnings',
            'api_query_inventory_batches',
            'api_query_inventory',
          ],
          maxToolRounds: 3,
        },
        next: 'check',
      },
      {
        id: 'check',
        label: '创建盘点',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是盘点执行 Agent。调用 stockCheck 创建盘点单（先 confirm=false 预览，确认后 confirm=true 执行）。',
          tools: ['stockCheck'],
          maxToolRounds: 3,
        },
        needsReview: true,
        reviewNote: '库存盘点影响账面库存，需人工确认',
        next: 'summarize',
      },
      {
        id: 'summarize',
        label: '差异总结',
        type: 'agent',
        agent: {
          systemPrompt:
            '你是盘点总结 Agent。汇总盘点结果与差异处理建议，用简洁中文向用户说明。',
        },
        next: 'end',
      },
      { id: 'end', label: '完成', type: 'end' },
    ],
  },
};
