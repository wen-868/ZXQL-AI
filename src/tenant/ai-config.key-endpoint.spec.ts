/**
 * P0-2 反测用例：平台默认密钥不得与租户自填端点组合下发
 *
 * 目标行为（规格）：
 * - 租户配置 enabled=1 且未配置自有 apiKey（apiKey=null）
 *   + 租户自填 apiEndpoint → 解析结果必须「显式失败」或「端点被钉死」，
 *   **不得**把平台默认密钥 + 租户自填端点同时下发给 Provider。
 * - 走真实消费路径：AiConfigService.getResolvedConfig() 与
 *   getProviderConfig()（ProviderFactory.create() 的配置来源）。
 * - 回归守卫：租户自有密钥 + 自有端点的合法组合必须原样下发（修复不得过度拦截）。
 *
 * 反测方向：「修复不存在」时本文件必须红——解析结果为
 * { apiKey: '平台默认密钥', baseUrl: '租户自填端点' }，平台密钥被发往租户端点。
 *
 * 负责人: 苏然（测试+QA） | 创建日期: 2026-10-09
 */
import { ObjectLiteral, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AiConfigService, ResolvedAiConfig } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { ExternalModelService } from './external-model.service';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';

/** 测试用 32 字节 hex 加密密钥（运行时拼装，避免硬编码凭据样式） */
const TEST_ENCRYPTION_KEY = '3f2a'.repeat(16);

/** 平台默认密钥 / 端点 */
const PLATFORM_KEY = 'sk-platform-default';
const PLATFORM_ENDPOINT = 'https://api.deepseek.com';

/** 租户自填端点（攻击者可控） */
const TENANT_ENDPOINT = 'https://tenant-self-hosted.example.com/v1';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? TEST_ENCRYPTION_KEY : undefined,
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

describe('P0-2 AiConfigService 密钥与端点绑定', () => {
  let service: AiConfigService;
  let tenantRepo: jest.Mocked<Repository<TenantAiConfigEntity>>;
  let platformRepo: jest.Mocked<Repository<PlatformAiConfigEntity>>;
  let tenantContext: TenantContext;
  let crypto: CryptoService;
  let externalModelService: { getRuntimeConfig: jest.Mock };

  beforeEach(() => {
    tenantRepo = createMockRepo<TenantAiConfigEntity>();
    platformRepo = createMockRepo<PlatformAiConfigEntity>();
    tenantContext = new TenantContext();
    crypto = new CryptoService(createConfigService());
    externalModelService = {
      getRuntimeConfig: jest.fn().mockResolvedValue(null),
    };
    service = new AiConfigService(
      tenantRepo,
      platformRepo,
      tenantContext,
      crypto,
      externalModelService as unknown as ExternalModelService,
      // R101-AI-07：新增单价仓库依赖（本卡用例不触达，仅补齐构造参数，未改任何断言）
      createMockRepo<AiModelPriceEntity>(),
    );
  });

  /** 平台默认配置（密钥 + 端点均有值） */
  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    return {
      id: 1,
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
      defaultApiKey: crypto.encrypt(PLATFORM_KEY),
      defaultEndpoint: PLATFORM_ENDPOINT,
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

  /** 租户配置 */
  function makeTenantConfig(
    overrides: Partial<TenantAiConfigEntity> = {},
  ): TenantAiConfigEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      enabled: 1,
      provider: 'deepseek',
      apiKey: null,
      apiEndpoint: null,
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /** 核心安全不变式：平台默认密钥不得与租户自填端点同时下发 */
  function expectNoKeyEndpointCrossing(
    apiKey: string | undefined,
    baseUrl: string | undefined,
  ): void {
    const sendsPlatformKeyToTenantEndpoint =
      apiKey === PLATFORM_KEY && baseUrl === TENANT_ENDPOINT;
    expect(sendsPlatformKeyToTenantEndpoint).toBe(false);
  }

  /**
   * 非法组合：租户未配密钥（回落到平台默认密钥）+ 自填端点。
   *
   * 合规口径（满足其一即可）：
   * - 甲：端点被钉死（baseUrl 不再等于租户自填端点）
   * - 乙：显式失败（抛错）
   */
  describe('平台默认密钥 + 租户自填端点', () => {
    /** 单次解析，捕获「抛错」与「解析结果」两种结局 */
    async function resolveIllegalCombination(): Promise<{
      error: unknown;
      resolved: ResolvedAiConfig | null;
    }> {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiKey: null, apiEndpoint: TENANT_ENDPOINT }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());
      try {
        const resolved = await tenantContext.run(
          { tenantId: 'tenant-001' },
          () => service.getResolvedConfig(),
        );
        return { error: null, resolved };
      } catch (err) {
        return { error: err, resolved: null };
      }
    }

    it('getResolvedConfig：必须显式失败或端点钉死（不得静默拼接）', async () => {
      const { error, resolved } = await resolveIllegalCombination();

      if (error) {
        // 口径乙：显式失败（不得静默降级成非法组合）
        expect(error).toBeInstanceOf(Error);
        return;
      }

      // 口径甲：端点被钉死
      expectNoKeyEndpointCrossing(
        resolved!.providerConfig.apiKey,
        resolved!.providerConfig.baseUrl,
      );
    });

    it('getProviderConfig：下发 Provider 的配置不得出现非法组合', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiKey: null, apiEndpoint: TENANT_ENDPOINT }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      let result: {
        provider: string;
        config: { apiKey: string; baseUrl?: string };
      } | null = null;
      let error: unknown = null;
      try {
        result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
          service.getProviderConfig(),
        );
      } catch (err) {
        error = err;
      }

      if (error) {
        expect(error).toBeInstanceOf(Error);
        return;
      }
      expectNoKeyEndpointCrossing(
        result!.config.apiKey,
        result!.config.baseUrl,
      );
    });
  });

  describe('回归守卫：合法组合必须放行', () => {
    it('租户自有密钥 + 自有端点 → 原样下发', async () => {
      const tenantOwnKey = 'sk-tenant-own';
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({
          apiKey: crypto.encrypt(tenantOwnKey),
          apiEndpoint: TENANT_ENDPOINT,
        }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const resolved = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(resolved.providerConfig.apiKey).toBe(tenantOwnKey);
      expect(resolved.providerConfig.baseUrl).toBe(TENANT_ENDPOINT);
    });
  });
});
