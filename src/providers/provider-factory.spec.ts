/**
 * ProviderFactory 单元测试
 *
 * 覆盖：内置 Provider 创建、未知类型报错、外部模型动态注册/注销/创建
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ProviderFactory } from './provider-factory';
import { GlmProvider } from './glm.provider';
import { DeepSeekProvider } from './deepseek.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderError } from './provider-error';

jest.mock('axios');

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        DEFAULT_MODEL_PROVIDER: 'glm',
        GLM_API_KEY: ['sk', 'glm'].join('-'),
        GLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
        GLM_MODEL: 'glm-4-flash',
        DEEPSEEK_API_KEY: ['sk', 'deepseek'].join('-'),
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_MODEL: 'deepseek-chat',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
        OLLAMA_MODEL: 'qwen2.5:7b',
        DEFAULT_TEMPERATURE: '0.3',
        DEFAULT_MAX_TOKENS: '2048',
      };
      return map[key];
    }),
  } as unknown as ConfigService;
}

function makeFactory(): ProviderFactory {
  const config = createConfigService();
  return new ProviderFactory(
    new GlmProvider(config),
    new DeepSeekProvider(config),
    new OllamaProvider(config),
    config,
  );
}

describe('ProviderFactory', () => {
  it('内置 Provider 创建与默认类型', () => {
    const factory = makeFactory();
    expect(factory.create('glm').name).toBe('glm');
    expect(factory.create('deepseek').name).toBe('deepseek');
    expect(factory.create('ollama').name).toBe('ollama');
  });

  it('未知 Provider 类型抛 400', () => {
    const factory = makeFactory();
    expect(() => factory.create('not_exist')).toThrow(ProviderError);
  });

  it('registerExternal 后可通过 create 使用外部模型', () => {
    const factory = makeFactory();
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
    });

    expect(factory.isRegistered('custom_kimi')).toBe(true);
    const provider = factory.create('custom_kimi');
    expect(provider.name).toBe('custom_kimi');
    // 外部模型不应提供 embedding
    expect(() => provider.embedding('x')).toThrow();
  });

  it('同名注册视为更新', () => {
    const factory = makeFactory();
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-1',
      baseUrl: 'https://a.example/v1',
      model: 'm1',
    });
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-2',
      baseUrl: 'https://b.example/v1',
      model: 'm2',
    });
    const provider = factory.create('custom_kimi');
    expect(provider.name).toBe('custom_kimi');
  });

  it('unregisterExternal 后不再可用', () => {
    const factory = makeFactory();
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
    });
    factory.unregisterExternal('custom_kimi');
    expect(factory.isRegistered('custom_kimi')).toBe(false);
    expect(() => factory.create('custom_kimi')).toThrow(ProviderError);
  });

  it('list 包含外部模型', () => {
    const factory = makeFactory();
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
    });
    expect(factory.list()).toEqual(
      expect.arrayContaining(['glm', 'deepseek', 'ollama', 'custom_kimi']),
    );
  });
});

/**
 * P0-3 跨租户配置串用回归
 *
 * 修复前：create() 返回共享单例，A 租户 configure 后，B 租户不传 config 的取用
 * 会把 A 的 apiKey/baseUrl 一起带走。
 * 修复后：每次 create() 都是独立实例，未传 config 时使用 env 默认配置。
 */
describe('ProviderFactory 配置隔离（P0-3）', () => {
  const mockPost = jest.fn();
  (axios.post as jest.Mock) = mockPost;

  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValue({
      data: {
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'pong' },
            finish_reason: 'stop',
          },
        ],
      },
    });
  });

  /** GLM / DeepSeek 请求头（provider.buildHeaders） */
  function providerHeaders(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** OpenAICompatProvider 请求头（provider.buildHeaders） */
  function compatHeaders(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  it('A 租户配置后，B 租户不传 config 取用不带 A 的 apiKey/baseUrl', async () => {
    const factory = makeFactory();

    // 租户 A：自定义 endpoint + 自定义钥匙
    factory.create('glm', {
      apiKey: 'sk-tenant-a',
      baseUrl: 'https://tenant-a.example.com/v1',
      model: 'glm-4-plus',
    });

    // 租户 B：不传 config（对话级用户指定模型 / 降级候选路径）
    const providerB = factory.create('glm');
    await providerB.chatSync([{ role: 'user', content: 'ping' }]);

    // B 的请求必须打到 env 默认端点 + env 默认 key，而不是 A 的
    expect(mockPost).toHaveBeenCalledWith(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      expect.objectContaining({ model: 'glm-4-flash' }),
      expect.objectContaining({
        headers: providerHeaders(['sk', 'glm'].join('-')),
      }),
    );
  });

  it('B 取用不会就地改写 A 已取用的实例配置', async () => {
    const factory = makeFactory();
    const providerA = factory.create('glm', {
      apiKey: 'sk-tenant-a',
      baseUrl: 'https://tenant-a.example.com/v1',
      model: 'glm-4-plus',
    });

    // 期间 B 租户取用同类型 Provider（含带 config 与不带 config 两种）
    factory.create('glm', {
      apiKey: 'sk-tenant-b',
      baseUrl: 'https://tenant-b.example.com/v1',
      model: 'glm-4-air',
    });
    factory.create('glm');

    await providerA.chatSync([{ role: 'user', content: 'ping' }]);

    // A 的实例仍使用 A 自己的配置
    expect(mockPost).toHaveBeenCalledWith(
      'https://tenant-a.example.com/v1/chat/completions',
      expect.objectContaining({ model: 'glm-4-plus' }),
      expect.objectContaining({
        headers: providerHeaders('sk-tenant-a'),
      }),
    );
  });

  it('同一 Provider 的两次取用是相互独立的实例', () => {
    const factory = makeFactory();
    for (const type of ['glm', 'deepseek', 'ollama']) {
      expect(factory.create(type)).not.toBe(factory.create(type));
    }
  });

  it('外部模型：未传 config 用注册配置；传入部分 config 不清空注册的 baseUrl/apiKey', async () => {
    const factory = makeFactory();
    factory.registerExternal('custom_kimi', {
      apiKey: 'sk-kimi',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k',
    });

    // 未传 config
    const p1 = factory.create('custom_kimi');
    await p1.chatSync([{ role: 'user', content: 'ping' }]);
    expect(mockPost).toHaveBeenLastCalledWith(
      'https://api.moonshot.cn/v1/chat/completions',
      expect.objectContaining({ model: 'moonshot-v1-8k' }),
      expect.objectContaining({ headers: compatHeaders('sk-kimi') }),
    );

    // 传部分 config（空 apiKey、缺 baseUrl）→ 保留注册基线
    const p2 = factory.create('custom_kimi', {
      apiKey: '',
      model: 'moonshot-v1-8k',
    });
    await p2.chatSync([{ role: 'user', content: 'ping' }]);
    expect(mockPost).toHaveBeenLastCalledWith(
      'https://api.moonshot.cn/v1/chat/completions',
      expect.objectContaining({ model: 'moonshot-v1-8k' }),
      expect.objectContaining({ headers: compatHeaders('sk-kimi') }),
    );
  });
});
