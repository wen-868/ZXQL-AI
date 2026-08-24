import { ToolRegistry } from './tool-registry';
import { EchoTool } from './definitions/echo.tool';
import type { ITool, ToolResult } from './tool.interface';

/**
 * ToolRegistry 单元测试
 *
 * 验证工具注册/查找/列出/生成 OpenAI 定义/按租户过滤等核心能力。
 */

/**
 * 构造一个用于测试的 mock 工具
 */
function createMockTool(overrides: Partial<ITool> = {}): ITool {
  const defaults: ITool = {
    name: 'mockTool',
    description: '测试用 mock 工具',
    parameters: {
      type: 'object',
      properties: { foo: { type: 'string', description: '参数' } },
      required: ['foo'],
    },
    category: 'utility',
    isWriteOperation: false,
    execute: (_args, _ctx): Promise<ToolResult> =>
      Promise.resolve({ success: true, data: { mock: true } }),
  };
  return { ...defaults, ...overrides };
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('register / registerAll', () => {
    it('应能注册单个工具', () => {
      const tool = createMockTool({ name: 'tool1' });
      registry.register(tool);
      expect(registry.size()).toBe(1);
      expect(registry.has('tool1')).toBe(true);
    });

    it('应能批量注册工具', () => {
      registry.registerAll([
        createMockTool({ name: 'tool1' }),
        createMockTool({ name: 'tool2' }),
        createMockTool({ name: 'tool3' }),
      ]);
      expect(registry.size()).toBe(3);
    });

    it('重复注册同名工具应覆盖（不抛异常）', () => {
      const tool1 = createMockTool({ name: 'dup', description: '版本1' });
      const tool2 = createMockTool({ name: 'dup', description: '版本2' });
      registry.register(tool1);
      registry.register(tool2);
      expect(registry.size()).toBe(1);
      expect(registry.get('dup')?.description).toBe('版本2');
    });

    it('EchoTool 实例应能正常注册', () => {
      registry.register(new EchoTool());
      expect(registry.has('echo')).toBe(true);
      expect(registry.get('echo')?.category).toBe('utility');
    });
  });

  describe('get / has', () => {
    it('已注册的工具应能查到', () => {
      registry.register(createMockTool({ name: 'findable' }));
      expect(registry.has('findable')).toBe(true);
      expect(registry.get('findable')).toBeDefined();
    });

    it('未注册的工具应返回 undefined / false', () => {
      expect(registry.has('notExist')).toBe(false);
      expect(registry.get('notExist')).toBeUndefined();
    });
  });

  describe('list / listByCategory', () => {
    beforeEach(() => {
      registry.registerAll([
        createMockTool({ name: 'order1', category: 'order' }),
        createMockTool({ name: 'order2', category: 'order' }),
        createMockTool({ name: 'inv1', category: 'inventory' }),
        createMockTool({ name: 'echo', category: 'utility' }),
      ]);
    });

    it('list 应返回所有工具元信息（不含 execute 函数）', () => {
      const list = registry.list();
      expect(list).toHaveLength(4);
      const names = list.map((t) => t.name);
      expect(names).toContain('order1');
      expect(names).toContain('echo');
      // ToolMeta 不应包含 execute 函数
      list.forEach((meta) => {
        expect(meta).not.toHaveProperty('execute');
        expect(meta).toHaveProperty('name');
        expect(meta).toHaveProperty('description');
        expect(meta).toHaveProperty('category');
        expect(meta).toHaveProperty('isWriteOperation');
        expect(meta).toHaveProperty('parameters');
      });
    });

    it('listByCategory 应按业务域过滤', () => {
      expect(registry.listByCategory('order')).toHaveLength(2);
      expect(registry.listByCategory('inventory')).toHaveLength(1);
      expect(registry.listByCategory('finance')).toHaveLength(0);
    });
  });

  describe('toToolDefinitions', () => {
    it('应生成 OpenAI Function Calling 格式的定义数组', () => {
      registry.register(
        createMockTool({
          name: 'queryOrder',
          description: '查询订单',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        }),
      );
      const defs = registry.toToolDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]).toEqual({
        type: 'function',
        function: {
          name: 'queryOrder',
          description: '查询订单',
          parameters: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
          },
        },
      });
    });

    it('空注册中心应返回空数组', () => {
      expect(registry.toToolDefinitions()).toEqual([]);
    });

    it('EchoTool 生成的定义应能直接喂给 Provider.chatSync', () => {
      registry.register(new EchoTool());
      const defs = registry.toToolDefinitions();
      expect(defs[0].type).toBe('function');
      expect(defs[0].function.name).toBe('echo');
      expect(defs[0].function.parameters).toHaveProperty('required', [
        'message',
      ]);
    });
  });

  describe('按租户过滤', () => {
    beforeEach(() => {
      registry.registerAll([
        createMockTool({ name: 'toolA', category: 'order' }),
        createMockTool({ name: 'toolB', category: 'inventory' }),
        createMockTool({ name: 'toolC', category: 'finance' }),
      ]);
    });

    it('未设置禁用清单时，租户可见全部工具', () => {
      expect(registry.listForTenant('tenant1')).toHaveLength(3);
      expect(registry.toToolDefinitionsForTenant('tenant1')).toHaveLength(3);
    });

    it('设置禁用清单后，租户不可见被禁用工具', () => {
      registry.setTenantDisabledTools('tenant1', ['toolB', 'toolC']);
      const list = registry.listForTenant('tenant1');
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('toolA');
      expect(registry.toToolDefinitionsForTenant('tenant1')).toHaveLength(1);
    });

    it('不同租户的禁用清单相互隔离', () => {
      registry.setTenantDisabledTools('tenant1', ['toolA']);
      registry.setTenantDisabledTools('tenant2', ['toolB']);
      expect(registry.listForTenant('tenant1')).toHaveLength(2);
      expect(registry.listForTenant('tenant2')).toHaveLength(2);
      expect(registry.listForTenant('tenant3')).toHaveLength(3);
    });

    it('传入空数组清除租户禁用清单', () => {
      registry.setTenantDisabledTools('tenant1', ['toolA']);
      expect(registry.listForTenant('tenant1')).toHaveLength(2);
      registry.setTenantDisabledTools('tenant1', []);
      expect(registry.listForTenant('tenant1')).toHaveLength(3);
    });

    it('传入 undefined 清除租户禁用清单', () => {
      registry.setTenantDisabledTools('tenant1', ['toolA']);
      registry.setTenantDisabledTools('tenant1', undefined);
      expect(registry.listForTenant('tenant1')).toHaveLength(3);
    });
  });

  describe('size', () => {
    it('应返回已注册工具数量', () => {
      expect(registry.size()).toBe(0);
      registry.register(createMockTool({ name: 't1' }));
      expect(registry.size()).toBe(1);
      registry.register(createMockTool({ name: 't2' }));
      expect(registry.size()).toBe(2);
    });
  });
});
