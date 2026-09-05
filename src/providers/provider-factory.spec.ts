/**
 * ProviderFactory 单元测试
 *
 * 覆盖：内置 Provider 创建、未知类型报错、外部模型动态注册/注销/创建
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from './provider-factory';
import { GlmProvider } from './glm.provider';
import { DeepSeekProvider } from './deepseek.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderError } from './provider-error';

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
