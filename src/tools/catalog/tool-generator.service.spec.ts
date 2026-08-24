/**
 * ToolGeneratorService 单元测试（P0-8 功能即技能）
 *
 * 覆盖：目录生成、注册幂等、开关读取
 */
import { ConfigService } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolRegistry } from '../tool-registry';
import { API_CATALOG } from './api-catalog';
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

describe('ToolGeneratorService', () => {
  it('目录生成工具数量与目录一致', () => {
    const generator = makeGenerator();
    const tools = generator.generate();
    expect(tools).toHaveLength(API_CATALOG.length);
    expect(tools[0].name).toMatch(/^api_/);
  });

  it('generateAndRegister 注册并跳过重复', () => {
    const generator = makeGenerator();
    const registry = new ToolRegistry();
    const first = generator.generateAndRegister(registry);
    const second = generator.generateAndRegister(registry);
    expect(first).toBe(API_CATALOG.length);
    expect(second).toBe(0); // 幂等
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
});
