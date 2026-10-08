/* eslint-disable @typescript-eslint/unbound-method -- 断言需直接引用 axios mock 方法（mock.calls） */
/**
 * R101-AI-08 反测：Provider 连接期守卫按「端点来源」挂载
 *
 * 规格：`ProviderConfig.strictEgress=true`（来自商家可写 api_endpoint）时，
 * deepseek / glm / ollama 的 axios 出站必须带 `lookup`（连接期同源校验）与
 * `beforeRedirect`（重定向校验）；缺省/false（平台·env 端点）**不得**挂载。
 *
 * 反测方向：把 `axiosEgressOptions()` 改成无条件返回空对象 ⇒ 三个 Provider 的
 * 「strict 时带 lookup」断言变红。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { GlmProvider } from './glm.provider';
import { DeepSeekProvider } from './deepseek.provider';
import { OllamaProvider } from './ollama.provider';

jest.mock('axios');

const mockPost = axios.post as jest.Mock;
const mockGet = axios.get as jest.Mock;

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        GLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
        GLM_MODEL: 'glm-4-flash',
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

/** axios 非流式响应桩（三个 Provider 的 chatSync 共用同一形状） */
function okResponse(): { data: unknown } {
  return {
    data: {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'pong' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  };
}

/** 取最近一次调用的 axios 请求配置（post 在第 3 参，get 在第 2 参） */
function lastOptions(mock: jest.Mock, index: number): Record<string, unknown> {
  const call = mock.mock.calls[mock.mock.calls.length - 1] as unknown[];
  return (call[index] ?? {}) as Record<string, unknown>;
}

describe('R101-AI-08 Provider 连接期守卫接线', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockPost.mockResolvedValue(okResponse());
    mockGet.mockResolvedValue({ data: { models: [] } });
  });

  describe('strictEgress=true（商家可写端点）⇒ 挂 lookup + beforeRedirect', () => {
    it('deepseek chatSync', async () => {
      const provider = new DeepSeekProvider(createConfigService());
      provider.configure({
        apiKey: 'sk-x',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com',
        strictEgress: true,
      });
      await provider.chatSync([{ role: 'user', content: 'ping' }]);

      const options = lastOptions(mockPost, 2);
      expect(typeof options.lookup).toBe('function');
      expect(typeof options.beforeRedirect).toBe('function');
    });

    it('glm chatSync', async () => {
      const provider = new GlmProvider(createConfigService());
      provider.configure({
        apiKey: 'sk-x',
        model: 'glm-4-flash',
        baseUrl: 'https://api.example.com',
        strictEgress: true,
      });
      await provider.chatSync([{ role: 'user', content: 'ping' }]);

      const options = lastOptions(mockPost, 2);
      expect(typeof options.lookup).toBe('function');
      expect(typeof options.beforeRedirect).toBe('function');
    });

    it('ollama chatSync 与 testConnection（GET）', async () => {
      const provider = new OllamaProvider(createConfigService());
      provider.configure({
        apiKey: '',
        model: 'qwen2.5:7b',
        baseUrl: 'https://api.example.com',
        strictEgress: true,
      });
      await provider.chatSync([{ role: 'user', content: 'ping' }]);
      expect(typeof lastOptions(mockPost, 2).lookup).toBe('function');

      await provider.testConnection();
      const getOptions = lastOptions(mockGet, 1);
      expect(typeof getOptions.lookup).toBe('function');
      expect(typeof getOptions.beforeRedirect).toBe('function');
    });
  });

  describe('strictEgress 缺省/false（平台·env 端点）⇒ 不得挂守卫', () => {
    it('deepseek：无 strictEgress 时不挂 lookup', async () => {
      const provider = new DeepSeekProvider(createConfigService());
      provider.configure({
        apiKey: 'sk-x',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com',
      });
      await provider.chatSync([{ role: 'user', content: 'ping' }]);

      const options = lastOptions(mockPost, 2);
      expect(options.lookup).toBeUndefined();
      expect(options.beforeRedirect).toBeUndefined();
    });

    it('glm：strictEgress=false 时不挂 lookup', async () => {
      const provider = new GlmProvider(createConfigService());
      provider.configure({
        apiKey: 'sk-x',
        model: 'glm-4-flash',
        baseUrl: 'https://api.example.com',
        strictEgress: false,
      });
      await provider.chatSync([{ role: 'user', content: 'ping' }]);

      expect(lastOptions(mockPost, 2).lookup).toBeUndefined();
    });

    it('ollama：strictEgress=false 时 testConnection 不挂 lookup', async () => {
      const provider = new OllamaProvider(createConfigService());
      provider.configure({
        apiKey: '',
        model: 'qwen2.5:7b',
        baseUrl: 'https://api.example.com',
        strictEgress: false,
      });
      await provider.testConnection();

      expect(lastOptions(mockGet, 1).lookup).toBeUndefined();
    });

    it('平台端点（默认 env 配置）连 http://127.0.0.1 也不被守卫拦截', async () => {
      const provider = new OllamaProvider(createConfigService());
      // 不 configure：使用 env 默认 http://127.0.0.1:11434/v1（平台/环境维护）
      await provider.testConnection();

      const call = mockGet.mock.calls[0] as unknown[];
      expect(String(call[0])).toContain('http://127.0.0.1:11434/v1');
      expect(lastOptions(mockGet, 1).lookup).toBeUndefined();
    });
  });
});
