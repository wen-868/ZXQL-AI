/**
 * ToolGeneratorService 单元测试（P0-8 功能即技能）
 *
 * 覆盖：目录生成、注册幂等、开关读取、写条目 fail-closed 拒绝
 * （AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01：生成/注册层不得产出可执行写工具）
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolRegistry } from '../tool-registry';
import { API_CATALOG, ApiRouteDef } from './api-catalog';
import { ToolGeneratorService } from './tool-generator.service';

function makeGenerator(enabled = false) {
  const config = {
    get: jest.fn((key: string) =>
      key === 'ENABLE_API_CATALOG_TOOLS' ? String(enabled) : undefined,
    ),
  };
  const client = {} as unknown as ServiceClient;
  return new ToolGeneratorService(client, config as unknown as ConfigService);
}

/** 构造一个写条目（模拟未来目录混入写项 / evolution newtool 提案注入） */
function writeDef(over: Partial<ApiRouteDef> = {}): ApiRouteDef {
  return {
    name: 'api_create_hold_order',
    description: '创建挂单（未获准写条目）',
    category: 'order',
    method: 'POST',
    path: '/api/store/hold-orders',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: true,
    risk: 'medium',
    ...over,
  };
}

/** 构造一个合法读条目 */
function readDef(over: Partial<ApiRouteDef> = {}): ApiRouteDef {
  return {
    name: 'api_query_demo',
    description: '查询演示数据',
    category: 'system',
    method: 'GET',
    path: '/api/admin/demo',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: false,
    risk: 'low',
    ...over,
  };
}

describe('ToolGeneratorService', () => {
  let warnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    logSpy = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('目录生成工具数量与目录一致', () => {
    const generator = makeGenerator();
    const tools = generator.generate();
    expect(tools).toHaveLength(API_CATALOG.length);
    expect(tools[0].name).toMatch(/^api_/);
  });

  it('generateAndRegister 注册并跳过重复（返回结构化结果）', () => {
    const generator = makeGenerator();
    const registry = new ToolRegistry();
    const first = generator.generateAndRegister(registry);
    const second = generator.generateAndRegister(registry);
    expect(first.registered).toBe(API_CATALOG.length);
    expect(first.rejected).toEqual([]);
    expect(second.registered).toBe(0); // 幂等
    // list() 默认排除 platform 工具；platform scope 包含全部目录工具
    expect(registry.list('platform')).toHaveLength(API_CATALOG.length);
    expect(registry.size()).toBe(API_CATALOG.length);
  });

  it('开关关闭时 isEnabled 返回 false，开启返回 true', () => {
    expect(makeGenerator(false).isEnabled()).toBe(false);
    expect(makeGenerator(true).isEnabled()).toBe(true);
  });

  it('getCatalog 返回目录', () => {
    expect(makeGenerator().getCatalog()).toEqual(API_CATALOG);
  });

  // ══ 写条目 fail-closed（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01）══

  it('写条目生成拒绝：不产出可执行工具，rejected 结构化含工具名与原因（不静默）', () => {
    const generator = makeGenerator();
    const { tools, rejected } = generator.generateDetailed([writeDef()]);
    expect(tools).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].name).toBe('api_create_hold_order');
    expect(rejected[0].reason).toContain('fail-closed');
    // 显式可观测：拒绝必须落结构化日志（tool/method/path/reason）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('api_create_hold_order'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('动态工具定义已拒绝'),
    );
  });

  it('写条目注册拒绝：registry 不增长（size 与 list 均不变）', () => {
    const generator = makeGenerator();
    const registry = new ToolRegistry();
    const before = registry.size();
    const result = generator.generateAndRegister(registry, [writeDef()]);
    expect(result.registered).toBe(0);
    expect(result.rejected.map((r) => r.name)).toContain(
      'api_create_hold_order',
    );
    expect(registry.size()).toBe(before);
    expect(registry.has('api_create_hold_order')).toBe(false);
  });

  it('dynamicWriteCapability 显式声明不构成开放条件（默认关闭语义的契约）', () => {
    const generator = makeGenerator();
    const def = writeDef({
      dynamicWriteCapability: {
        preview: true,
        confirm: true,
        idempotent: true,
      },
    });
    const { tools, rejected } = generator.generateDetailed([def]);
    expect(tools).toHaveLength(0);
    expect(rejected[0].reason).toContain('dynamicWriteCapability');
    expect(rejected[0].reason).toContain('fail-closed');
  });

  it('批量内重复名称拒绝（非法元数据 fail-closed）', () => {
    const generator = makeGenerator();
    const { tools, rejected } = generator.generateDetailed([
      readDef(),
      readDef(),
    ]);
    expect(tools).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('批量内重复名称');
  });

  it('混合批次：读工具正常产出，写/非法条目拒绝且互不影响', () => {
    const generator = makeGenerator();
    const { tools, rejected } = generator.generateDetailed([
      readDef(),
      writeDef(),
      { ...readDef(), name: '', method: 'GET' } as unknown as ApiRouteDef,
      writeDef({ name: 'api_delete_thing', method: 'DELETE' }),
    ]);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('api_query_demo');
    expect(rejected.map((r) => r.name)).toEqual([
      'api_create_hold_order',
      '<空>',
      'api_delete_thing',
    ]);
    // 产出的全部是读工具（写条目不得静默降级成读工具混入）
    expect(tools.every((t) => !t.isWriteOperation)).toBe(true);
  });

  it('GET 与写标记冲突拒绝（非法方法元数据）', () => {
    const generator = makeGenerator();
    const { tools, rejected } = generator.generateDetailed([
      writeDef({ method: 'GET' }),
    ]);
    expect(tools).toHaveLength(0);
    expect(rejected[0].reason).toContain('GET 方法不得标记写操作');
  });

  it('空名称写条目拒绝（name 为空串与缺失两种形态）', () => {
    const generator = makeGenerator();
    const r1 = generator.generateDetailed([writeDef({ name: '  ' })]);
    const r2 = generator.generateDetailed([
      undefined as unknown as ApiRouteDef,
    ]);
    expect(r1.tools).toHaveLength(0);
    expect(r1.rejected[0].reason).toContain('空名称');
    expect(r2.tools).toHaveLength(0);
    expect(r2.rejected[0].name).toBe('<空>');
  });
});
