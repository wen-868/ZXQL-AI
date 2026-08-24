/**
 * ProviderRouterService 单元测试（C9 自适应路由，P0-6）
 *
 * 覆盖：用户指定模型优先、租户配置、回退内置默认、scope 读取
 */
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from '../../providers/provider-factory';
import { ProviderRouterService } from './provider-router.service';
import type { ResolvedAiConfig } from '../../tenant/ai-config.service';

function makeRouter(registered: Record<string, unknown> = {}, scope = 'mgmt') {
  const factory = {
    isRegistered: jest.fn((name: string) => name in registered),
    create: jest.fn((name: string, _config?: unknown) => ({
      name,
      configured: Boolean(_config),
    })),
  };
  const config = {
    get: jest.fn((key: string) => (key === 'SYSTEM_SCOPE' ? scope : undefined)),
  };
  const router = new ProviderRouterService(
    factory as unknown as ProviderFactory,
    config as unknown as ConfigService,
  );
  return { router, factory };
}

function makeResolved(
  overrides: Partial<ResolvedAiConfig> = {},
): ResolvedAiConfig {
  return {
    provider: 'deepseek',
    providerConfig: {
      apiKey: 'sk-x',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    },
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 2048,
    systemPrompt: null,
    source: 'platform',
    ...overrides,
  };
}

describe('ProviderRouterService', () => {
  it('用户指定已注册模型时优先使用', () => {
    const { router, factory } = makeRouter({ custom_kimi: {} });
    const result = router.route({
      requestedModel: 'custom_kimi',
      resolved: makeResolved(),
      systemScope: 'mgmt',
    });
    expect(result.providerName).toBe('custom_kimi');
    expect(result.reason).toContain('用户指定');
    expect(factory.create).toHaveBeenCalledWith('custom_kimi');
  });

  it('未指定模型时使用租户/平台配置', () => {
    const { router } = makeRouter();
    const result = router.route({
      resolved: makeResolved({ provider: 'glm' }),
      systemScope: 'mgmt',
    });
    expect(result.providerName).toBe('glm');
    expect(result.reason).toContain('租户/平台配置');
  });

  it('用户指定未注册模型时忽略并走配置', () => {
    const { router } = makeRouter();
    const result = router.route({
      requestedModel: 'not_exist',
      resolved: makeResolved(),
      systemScope: 'mgmt',
    });
    expect(result.providerName).toBe('deepseek');
  });

  it('配置 Provider 不可用时回退内置默认', () => {
    const factory = {
      isRegistered: jest.fn(() => false),
      create: jest.fn((name: string) => {
        if (name === 'deepseek') throw new Error('未配置');
        return { name };
      }),
    };
    const router = new ProviderRouterService(
      factory as unknown as ProviderFactory,
      { get: jest.fn(() => 'mgmt') } as unknown as ConfigService,
    );
    const result = router.route({
      resolved: makeResolved(),
      systemScope: 'mgmt',
    });
    expect(result.providerName).toBe('glm');
    expect(result.reason).toContain('回退');
  });

  it('getSystemScope 读取 SYSTEM_SCOPE', () => {
    const { router } = makeRouter({}, 'ops');
    expect(router.getSystemScope()).toBe('ops');
  });
});
