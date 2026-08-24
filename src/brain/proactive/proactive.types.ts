/**
 * 主动能力模块 — 公共类型定义
 *
 * 对应文档：
 * - docs/ai-base/智享AI助手-能力说明书.md 第三章 主动能力（A01-A09）
 * - docs/ai-base/智享AI助手-能力说明书.md 第五章 主动能力的触发机制（5.2 Cron 配置 / 5.4 通知优先级）
 *
 * 设计说明：
 * - 每个巡检任务实现 IProactiveTask 接口，由 ProactiveService 统一调度（@Cron 声明）
 * - 巡检数据通过共享 MySQL 实例直查（AI 底座与现有后端共用 liquor_inventory 库），
 *   后端业务/推送 API 全部 requireAuthWithTenant 需商家 JWT，定时任务无用户 JWT，故不依赖后端 API
 * - 推送结果统一写入 t_push_log（系统级，channel=ai_proactive）+ t_ai_audit_log（审计）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */

/**
 * 推送优先级（对齐能力说明书 5.4 通知优先级）
 * - urgent：紧急（库存售罄、配送严重超时），立即推送 + 声音提醒
 * - important：重要（库存偏低、订单积压），立即推送
 * - reminder：提醒（每日简报、催收提醒），定时推送
 * - suggestion：建议（补货建议、流失预警），静默推送
 */
export type ProactivePriority =
  'urgent' | 'important' | 'reminder' | 'suggestion';

/**
 * 推送类型（对齐后端 PushType：system/order/inventory/marketing）
 */
export type ProactivePushType = 'system' | 'order' | 'inventory' | 'marketing';

/**
 * AI 主动推送消息
 */
export interface ProactivePush {
  /** 推送标题（如"⚠️ 库存预警"） */
  title: string;
  /** 推送内容（markdown 表格，供对话窗口卡片渲染） */
  content: string;
  /** 推送类型 */
  type: ProactivePushType;
  /** 优先级 */
  priority: ProactivePriority;
  /** 附加数据（任务名、数量等） */
  extras?: Record<string, unknown>;
}

/**
 * 单租户巡检结果
 */
export interface ProactiveTaskResult {
  /** 任务名（kebab-case） */
  taskName: string;
  /** 租户 ID */
  tenantId: string;
  /** 检测到的异常/提醒条数 */
  found: number;
  /** 成功推送条数 */
  pushed: number;
  /** 错误信息（失败时携带） */
  error?: string;
}

/**
 * 巡检任务接口
 *
 * 由 ProactiveService 统一注册调度，@Cron/@Interval 声明在 ProactiveService 中，
 * 各巡检 Service 仅实现 execute() 单租户检测逻辑，便于独立单元测试。
 */
export interface IProactiveTask {
  /** 任务唯一名（kebab-case，如 inventory_warning） */
  readonly name: string;
  /** 任务描述（中文，工作台展示） */
  readonly description: string;
  /** 调度类型：cron（六位 cron 表达式）/ interval（毫秒） */
  readonly scheduleType: 'cron' | 'interval';
  /** 调度表达式：cron 字符串（如 '* /30 * * * *' 形式，等价于 *斜杠30 写法）或 interval 毫秒数 */
  readonly schedule: string;
  /** 推送优先级 */
  readonly priority: ProactivePriority;
  /** 推送类型 */
  readonly pushType: ProactivePushType;
  /**
   * 执行一次巡检（单个租户）
   *
   * 实现要求：
   * 1. 内部 try-catch 包裹全部逻辑，任何异常通过返回 error 字段传递，禁止抛异常
   * 2. 检测无异常时返回 { found: 0, pushed: 0 }，不产生推送
   * 3. 有异常时组装 ProactivePush 调 ProactivePushService.push 落库
   *
   * 声明为属性签名（而非方法签名），避免测试中脱离 this 调用触发
   * @typescript-eslint/unbound-method 规则误报（巡检方法本身无 this 依赖）。
   */
  readonly execute: (tenantId: string) => Promise<ProactiveTaskResult>;
}

/**
 * 任务运行状态（ProactiveController GET /jobs 返回）
 */
export interface ProactiveJobInfo {
  /** 任务名 */
  name: string;
  /** 任务描述 */
  description: string;
  /** 调度类型 */
  scheduleType: 'cron' | 'interval';
  /** 调度表达式 */
  schedule: string;
  /** 推送优先级 */
  priority: ProactivePriority;
  /** 推送类型 */
  pushType: ProactivePushType;
  /** 最近一次运行时间（ISO 字符串） */
  lastRunAt?: string;
  /** 最近一次运行结果摘要 */
  lastResult?: string;
}

/**
 * 数据库行（DataSource.query 返回结构）
 *
 * DataSource.query 返回 any[]，先断言为 Row[] 再访问字段，
 * 避免 eslint recommendedTypeChecked 的 no-unsafe-* 规则告警。
 */
export type Row = Record<string, unknown>;
