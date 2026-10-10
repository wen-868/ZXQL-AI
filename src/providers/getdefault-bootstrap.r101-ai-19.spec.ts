/**
 * R101-AI-19 反测：`getDefault()` bootstrap 缺口修复
 *
 * 缺陷：`ProviderFactory.getDefault()` 返回**环境基线实例**（env 默认配置 /
 * 外部模型注册配置），不经 `AiConfigService` 解析。两处调用点
 * （`admin.controller.ts` chat-test、`experience-extractor.service.ts` 萃取）
 * 因此只认 env ——「只配 DB 平台配置、env 为空」的部署拿不到可用凭据。
 *
 * 目标行为（规格）：
 * - 两处均改为「经 `AiConfigService.getProviderConfig()` 显式解析 →
 *   `factory.create(provider, config)`」，与全仓同源绑定口径一致。
 * - **不得直接读 env 兜底绕过解析**（P0-2：密钥与端点同源由解析层保证）。
 *
 * 反测场景（派单指定）：**DB 已配、env 空**
 * - env：ConfigService 对所有 key 只返回类型默认值 ⇒ `GLM_API_KEY` 为空串；
 * - DB：`t_platform_ai_config` 已配 `default_api_key`（AES 加密的 `sk-platform-db-key`）。
 *
 * 反测方向（双向）：
 * - 方向 A「修复不存在」：两处改回 `factory.getDefault()` ⇒ 凭据为空，
 *   `chatSync` 抛 `ProviderError`（401 未配置），断言 #1/#2/#5 变红；
 * - 方向 B「读 env 兜底绕过解析」：把解析结果丢弃、改走 `factory.create(type)`
 *   （无 config = env 基线）⇒ 同样拿不到 DB 凭据，断言 #1/#2 变红。
 *
 * 观测方式：mock axios，直接读真实出站请求的 `Authorization` 头与 URL，
 * 不对 Provider 私有字段做断言（与 provider-isolation.spec.ts 同口径）。
 *
 * 负责人: 阿坚（后端） | 创建日期: 2026-10-11
 */

import { ConfigService } from '@nestjs/config';
import { AdminController } from '../gateway/admin.controller';
import { ExperienceExtractorService } from '../evolution/experience-extractor.service';
import { EvolutionVersionService } from '../evolution/evolution-version.service';
import { AiConfigService } from '../tenant/ai-config.service';
import { CryptoService } from '../tenant/crypto.service';
import { TenantContext } from '../tenant/tenant-context';
import { ExternalModelService } from '../tenant/external-model.service';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { DeepSeekProvider } from './deepseek.provider';
import { GlmProvider } from './glm.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderFactory } from './provider-factory';
import { ProviderError } from './provider-error';

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

/** 非流式 chatSync 的成功响应形状（够用即可） */
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

/** DB 平台配置里的 API Key 明文（env 里**不存在**该值） */
const DB_API_KEY = 'sk-platform-db-key';
/** 平台配置的服务商（env 默认 DEFAULT_MODEL_PROVIDER 亦为 glm） */
const DB_PROVIDER = 'glm';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

/**
 * env 全空的 ConfigService：**所有 key 只回类型默认值**。
 * 这正是派单场景「env 为空」——`GLM_API_KEY` 取默认值 `''`。
 */
function createEmptyEnvConfigService(): ConfigService {
  return {
    get: jest.fn((_key: string, defaultValue?: unknown) => defaultValue),
  } as unknown as ConfigService;
}

/** 供 CryptoService 读 ENCRYPTION_KEY 的 ConfigService（与 env 空实例分开，避免污染场景） */
function createCryptoConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

