/**
 * Tool 系统接口定义
 *
 * 设计目标：为 AI 底座提供标准化的业务工具注册与执行机制。
 * AI 底座通过 Tool 系统调用现有 14 个微服务（销售/库存/商品/客户/采购/配送/财务/报表/系统），
 * 每个 Tool 封装一次业务操作，由 LLM 通过 Function Calling 触发，由 ToolExecutor 安全执行。
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第四章 Tool Runtime
 * - docs/ai-base/智享AI底座-开发文档.md 第七章 Tool 开发指南
 * - docs/ai-base/智享AI助手-能力说明书.md（9 大业务域 24 个工具清单）
 *
 * 设计原则：
 * 1. 复用 provider.interface.ts 的 ToolDefinition / ToolCall 类型，避免重复定义
 * 2. ITool 接口对齐 OpenAI Function Calling 规范，ToolRegistry.toToolDefinitions() 可直接喂给 LLM
 * 3. 写操作标记 isWriteOperation，配合 R70-15 确认机制实现"先预览后执行"
 * 4. 工具依赖 requiredTools，标注复合工具的前置工具（如 createSalesOrder 依赖 searchCustomer/searchProduct/checkInventory）
 * 5. ToolResult.data 用 unknown 而非 any（遵循踩坑日志 #10：避免 any 掩盖联合类型运算问题）
 */

/**
 * 工具业务域分类
 *
 * 与 docs/ai-base/智享AI助手-能力说明书.md 的 9 大业务域对齐，
 * 用于工作台按分类展示工具、按租户启用/禁用整个业务域。
 */
export type ToolCategory =
  | 'order' // 销售管理
  | 'inventory' // 库存管理
  | 'product' // 商品管理
  | 'customer' // 客户管理
  | 'purchase' // 采购管理
  | 'delivery' // 配送管理
  | 'finance' // 财务管理
  | 'report' // 报表分析
  | 'marketing' // 营销管理
  | 'platform' // 总台/平台管理
  | 'system' // 系统管理
  | 'utility'; // 工具类（如 echo 测试工具）

/**
 * 工具风险分级（P0-5，完善度-人工确认闸）
 *
 * - low：只读/查询、无副作用
 * - medium：生成草稿/本地计算，可撤回
 * - high：对外发布/资金/不可逆写/涉客诉，命中审核点须人工确认
 */
export type ToolRisk = 'low' | 'medium' | 'high';

/**
 * 工具作用域（第三批：总台级工具仅 platform 场景暴露）
 *
 * - mgmt：管理系统租户域（默认），租户对话可见
 * - platform：总台/平台域（requirePlatformAuth），仅 scope=platform 的对话可见，租户侧绝不暴露
 */
export type ToolScope = 'mgmt' | 'platform';

/**
 * 工具执行上下文
 *
 * 由 Brain Engine / Gateway 在调用 Tool 前组装并注入。
 * tenantId 为必填项，用于多租户隔离（任务文件要求"按租户配置哪些工具可用"）。
 *
 * 注意：当前阶段（R70-04）tenantId 由调用方传入；R70-07 多租户任务接入后，
 * 改由 TenantGuard 从 JWT 解析并写入 AsyncLocalStorage，Tool 自动获取。
 */
export interface ToolContext {
  /** 租户 ID（必填，用于数据隔离和工具权限校验） */
  tenantId: string;
  /** 当前用户 ID（可选，用于审计日志和权限校验） */
  userId?: string;
  /** 会话 ID（可选，用于关联对话上下文） */
  sessionId?: string;
  /** 请求追踪 ID（可选，用于全链路日志关联） */
  requestId?: string;
  /** 用户角色（可选，用于细粒度权限校验，如仅管理员可改价） */
  role?: string;
  /** 客户 ID（可选，运营客户端 customerScope 隔离：role=customer 时必填） */
  customerId?: string;
  /** 用户 JWT token（可选，ServiceClient 透传给后端 API 做认证） */
  authToken?: string;
}

/**
 * 工具执行结果
 *
 * 所有 Tool 的 execute() 必须返回此结构，禁止抛异常（异常由 ToolExecutor 统一捕获）。
 *
 * 写操作（isWriteOperation=true）的 Tool 在"预览阶段"应返回 success=true + preview，
 * 由 R70-15 ConfirmationService 暂存预览，等用户确认后再调用一次 execute() 真正执行。
 */
