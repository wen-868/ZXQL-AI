/**
 * P0-3 反测用例：Provider 跨租户配置串用（单例配置粘滞）
 *
 * 目标行为（规格）：
 * - 租户 A 经 ProviderFactory.create(type, configA) 注入配置后，
 *   租户 B「不带 config」的取用不得复用 A 的 apiKey / baseUrl。
 *   覆盖两条被点名的取用路径：
 *   1) ProviderFactory.create(type)（provider-factory.ts create 分支）
 *   2) ProviderRouterService.route() 的 requestedModel 路径
 *      （provider-router.service.ts 中 create(requested) 不带 config）
 *   三类内置 Provider（deepseek / glm / ollama）逐一套用同一不变式。
 *
 * 观测方式：mock axios，直接读真实出站请求（URL + Authorization 头），
 * 不对 Provider 私有字段做断言；未发出请求即失败（显式拒绝）视为合规口径
 * ——「宁失败不串用」。
 *
 * 反测方向：「修复不存在」时本文件必须红——B 的请求会发往 A 的 baseUrl
 * 并携带 A 的密钥（基线用例证明本观测方式确能捕获 A 的配置）。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-09
 */
import { ConfigService } from '@nestjs/config';
import { ProviderRouterService } from '../brain/router/provider-router.service';
import type {
  AiConfigService,
  ResolvedAiConfig,
} from '../tenant/ai-config.service';
import { DeepSeekProvider } from './deepseek.provider';
import { GlmProvider } from './glm.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderFactory } from './provider-factory';
import type { IModelProvider, ProviderConfig } from './provider.interface';

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
}));

/** axios.post 调用签名：URL + body + 请求配置 */
type MockedPost = jest.Mock<
  Promise<unknown>,
  [string, unknown, { headers: Record<string, string>; timeout: number }]
>;

/** mock axios.post（requireMock 避免 unbound-method，类型化避免 no-unsafe） */
const mockedPost = jest.requireMock<{ post: unknown }>('axios')
  .post as MockedPost;

/** Provider 出站请求的可观测结果 */
interface Outbound {
  /** 调用过程中抛出的错误（含「请求发出后解析失败」） */
  threw: Error | null;
  /** 已发出的请求 URL；未发出请求时为 undefined */
  url?: string;
  /** Authorization 头；ollama 无该头 */
  auth?: string;
}

/** axios.post 成功响应（非流式 chatSync 形状，够用即可） */
const SUCCESS_RESPONSE = {
  data: {
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'pong' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  },
};

/** 租户 A 配置 */
const TENANT_A_API_KEY = 'key-tenant-a-001';
const TENANT_A_BASE_URL = 'https://tenant-a.example.com/v1';
const TENANT_A_CONFIG: ProviderConfig = {
  apiKey: TENANT_A_API_KEY,
  baseUrl: TENANT_A_BASE_URL,
  model: 'model-a',
};

/** 租户 B 配置 */
const TENANT_B_API_KEY = 'key-tenant-b-001';
const TENANT_B_BASE_URL = 'https://tenant-b.example.com/v1';
const TENANT_B_CONFIG: ProviderConfig = {
  apiKey: TENANT_B_API_KEY,
  baseUrl: TENANT_B_BASE_URL,
  model: 'model-b',
};

