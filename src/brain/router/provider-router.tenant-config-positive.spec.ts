/**
 * R101-AI-01 缺口3：ProviderRouterService.route() 路径 1 的**正向语义**断言
 *
 * 背景：provider-router.service.ts route() 路径 1（用户显式指定已注册模型）在
 * e787dce（P0-3）后为：
 *   requested === input.resolved.provider
 *     ? this.factory.create(requested, input.resolved.providerConfig)   // 本租户凭据
 *     : this.factory.create(requested)                                  // env 默认
 * 独立验收（P0修复-独立验收-2026-10-09.md §8）指出：现有用例只断言
 * "不复用 A 的凭据"（负向），**正向语义**（用户指定的恰是本租户配置的 Provider 时，
 * 必须带上本租户 providerConfig 创建实例）零断言 ⇒ 若重构把该三元分支退化成
 * 无条件 `create(requested)`，用户显式选回配置 Provider 时会静默丢掉租户凭据
 * （落到 env 默认或无凭据实例），测试不会红。
 *
 * 反测方向（「修复不存在」）：把 provider-router.service.ts 路径 1 的三元分支
 * 回退成 e787dce 之前的无条件 `this.factory.create(requested)` ⇒ 本文件
 * "正向"用例必红（create 未收到第二参 resolved.providerConfig）；
 * "负向补集"用例不受影响（证明反测精确命中）。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-09
 */
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from '../../providers/provider-factory';
import { ProviderRouterService } from './provider-router.service';
import type { ResolvedAiConfig } from '../../tenant/ai-config.service';

function makeRouter(registered: Record<string, unknown> = {}) {
  const factory = {
    isRegistered: jest.fn((name: string) => name in registered),
    create: jest.fn(
      (name: string, _config?: unknown) =>
        registered[name] ?? {
          name,
          configured: Boolean(_config),
        },
    ),
  };
  const config = {
    get: jest.fn((key: string) =>
      key === 'SYSTEM_SCOPE' ? 'mgmt' : undefined,
    ),
  };
  const aiConfig = {
    isFallbackEnabled: jest.fn().mockResolvedValue(true),
  };
  const router = new ProviderRouterService(
    factory as unknown as ProviderFactory,
    config as unknown as ConfigService,
    aiConfig as never,
  );
  return { router, factory };
}

function makeResolved(
  overrides: Partial<ResolvedAiConfig> = {},
): ResolvedAiConfig {
  return {
    provider: 'glm',
    providerConfig: {
      apiKey: ['sk', 'tenant', 'glm'].join('-'),
      baseUrl: 'https://tenant-glm.example/v1',
      model: 'glm-4',
    },
    model: 'glm-4',
    temperature: 0.3,
    maxTokens: 2048,
    systemPrompt: null,
    source: 'tenant',
    ...overrides,
  };
}

describe('R101-AI-01 route() 路径1 正向语义：指定==配置 Provider 时必须用本租户凭据', () => {
  it('正向：requestedModel === resolved.provider ⇒ create 收到 (provider, 本租户 providerConfig)', () => {
    const { router, factory } = makeRouter({ glm: {} });
    const resolved = makeResolved();

    const result = router.route({
      requestedModel: 'glm',
      resolved,
      systemScope: 'mgmt',
    });

    expect(result.providerName).toBe('glm');
    // 正向语义（P0-3）：带本租户配置创建实例，用户显式选回配置 Provider 时
    // 用的是租户自己的凭据，而不是 env 默认
    expect(factory.create).toHaveBeenCalledWith('glm', resolved.providerConfig);
    expect(factory.create).toHaveBeenCalledTimes(1);
  });

  it('负向补集：requestedModel !== resolved.provider ⇒ 仍用 env 默认（不带租户配置）', () => {
    const { router, factory } = makeRouter({ glm: {}, custom_kimi: {} });

    const result = router.route({
      requestedModel: 'custom_kimi',
      resolved: makeResolved(),
      systemScope: 'mgmt',
    });

    expect(result.providerName).toBe('custom_kimi');
    expect(factory.create).toHaveBeenCalledWith('custom_kimi');
    expect(factory.create).not.toHaveBeenCalledWith(
      'custom_kimi',
      expect.anything(),
    );
  });
});