/** DB 已配的平台默认配置（t_platform_ai_config，id=1） */
function makePlatformConfig(crypto: CryptoService): PlatformAiConfigEntity {
  return {
    id: 1,
    defaultProvider: DB_PROVIDER,
    defaultModel: 'glm-4-flash',
    defaultApiKey: crypto.encrypt(DB_API_KEY),
    defaultEndpoint: null,
    defaultTemperature: 0.3,
    defaultMaxTokens: 2048,
    defaultSystemPrompt: null,
    ollamaFallbackEnabled: 1,
    evolutionAutoActivate: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** 装配「DB 已配 + env 空」场景下的真实依赖（真实 AiConfigService / ProviderFactory） */
function setupScenario() {
  const envConfig = createEmptyEnvConfigService();
  const crypto = new CryptoService(createCryptoConfigService());
  const tenantContext = new TenantContext();
  const platformConfig = makePlatformConfig(crypto);
  const aiConfigService = new AiConfigService(
    { findOne: jest.fn().mockResolvedValue(null) } as never,
    { findOne: jest.fn().mockResolvedValue(platformConfig) } as never,
    tenantContext,
    crypto,
    {
      getRuntimeConfig: jest.fn().mockResolvedValue(null),
    } as unknown as ExternalModelService,
    {} as never,
  );
  const factory = new ProviderFactory(
    new GlmProvider(envConfig),
    new DeepSeekProvider(envConfig),
    new OllamaProvider(envConfig),
    envConfig,
  );
  return { envConfig, tenantContext, aiConfigService, factory };
}

/** 最近一次出站请求的 URL 与 Authorization 头；未发出请求则 threw 非空 */
interface Outbound {
  threw: Error | null;
  url?: string;
  auth?: string;
}

/** 执行一次 chatSync 并读出真实出站凭据 */
async function captureOutbound(run: () => Promise<unknown>): Promise<Outbound> {
  mockedPost.mockReset();
  mockedPost.mockResolvedValue(SUCCESS_RESPONSE);
  let threw: Error | null = null;
  try {
    await run();
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

/** 在租户上下文中执行（AiConfigService.getResolvedConfig 要求上下文存在） */
async function inTenantContext<T>(
  tenantContext: TenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  return tenantContext.run({ tenantId: 'tenant-db-only' }, fn);
}

describe('R101-AI-19 getDefault() bootstrap 缺口（DB 已配 / env 空）', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('基线：证明观测方式能读到「env 为空」', () => {
    it('env 空 ⇒ 基线实例（getDefault）确实拿不到凭据，chatSync 抛 401', async () => {
      const { tenantContext, factory } = setupScenario();

      const outbound = await inTenantContext(tenantContext, () =>
        captureOutbound(() =>
          factory.getDefault().chatSync([{ role: 'user', content: 'ping' }]),
        ),
      );

      // 反测锚点（方向 A）：修复前的行为就是「拿不到凭据」
      expect(outbound.threw).toBeInstanceOf(ProviderError);
      expect(outbound.threw?.message).toContain('GLM_API_KEY 未配置');
      expect(mockedPost).not.toHaveBeenCalled();
    });

    it('env 空 ⇒ 解析层本身能给出 DB 凭据（缺陷不在 AiConfigService）', async () => {
      const { tenantContext, aiConfigService } = setupScenario();

      const resolved = await inTenantContext(tenantContext, () =>
        aiConfigService.getProviderConfig(),
      );

      expect(resolved.provider).toBe(DB_PROVIDER);
      expect(resolved.config.apiKey).toBe(DB_API_KEY);
    });
  });

  describe('调用点 1：AdminController.chatTest', () => {
    /** 用 Object.create 最小构造（只挂被测方法用到的依赖），同既有 admin 系列 spec */
    function makeController(
      factory: ProviderFactory,
      aiConfigService: AiConfigService,
    ) {
      const controller = Object.create(
        AdminController.prototype,
      ) as AdminController;
      Object.defineProperty(controller, 'factory', { value: factory });
      Object.defineProperty(controller, 'aiConfigService', {
        value: aiConfigService,
      });
      Object.defineProperty(controller, 'logger', {
        value: { log: jest.fn(), warn: jest.fn() },
      });
      return controller;
    }

    it('chat-test 的 LLM 调用携带 DB 平台配置的凭据', async () => {
      const { tenantContext, aiConfigService, factory } = setupScenario();
      const controller = makeController(factory, aiConfigService);

      const outbound = await inTenantContext(tenantContext, () =>
        captureOutbound(() => controller.chatTest({ message: '你好' })),
      );

      // 反测锚点：方向 A（改回 getDefault）/ 方向 B（丢 config 走 env）均在此变红
      expect(outbound.threw).toBeNull();
      expect(outbound.auth).toBe(`Bearer ${DB_API_KEY}`);
      expect(outbound.url).toContain('open.bigmodel.cn');
    });

    it('chat-test 不得再走 getDefault()（不得读 env 基线兜底绕过解析）', async () => {
      const { tenantContext, aiConfigService, factory } = setupScenario();
      const getDefaultSpy = jest.spyOn(factory, 'getDefault');
      const createSpy = jest.spyOn(factory, 'create');
      const controller = makeController(factory, aiConfigService);

      await inTenantContext(tenantContext, () =>
        controller.chatTest({ message: '你好' }),
      );

      expect(getDefaultSpy).not.toHaveBeenCalled();
      // create 必须带解析出的 config（方向 B 反测锚点：create(type) 无 config 即变红）
      expect(createSpy).toHaveBeenCalledWith(
        DB_PROVIDER,
        expect.objectContaining({ apiKey: DB_API_KEY }),
      );
    });
  });

  describe('调用点 2：ExperienceExtractorService.summarize', () => {
    function makeExtractor(
      factory: ProviderFactory,
      aiConfigService: AiConfigService,
    ) {
      const corrections = [
        {
          id: 1,
          tenantId: 'tenant-db-only',
          taskType: 'customer_create',
          wrongPayload: { phone: '123' },
          rightPayload: { phone: '13800000000' },
          reason: '手机号格式错误',
          appliedToVersion: null,
        } as unknown as AiCorrectionEntity,
      ];
      const corrRepo = {
        find: jest.fn().mockResolvedValue(corrections),
        save: jest.fn((data: unknown) => Promise.resolve(data)),
      } as never;
      const versions = {
        stage: jest.fn().mockResolvedValue({ id: 1 }),
      } as unknown as EvolutionVersionService;
      return new ExperienceExtractorService(
        corrRepo,
        factory,
        aiConfigService,
        versions,
      );
    }

    it('萃取的 LLM 调用携带 DB 平台配置的凭据（不再降级）', async () => {
      const { tenantContext, aiConfigService, factory } = setupScenario();
      const getDefaultSpy = jest.spyOn(factory, 'getDefault');
      const extractor = makeExtractor(factory, aiConfigService);
      mockedPost.mockReset();
      mockedPost.mockResolvedValue({
        data: {
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  '{"pattern":"p","fix":"f","changeSummary":"手机号改为可选"}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

      const result = await inTenantContext(tenantContext, () =>
        extractor.extract('customer_create'),
      );

      // 反测锚点：修复前此处 degraded='GLM_API_KEY 未配置'（降级为保守提案）
      expect(result.degraded).toBeUndefined();
      const call = mockedPost.mock.calls[0];
      expect(call).toBeDefined();
      expect(call[2].headers.Authorization).toBe(`Bearer ${DB_API_KEY}`);
      expect(getDefaultSpy).not.toHaveBeenCalled();
    });

    it('萃取不得再走 getDefault()（不得读 env 基线兜底绕过解析）', async () => {
      const { tenantContext, aiConfigService, factory } = setupScenario();
      const getDefaultSpy = jest.spyOn(factory, 'getDefault');
      const createSpy = jest.spyOn(factory, 'create');
      const extractor = makeExtractor(factory, aiConfigService);
      mockedPost.mockReset();
      mockedPost.mockResolvedValue({
        data: {
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  '{"pattern":"p","fix":"f","changeSummary":"手机号改为可选"}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });

      await inTenantContext(tenantContext, () =>
        extractor.extract('customer_create'),
      );

      expect(getDefaultSpy).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(
        DB_PROVIDER,
        expect.objectContaining({ apiKey: DB_API_KEY }),
      );
    });
  });

  describe('口径副作用（显式记录，不静默）', () => {
    it('无租户上下文 ⇒ 显式失败（不回退 env 基线继续发请求）', async () => {
      const { aiConfigService, factory } = setupScenario();
      const controller = Object.create(
        AdminController.prototype,
      ) as AdminController;
      Object.defineProperty(controller, 'factory', { value: factory });
      Object.defineProperty(controller, 'aiConfigService', {
        value: aiConfigService,
      });
      Object.defineProperty(controller, 'logger', {
        value: { log: jest.fn(), warn: jest.fn() },
      });

      // 不进租户上下文：修复前 getDefault() 会继续用 env 基线发请求（env 非空时静默成功）
      await expect(controller.chatTest({ message: '你好' })).rejects.toThrow(
        '当前不在租户上下文中',
      );
    });
  });
});
