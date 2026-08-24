/**
 * ToolRegistry 工具作用域（scope）隔离单元测试
 *
 * 覆盖第三批核心安全约束：
 * - platform 工具默认不进工具池（租户侧绝不暴露）
 * - listForTenant 排除 platform 工具
 * - toToolDefinitions('platform') / toToolDefinitionsForScope('platform') 包含平台工具
 * - list('platform') 元信息带 scope
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { ToolRegistry } from './tool-registry';
import type { ITool, ToolCategory } from './tool.interface';

function makeTool(
  name: string,
  scope?: 'mgmt' | 'platform',
  category: ToolCategory = 'system',
): ITool {
  return {
    name,
    description: `工具 ${name}`,
    category,
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    scope,
    execute: jest.fn().mockResolvedValue({ success: true, data: {} }),
  };
}

describe('ToolRegistry scope 隔离', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.register(makeTool('querySaleBills'));
    registry.register(makeTool('api_platform_query_tenants', 'platform'));
    registry.register(makeTool('api_platform_query_monitor', 'platform'));
  });

  it('toToolDefinitions 默认排除 platform 工具（租户侧安全默认）', () => {
    const defs = registry.toToolDefinitions();
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('querySaleBills');
    expect(names).not.toContain('api_platform_query_tenants');
    expect(names).not.toContain('api_platform_query_monitor');
  });

  it('toToolDefinitions(platform) 包含全部工具', () => {
    const defs = registry.toToolDefinitions('platform');
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('querySaleBills');
    expect(names).toContain('api_platform_query_tenants');
    expect(names).toContain('api_platform_query_monitor');
  });

  it('toToolDefinitionsForScope(platform) 包含平台工具，mgmt 只含租户工具', () => {
    const platformNames = registry
      .toToolDefinitionsForScope('platform')
      .map((d) => d.function.name);
    expect(platformNames).toContain('api_platform_query_tenants');

    const mgmtNames = registry
      .toToolDefinitionsForScope('mgmt')
      .map((d) => d.function.name);
    expect(mgmtNames).toContain('querySaleBills');
    expect(mgmtNames).not.toContain('api_platform_query_tenants');
  });

  it('listForTenant 排除 platform 工具', () => {
    const metas = registry.listForTenant('tenant-1');
    const names = metas.map((m) => m.name);
    expect(names).toContain('querySaleBills');
    expect(names).not.toContain('api_platform_query_tenants');
  });

  it('list(platform) 包含全部工具且 scope 字段标注正确', () => {
    const metas = registry.list('platform');
    // platform 场景包含租户工具 + 总台工具
    expect(metas.map((m) => m.name)).toContain('querySaleBills');
    expect(
      metas.every((m) => m.scope === 'mgmt' || m.scope === 'platform'),
    ).toBe(true);
    expect(metas.some((m) => m.name === 'api_platform_query_tenants')).toBe(
      true,
    );
    expect(
      metas.find((m) => m.name === 'api_platform_query_tenants')?.scope,
    ).toBe('platform');
  });

  it('toToolDefinitionsForCategories 只返回指定分类工具', () => {
    registry.register(makeTool('queryInventory', 'mgmt', 'inventory'));
    const defs = registry.toToolDefinitionsForCategories(['inventory']);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('queryInventory');
    expect(names).not.toContain('querySaleBills');
  });

  it('toToolDefinitionsForCategories 空分类回退全量', () => {
    const defs = registry.toToolDefinitionsForCategories(undefined);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain('querySaleBills');
    expect(names).not.toContain('api_platform_query_tenants');
  });
});
