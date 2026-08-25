/**
 * ProviderRouterService 单元测试（C9 自适应路由 P0-6 + 降级链 P1-3）
 *
 * 覆盖：用户指定模型优先、租户配置、回退内置默认、scope 读取、
 * 降级链（首 chunk 失败自动切换、全部失败抛错、OLLAMA_FALLBACK_ENABLED 开关）
 */
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from '../../providers/provider-factory';
import { ProviderRouterService } from './provider-router.service';
import type { ResolvedAiConfig } from '../../tenant/ai-config.service';
import type {
  ChatMessage,
  ChatResult,
  IModelProvider,
} from '../../providers/provider.interface';

function makeRouter(
  registered: Record<string, unknown> = {},
  scope = 'mgmt',
  fallbackEnabled = true,
) {
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
    get: jest.fn((key: string) => (key === 'SYSTEM_SCOPE' ? scope : undefined)),
  };
  const aiConfig = {
    isFallbackEnabled: jest.fn().mockResolvedValue(fallbackEnabled),
  };
  const router = new ProviderRouterService(
    factory as unknown as ProviderFactory,
    config as unknown as ConfigService,
    aiConfig as never,
  );
  return { router, factory, aiConfig };
}

/** 构造带 chat/chatSync 的 Provider mock */
function makeProvider(name: string, failFirst = false): IModelProvider {
  const chatGenerator = function* (
    _messages: ChatMessage[],
  ): Generator<string, ChatResult, unknown> {
    if (failFirst) {
      throw new Error(`${name} 连接失败`);
    }
    yield '你';
    yield '好';
    return {
      content: '你好',
      prompt_tokens: 10,
      completion_tokens: 5,
      finish_reason: 'stop',
    };
  };
  return {
    name,
    chat: jest.fn(chatGenerator),
    chatSync: jest.fn().mockImplementation(() => {
      if (failFirst) {
        throw new Error(`${name} 连接失败`);
      }
      return {
        content: '你好',
        prompt_tokens: 10,
        completion_tokens: 5,
        finish_reason: 'stop',
      } as ChatResult;
    }),
    embedding: jest.fn(),
    testConnection: jest.fn(),
    configure: jest.fn(),
  } as unknown as IModelProvider;
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

  // ── P1-3 降级链 ──

  it('resolveChain：主 Provider 后追加降级候选（ollama 优先）', () => {
    const { router } = makeRouter({
      glm: makeProvider('glm'),
      ollama: makeProvider('ollama'),
      deepseek: makeProvider('deepseek'),
    });
    const chain = router.resolveChain({
      requestedModel: undefined,
      resolved: makeResolved({ provider: 'glm' }),
      systemScope: 'mgmt',
    });
    expect(chain[0].providerName).toBe('glm');
    expect(chain.map((c) => c.providerName)).toContain('ollama');
    expect(chain.map((c) => c.providerName)).toContain('deepseek');
  });

  it('OLLAMA_FALLBACK_ENABLED=false 时降级跳过 ollama（用 deepseek 兜底）', async () => {
    const { router } = makeRouter(
      {
        glm: makeProvider('glm', true),
        ollama: makeProvider('ollama'),
        deepseek: makeProvider('deepseek'),
      },
      'mgmt',
      false,
    );
    const result = await router.chatSyncWithFallback(
      [{ role: 'user', content: 'hi' }],
      undefined,
      {
        requestedModel: undefined,
        resolved: makeResolved({ provider: 'glm' }),
        systemScope: 'mgmt',
      },
    );
    // glm 失败但 ollama 被开关禁用 → 落到 deepseek
    expect(result.fallback?.to).toBe('deepseek');
  });

  it('chatWithFallback：主 Provider 失败自动降级 ollama 并带 fallback 元数据', async () => {
    const { router } = makeRouter({
      glm: makeProvider('glm', true),
      ollama: makeProvider('ollama'),
      deepseek: makeProvider('deepseek'),
    });

    const generator = router.chatWithFallback(
      [{ role: 'user', content: '你好' }],
      undefined,
      {
        requestedModel: undefined,
        resolved: makeResolved({ provider: 'glm' }),
        systemScope: 'mgmt',
      },
    );
    const chunks: string[] = [];
    let item = await generator.next();
    while (!item.done) {
      chunks.push(item.value);
      item = await generator.next();
    }
    const result = item.value;

    expect(chunks.join('')).toBe('你好');
    expect(result.fallback).toMatchObject({
      used: true,
      from: 'glm',
      to: 'ollama',
    });
    expect((result.fallback as { attempts: string[] }).attempts).toEqual([
      'glm',
      'ollama',
    ]);
  });

  it('chatSyncWithFallback：全部候选失败抛错', async () => {
    const { router } = makeRouter({
      glm: makeProvider('glm', true),
      ollama: makeProvider('ollama', true),
    });
    await expect(
      router.chatSyncWithFallback(
        [{ role: 'user', content: 'hi' }],
        undefined,
        {
          requestedModel: undefined,
          resolved: makeResolved({ provider: 'glm' }),
          systemScope: 'mgmt',
        },
      ),
    ).rejects.toThrow('所有 AI 服务商均不可用');
  });

  it('chatSyncWithFallback：主 Provider 正常时不降级', async () => {
    const { router } = makeRouter({
      glm: makeProvider('glm'),
      ollama: makeProvider('ollama'),
    });
    const result = await router.chatSyncWithFallback(
      [{ role: 'user', content: 'hi' }],
      undefined,
      {
        requestedModel: undefined,
        resolved: makeResolved({ provider: 'glm' }),
        systemScope: 'mgmt',
      },
    );
    expect(result.content).toBe('你好');
    expect(result.fallback?.used).toBe(false);
  });
});