export interface ToolResult {
  /** 是否执行成功 */
  success: boolean;
  /**
   * 返回数据（成功时携带）
   *
   * 用 unknown 而非 any：遵循踩坑日志 #10，避免 any 掩盖联合类型运算问题，
   * 调用方需用类型守卫或断言访问具体字段。
   */
  data?: unknown;
  /** 错误信息（失败时携带，面向 LLM 友好的描述，不泄露内部栈） */
  error?: string;
  /** 建议措施（失败时可选，告诉 LLM 下一步该如何补救，如"请先调用 searchCustomer 查询客户"） */
  suggestion?: string;
  /**
   * 写操作预览（仅 isWriteOperation=true 的工具在预览阶段返回）
   *
   * 配合 R70-15 确认机制：用户看到预览卡片后"确认"才会真正执行。
   * operation-操作名 / summary-一句话摘要 / details-结构化明细（供前端渲染表格/卡片）。
   */
  preview?: {
    /** 操作类型（如"创建销售单"、"调拨库存"），用于预览卡片标题 */
    operation: string;
    /** 一句话摘要（如"红星商行 20 件五粮液，合计 19600 元"），用于卡片副标题 */
    summary: string;
    /** 结构化明细（客户/商品/数量/单价/合计/价格来源/库存状态等），供前端渲染表格 */
    details: Record<string, unknown>;
    /** 是否需人工审核（true 时前端预览卡标记审核中，P0-4 人工确认闸） */
    reviewRequired?: boolean;
  };
}

/**
 * Tool 接口
 *
 * 每个业务工具实现此接口，由 ToolRegistry 注册、ToolExecutor 执行。
 *
 * 实现规范（见开发文档 7.3）：
 * - name：唯一，camelCase，语义明确（如 createSalesOrder、queryInventory）
 * - description：必须描述清楚用途、前置条件、返回内容（LLM 据此判断何时调用）
 * - parameters：JSON Schema 对象，每个字段必须有 description，required 字段标注，状态/类型字段用 enum 约束
 * - category：业务域分类，用于工作台分组展示
 * - isWriteOperation：写操作标记，true 时需配合 R70-15 确认机制
 * - requiredTools：前置工具依赖（如 createSalesOrder 依赖 searchCustomer/searchProduct/checkInventory），供 Brain Engine 编排
 * - execute：执行函数，禁止抛异常，所有错误通过返回 ToolResult.success=false 传递
 */
export interface ITool {
  /** 工具名称（唯一，camelCase） */
  readonly name: string;
  /** 工具描述（LLM 据此判断何时调用） */
  readonly description: string;
  /**
   * 参数 JSON Schema（OpenAI Function Calling 规范）
   *
   * 结构：{ type: 'object', properties: {...}, required: [...] }
   * 直接作为 ToolDefinition.function.parameters 使用。
   */
  readonly parameters: object;
  /** 业务域分类 */
  readonly category: ToolCategory;
  /** 是否为写操作（true 时需配合确认机制） */
  readonly isWriteOperation: boolean;
  /** 风险分级（P0-5，默认 low；high 时图执行命中人工闸） */
  readonly risk?: ToolRisk;
  /** 是否强制人工审核（true 时即使 risk 非 high 也进闸） */
  readonly needsReview?: boolean;
  /** 前置工具依赖（可选，供 Brain Engine 编排复合工具调用） */
  readonly requiredTools?: string[];
  /** 工具作用域（可选，默认 mgmt；platform 仅总台对话暴露） */
  readonly scope?: ToolScope;

  /**
   * 执行工具
   *
   * @param args    LLM 传入的参数（已 JSON.parse，类型为对象）
   * @param context 执行上下文（含 tenantId 等）
   * @returns 执行结果（禁止抛异常，错误通过 success=false 传递）
   *
   * 实现要点：
   * 1. 内部 try-catch 包裹所有可能抛异常的操作（HTTP 调用、数据库访问等）
   * 2. 参数校验失败返回 { success: false, error: '参数 xxx 缺失' }
   * 3. 业务校验失败（如库存不足）返回 { success: false, error: '...', suggestion: '...' }
   * 4. 写操作预览阶段返回 { success: true, preview: {...} }，不真正执行写入
   * 5. 写操作执行阶段返回 { success: true, data: {...} }，包含创建的单据号等
   */
  execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult>;
}

/**
 * 工具元信息（工作台展示用，不含 execute 函数）
 *
 * ToolRegistry.list() / AdminController GET /tools 返回此结构，
 * 避免把 execute 函数序列化到 JSON 响应中。
 */
export interface ToolMeta {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 业务域分类 */
  category: ToolCategory;
  /** 是否为写操作 */
  isWriteOperation: boolean;
  /** 风险分级 */
  risk: ToolRisk;
  /** 是否强制人工审核 */
  needsReview: boolean;
  /** 前置工具依赖 */
  requiredTools?: string[];
  /** 工具作用域（mgmt 默认 / platform 仅总台） */
  scope: ToolScope;
  /** 参数 JSON Schema */
  parameters: object;
}

/**
 * 工具执行记录（审计用）
 *
 * 由 ToolExecutor 在每次执行后生成，供 R70-05 AuditLogger 写入 t_ai_audit_log 表。
 */
export interface ToolExecutionRecord {
  /** 工具名称 */
  toolName: string;
  /** 是否为写操作 */
  isWriteOperation: boolean;
  /** 执行是否成功 */
  success: boolean;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 入参（已脱敏，不含敏感字段） */
  args: Record<string, unknown>;
  /** 执行上下文（tenantId/userId 等） */
  context: ToolContext;
}