/** 环境默认值（factory 无 config 时本应使用的安全基线） */
const ENV_DEFAULTS: Record<string, string> = {
  DEFAULT_MODEL_PROVIDER: 'deepseek',
  DEEPSEEK_API_KEY: 'env-deepseek-key',
  DEEPSEEK_BASE_URL: 'https://env.deepseek.example.com',
  DEEPSEEK_MODEL: 'deepseek-chat',
  DEEPSEEK_TIMEOUT_MS: '30000',
  GLM_API_KEY: 'env-glm-key',
  GLM_BASE_URL: 'https://env.glm.example.com/api/paas/v4',
  GLM_MODEL: 'glm-4-flash',
  GLM_TIMEOUT_MS: '90000',
  OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
  OLLAMA_MODEL: 'qwen2.5:7b',
  OLLAMA_TIMEOUT_MS: '30000',
  DEFAULT_TEMPERATURE: '0.3',
  DEFAULT_MAX_TOKENS: '2048',
};

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in ENV_DEFAULTS ? ENV_DEFAULTS[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

function makeFactory(config: ConfigService): ProviderFactory {
  return new ProviderFactory(
    new GlmProvider(config),
    new DeepSeekProvider(config),
    new OllamaProvider(config),
    config,
  );
}

/** 取用 Provider 并捕获「不带 config 时直接抛错」这一合规口径 */
function acquireWithoutConfig(
  factory: ProviderFactory,
  type: string,
): { provider: IModelProvider | null; threw: Error | null } {
  try {
    return { provider: factory.create(type), threw: null };
  } catch (err) {
    return {
      provider: null,
      threw: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/** 发起一次真实出站调用并读出 URL / Authorization */
async function captureChatSync(provider: IModelProvider): Promise<Outbound> {
  mockedPost.mockReset();
  mockedPost.mockResolvedValue(SUCCESS_RESPONSE);
  let threw: Error | null = null;
  try {
    await provider.chatSync([{ role: 'user', content: 'ping' }]);
  } catch (err) {
    threw = err instanceof Error ? err : new Error(String(err));
  }
  const call = mockedPost.mock.calls[0];
  if (!call) {
    return { threw: threw ?? new Error('未发出 HTTP 请求') };
  }
  const [url, , requestConfig] = call;
  return { threw, url, auth: requestConfig.headers.Authorization };
}

/** 核心不变式：不得把 A 的 baseUrl / apiKey 用在 B 的请求上 */
function expectNoCrossTenantReuse(
  outbound: Outbound,
  leakedBaseUrl: string,
  leakedApiKey: string,
): void {
  if (outbound.url === undefined) {
    // 未发出请求即失败：显式拒绝属于合规口径（宁失败不串用）
    expect(outbound.threw).toBeInstanceOf(Error);
    return;
  }
  expect(outbound.url).not.toContain(leakedBaseUrl);
  expect(outbound.auth).not.toBe(`Bearer ${leakedApiKey}`);
}

describe('P0-3 Provider 跨租户配置隔离', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('基线（证明观测方式能读到真实配置）', () => {
    it('租户 A 显式配置下，请求确实使用 A 的 baseUrl/apiKey', async () => {
      const factory = makeFactory(createConfigService());
      const provider = factory.create('deepseek', TENANT_A_CONFIG);

      const outbound = await captureChatSync(provider);

      expect(outbound.url).toContain(TENANT_A_BASE_URL);
      expect(outbound.auth).toBe(`Bearer ${TENANT_A_API_KEY}`);
    });

    it('租户 B 显式配置下，请求确实使用 B 的 baseUrl/apiKey（修复不得忽略配置）', async () => {
      const factory = makeFactory(createConfigService());
      const provider = factory.create('deepseek', TENANT_B_CONFIG);

      const outbound = await captureChatSync(provider);

      expect(outbound.url).toContain(TENANT_B_BASE_URL);
      expect(outbound.auth).toBe(`Bearer ${TENANT_B_API_KEY}`);
    });
  });

  describe('租户 A 配置后，B 不带 config 的 create() 不得复用 A 的配置', () => {
    const builtinCases: Array<{ type: string; leakedBaseUrl: string }> = [
      { type: 'deepseek', leakedBaseUrl: 'https://tenant-a.example.com/ds' },
      { type: 'glm', leakedBaseUrl: 'https://tenant-a.example.com/glm' },
      { type: 'ollama', leakedBaseUrl: 'https://tenant-a.example.com/ollama' },
    ];

    it.each(builtinCases)(
      '$type：不得复用 A 的 apiKey/baseUrl',
      async ({ type, leakedBaseUrl }) => {
        const factory = makeFactory(createConfigService());
        factory.create(type, { ...TENANT_A_CONFIG, baseUrl: leakedBaseUrl });

        const { provider, threw } = acquireWithoutConfig(factory, type);
        if (!provider) {
          expect(threw).toBeInstanceOf(Error);
          return;
        }

        const outbound = await captureChatSync(provider);
        expectNoCrossTenantReuse(outbound, leakedBaseUrl, TENANT_A_API_KEY);
      },
    );
  });

  describe('ProviderRouterService 不带 config 的取用路径', () => {
    it('requestedModel 路径：租户 B 不得复用 A 的 apiKey/baseUrl', async () => {
      const configService = createConfigService();
      const factory = makeFactory(configService);
      const aiConfig = {
        isFallbackEnabled: jest.fn().mockResolvedValue(true),
      } as unknown as AiConfigService;
      const router = new ProviderRouterService(
        factory,
        configService,
        aiConfig,
      );

      // 租户 A 先经路由/工厂注入自己的配置
      factory.create('deepseek', TENANT_A_CONFIG);

      const bResolved: ResolvedAiConfig = {
        provider: 'deepseek',
        providerConfig: TENANT_B_CONFIG,
        model: TENANT_B_CONFIG.model,
        temperature: 0.3,
        maxTokens: 2048,
        systemPrompt: null,
        source: 'tenant',
      };

      let provider: IModelProvider | null = null;
      let threw: Error | null = null;
      try {
        provider = router.route({
          requestedModel: 'deepseek',
          resolved: bResolved,
          systemScope: 'mgmt',
        }).provider;
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err));
      }

      if (!provider) {
        expect(threw).toBeInstanceOf(Error);
        return;
      }

      const outbound = await captureChatSync(provider);
      expectNoCrossTenantReuse(outbound, TENANT_A_BASE_URL, TENANT_A_API_KEY);
    });
  });
});
