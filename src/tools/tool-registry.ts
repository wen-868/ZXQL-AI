import { Injectable, Logger } from '@nestjs/common';
import type { ToolDefinition } from '../providers/provider.interface';
import { ITool, ToolCategory, ToolMeta, ToolScope } from './tool.interface';

/**
 * Tool 注册中心
 *
 * 职责：
 * 1. 注册所有业务工具（order/inventory/product/customer/purchase/delivery/finance/report/system）
 * 2. 按名称查找工具（供 ToolExecutor 调用）
 * 3. 列出全部工具元信息（供工作台展示）
 * 4. 生成 OpenAI Function Calling 格式的 ToolDefinition[]（喂给 LLM）
 * 5. 按租户过滤可用工具（任务文件要求"按租户配置哪些工具可用"）
 *
 * 设计权衡：
 * - 当前阶段（R70-04）租户配置表 t_tenant_ai_config 尚未接入（R70-07 才做），
 *   按租户过滤采用内存 Map 兜底，默认所有工具对所有租户启用。
 *   R70-07 AiConfigService 接入后，调用 setTenantDisabledTools() 注入租户级禁用清单。
 * - 工具注册在模块初始化阶段完成（构造函数或 OnModuleInit），运行期只读不写，
 *   避免 LLM 调用过程中工具列表变动引发竞态。
 *
 * 用法：
 *   registry.register(new EchoTool());
 *   const tool = registry.get('echo');
 *   const defs = registry.toToolDefinitions(); // 传给 LLM
 *   const tenantDefs = registry.toToolDefinitionsForTenant(tenantId); // 按租户过滤
 */
@Injectable()
export class ToolRegistry {
  private readonly logger = new Logger(ToolRegistry.name);

  /** 工具池：name → ITool 实例 */
  private readonly tools = new Map<string, ITool>();

  /**
   * 租户级禁用工具清单：tenantId → Set<toolName>
   *
   * 默认空 Map（所有工具对所有租户启用）。
   * 由 R70-07 AiConfigService 在加载租户配置后调用 setTenantDisabledTools() 注入。
   */
  private readonly disabledToolsByTenant = new Map<string, Set<string>>();

  /**
   * 注册工具
   *
   * @param tool 实现 ITool 接口的工具实例
   *
   * 重复注册时覆盖旧实例并打 warn（NestJS 热重载场景可能触发，生产环境应避免重复注册）。
   */
  register(tool: ITool): void {
    if (this.tools.has(tool.name)) {
      this.logger.warn(
        `工具 "${tool.name}" 已存在，将被覆盖注册。请检查是否重复注册（category=${tool.category}）`,
      );
    }
    this.tools.set(tool.name, tool);
    this.logger.debug(
      `注册工具：${tool.name}（category=${tool.category}, isWriteOperation=${tool.isWriteOperation}）`,
    );
  }

  /**
   * 批量注册工具
   */
  registerAll(tools: ITool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 按名称查找工具
   *
   * @returns 工具实例；不存在返回 undefined
   */
  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /**
   * 判断工具是否已注册
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * 注销工具（P3 进化回滚 / 动态工具移除）
   *
   * @returns 是否存在并移除
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * 列出已注册工具的元信息（不含 execute 函数，可安全序列化到 JSON 响应）
   *
   * @param scope 工具作用域过滤：传 'platform' 时包含总台工具；
   *              不传或传 'mgmt' 时排除 platform 工具（租户侧安全默认）
   */
  list(scope?: ToolScope): ToolMeta[] {
    return Array.from(this.tools.values())
      .filter((tool) => this.isVisibleInScope(tool, scope))
      .map((tool) => this.toMeta(tool));
  }

  /**
   * 列出指定业务域的工具元信息
   */
  listByCategory(category: ToolCategory): ToolMeta[] {
    return this.list().filter((tool) => tool.category === category);
  }

  /**
   * 列出指定租户可用的工具元信息（按租户过滤禁用清单，且排除 platform 工具）
   */
  listForTenant(tenantId: string): ToolMeta[] {
    const base = this.list();
    const disabled = this.disabledToolsByTenant.get(tenantId);
    if (!disabled || disabled.size === 0) {
      return base;
    }
    return base.filter((tool) => !disabled.has(tool.name));
  }

  /**
   * 生成工具的 OpenAI Function Calling 定义（喂给 LLM）
   *
   * @param scope 工具作用域过滤：不传/传 'mgmt' 时排除 platform 工具（租户侧安全默认）；
   *              传 'platform' 时包含全部工具（总台对话）
   */
  toToolDefinitions(scope?: ToolScope): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((tool) => this.isVisibleInScope(tool, scope))
      .map((tool) => this.toDefinition(tool));
  }

