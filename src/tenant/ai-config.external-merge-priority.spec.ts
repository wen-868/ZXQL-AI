/**
 * R101-AI-01 缺口2：getProviderConfig() 外部模型合并分支的**优先级契约**断言
 *
 * 背景：ai-config.service.ts getProviderConfig() 在外部模型库命中时做合并：
 *   apiKey:  resolved.providerConfig.apiKey  || external.apiKey
 *   baseUrl: resolved.providerConfig.baseUrl || external.baseUrl
 * 独立验收（P0修复-独立验收-2026-10-09.md §8）指出该分支"无专门断言，安全性仅靠
 * 上游结构性论证"。既有用例（ai-config.service.spec.ts:233）只覆盖**兜底方向**
 * （resolved 未配 key/endpoint ⇒ 用外部库），**优先级方向**（resolved 自带
 * key/endpoint ⇒ 不得被外部库覆盖）零断言。
 *
 * 为什么优先级方向是安全语义而非口味：
 *   若合并被反转/写死成 `external.apiKey`，租户/平台解析出的密钥会被平台外部
 *   模型库的密钥**静默覆盖**，或把外部库密钥发往 resolved 指向的端点 ——
 *   密钥与端点跨源混搭，与 P0-2（同源绑定）是同一类风险。
 *
 * 反测方向（「修复不存在」）：把 ai-config.service.ts L186-187 的
 *   `resolved.providerConfig.apiKey || external.apiKey` / `resolved.providerConfig.baseUrl || external.baseUrl`
 *   回退成无条件 `external.apiKey` / `external.baseUrl`（合并优先级语义消失）
 *   ⇒ 本文件"优先级方向"用例必红；"兜底方向"用例不受影响（证明反测精确命中）。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-09
 */
import { Repository, ObjectLiteral } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AiConfigService } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { ExternalModelService } from './external-model.service';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

function createMockRepo<T extends ObjectLiteral>(): jest.Mocked<Repository<T>> {
  return {
    findOne: jest.fn(),
    create: jest.fn((entity: T): T => entity),
    save: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>>;
}

/** 外部模型库的运行时配置（getRuntimeConfig 命中时返回） */
function makeExternal(overrides: Record<string, unknown> = {}) {
  return {
    // 测试假 apiKey 运行时拼装（避免硬编码凭据样式，Mimosa L3 门禁要求）
    apiKey: ['sk', 'external', 'lib'].join('-'),
    baseUrl: 'https://external.example/v1',
    model: 'moonshot-v1-8k',
    ...overrides,
  };
}

describe('R101-AI-01 getProviderConfig 外部模型合并分支的优先级契约', () => {
  let service: AiConfigService;
  let tenantRepo: jest.Mocked<Repository<TenantAiConfigEntity>>;
  let platformRepo: jest.Mocked<Repository<PlatformAiConfigEntity>>;
  let tenantContext: TenantContext;
  let crypto: CryptoService;
  let externalModelService: { getRuntimeConfig: jest.Mock };
  let modelPriceRepo: jest.Mocked<Repository<AiModelPriceEntity>>;

  beforeEach(() => {
    tenantRepo = createMockRepo<TenantAiConfigEntity>();
    platformRepo = createMockRepo<PlatformAiConfigEntity>();
    tenantContext = new TenantContext();
    crypto = new CryptoService(createConfigService());
    externalModelService = {
      getRuntimeConfig: jest.fn().mockResolvedValue(null),
    };
    modelPriceRepo = createMockRepo<AiModelPriceEntity>();
    service = new AiConfigService(
      tenantRepo,
      platformRepo,
      tenantContext,
      crypto,
      externalModelService as unknown as ExternalModelService,
      modelPriceRepo,
    );
  });

  /** 构造平台默认配置（与 ai-config.service.spec.ts 的 makePlatformConfig 同构） */
  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    return {
      id: 1,
      defaultProvider: 'custom_kimi',
      defaultModel: 'moonshot-v1-8k',
      defaultApiKey: crypto.encrypt(['sk', 'resolved', 'cfg'].join('-')),
      defaultEndpoint: 'https://resolved.example/v1',
      defaultTemperature: 0.3,
      defaultMaxTokens: 2048,
      defaultSystemPrompt: '你是智享AI助手',
      ollamaFallbackEnabled: 1,
      evolutionAutoActivate: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function run<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId: 'tenant-001' }, fn);
  }

  it('优先级方向：resolved 自带 apiKey/baseUrl ⇒ 用 resolved 的，不被外部库覆盖', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    platformRepo.findOne.mockResolvedValue(makePlatformConfig());
    externalModelService.getRuntimeConfig.mockResolvedValue(makeExternal());

    const result = await run(() => service.getProviderConfig());

    // 密钥与端点必须来自 resolved（租户/平台解析结果），绝不被外部模型库静默覆盖
    expect(result.config.apiKey).toBe(['sk', 'resolved', 'cfg'].join('-'));
    expect(result.config.baseUrl).toBe('https://resolved.example/v1');
    // 模型名以外部模型库为准（管理入口统一维护）
    expect(result.config.model).toBe('moonshot-v1-8k');
  });

  it('兜底方向：resolved 未配 apiKey/baseUrl ⇒ 用外部库补全（不落空）', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    platformRepo.findOne.mockResolvedValue(
      makePlatformConfig({ defaultApiKey: null, defaultEndpoint: null }),
    );
    const external = makeExternal();
    externalModelService.getRuntimeConfig.mockResolvedValue(external);

    const result = await run(() => service.getProviderConfig());

    expect(result.config.apiKey).toBe(external.apiKey);
    expect(result.config.baseUrl).toBe('https://external.example/v1');
    expect(result.config.model).toBe('moonshot-v1-8k');
  });

  it('外部模型未命中 ⇒ config 原样返回 resolved.providerConfig，不掺外部字段', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    platformRepo.findOne.mockResolvedValue(
      makePlatformConfig({
        defaultProvider: 'deepseek',
        defaultModel: 'deepseek-chat',
      }),
    );
    externalModelService.getRuntimeConfig.mockResolvedValue(null);

    const result = await run(() => service.getProviderConfig());

    expect(result.provider).toBe('deepseek');
    expect(result.config.apiKey).toBe(['sk', 'resolved', 'cfg'].join('-'));
    expect(result.config.baseUrl).toBe('https://resolved.example/v1');
    expect(result.config.model).toBe('deepseek-chat');
    expect(externalModelService.getRuntimeConfig).toHaveBeenCalledWith(
      'deepseek',
    );
  });

  it('外部模型命中 ⇒ temperature/max_tokens/strictEgress 仍透传自 resolved', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    platformRepo.findOne.mockResolvedValue(
      makePlatformConfig({ defaultTemperature: 0.7, defaultMaxTokens: 4096 }),
    );
    externalModelService.getRuntimeConfig.mockResolvedValue(makeExternal());

    const result = await run(() => service.getProviderConfig());

    expect(result.config.temperature).toBe(0.7);
    expect(result.config.max_tokens).toBe(4096);
    // 平台来源解析出的 strictEgress 为 false，必须原样透传，不得被外部分支改写
    expect(result.config.strictEgress).toBe(false);
  });
});