  /**
   * 按业务分类生成工具定义（意图驱动减负：只喂给 LLM 相关域的工具）
   *
   * categories 为空或包含 'all' 时回退全量（无法判断意图时保守兜底）。
   * platform 工具仍遵循 scope 隔离。
   */
  toToolDefinitionsForCategories(
    categories: ToolCategory[] | undefined,
    scope?: ToolScope,
  ): ToolDefinition[] {
    if (
      !categories ||
      categories.length === 0 ||
      categories.includes('all' as ToolCategory)
    ) {
      return this.toToolDefinitions(scope);
    }
    const set = new Set(categories);
    return Array.from(this.tools.values())
      .filter((tool) => this.isVisibleInScope(tool, scope))
      .filter((tool) => set.has(tool.category))
      .map((tool) => this.toDefinition(tool));
  }

  /**
   * 生成指定作用域的工具定义（显式入口，总台对话使用 scope='platform'）
   *
   * platform 场景包含租户工具 + 总台工具（总台运营需跨域操作）；
   * mgmt 场景只含租户工具。
   */
  toToolDefinitionsForScope(scope: ToolScope): ToolDefinition[] {
    return this.toToolDefinitions(scope);
  }

  /**
   * 工具是否在当前作用域可见
   *
   * - platform 场景（总台）：包含全部工具（租户工具 + 总台工具，总台需跨域操作）
   * - mgmt 场景（租户，默认）：仅租户工具，platform 工具绝不暴露
   */
  private isVisibleInScope(tool: ITool, scope?: ToolScope): boolean {
    const s = scope ?? 'mgmt';
    if (s === 'platform') return true;
    return (tool.scope ?? 'mgmt') === 'mgmt';
  }

  /**
   * 生成指定租户可用的 OpenAI Function Calling 定义（按租户过滤）
   *
   * Brain Engine 调用 LLM 时应使用此方法，确保 LLM 只看到该租户启用的工具。
   */
  toToolDefinitionsForTenant(tenantId: string): ToolDefinition[] {
    const disabled = this.disabledToolsByTenant.get(tenantId);
    if (!disabled || disabled.size === 0) {
      return this.toToolDefinitions();
    }
    return Array.from(this.tools.values())
      .filter((tool) => !disabled.has(tool.name))
      .map((tool) => this.toDefinition(tool));
  }

  /**
   * 设置租户级禁用工具清单
   *
   * 由 R70-07 AiConfigService 在加载租户配置后调用：
   *   registry.setTenantDisabledTools(tenantId, ['cancelSalesOrder', 'updateProductPrice']);
   *
   * 传空数组或 undefined 会清除该租户的禁用清单（恢复全部工具可用）。
   */
  setTenantDisabledTools(
    tenantId: string,
    toolNames: string[] | undefined,
  ): void {
    if (!toolNames || toolNames.length === 0) {
      this.disabledToolsByTenant.delete(tenantId);
      return;
    }
    this.disabledToolsByTenant.set(tenantId, new Set(toolNames));
    this.logger.debug(`租户 ${tenantId} 禁用工具：[${toolNames.join(', ')}]`);
  }

  /**
   * 获取已注册工具总数
   */
  size(): number {
    return this.tools.size;
  }

  /**
   * ITool → ToolMeta（剥离 execute 函数，可安全序列化）
   */
  private toMeta(tool: ITool): ToolMeta {
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      isWriteOperation: tool.isWriteOperation,
      risk: tool.risk ?? 'low',
      needsReview: tool.needsReview ?? tool.risk === 'high',
      requiredTools: tool.requiredTools,
      scope: tool.scope ?? 'mgmt',
      parameters: tool.parameters,
    };
  }

  /**
   * ITool → ToolDefinition（OpenAI Function Calling 格式）
   *
   * 复用 provider.interface.ts 的 ToolDefinition 类型，确保与 Provider 层契约一致。
   */
  private toDefinition(tool: ITool): ToolDefinition {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }
}
