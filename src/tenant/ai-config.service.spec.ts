/**
 * AiConfigService 单元测试
 *
 * 验证租户配置读取、降级平台配置、API Key 解密、缓存等核心能力。
 */
import { Repository, ObjectLiteral } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AiConfigService } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { ExternalModelService } from './external-model.service';

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

describe('AiConfigService', () => {
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
    );
  });

  /**
   * 构造平台默认配置
   */
  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    const encryptedKey = crypto.encrypt('sk-platform-default');
    return {
      id: 1,
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
      defaultApiKey: encryptedKey,
      defaultEndpoint: null,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2048,
      defaultSystemPrompt: '你是智享AI助手',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /**
   * 构造租户配置
   */
  function makeTenantConfig(
    overrides: Partial<TenantAiConfigEntity> = {},
  ): TenantAiConfigEntity {
    const encryptedKey = crypto.encrypt('sk-tenant-custom');
    return {
      id: 1,
      tenantId: 'tenant-001',
      enabled: 1,
      provider: 'ollama',
      apiKey: encryptedKey,
      apiEndpoint: 'http://localhost:11434',
      model: 'qwen2.5:7b',
      temperature: 0.5,
      maxTokens: 4096,
      systemPrompt: '你是租户自定义助手',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  describe('不在租户上下文中', () => {
    it('应抛异常', async () => {
      await expect(service.getResolvedConfig()).rejects.toThrow(
        '当前不在租户上下文中',
      );
    });
  });

  describe('租户有自定义配置（enabled=1）', () => {
    it('应使用租户配置', async () => {
      const tenantConfig = makeTenantConfig();
      const platformConfig = makePlatformConfig();
      tenantRepo.findOne.mockResolvedValue(tenantConfig);
      platformRepo.findOne.mockResolvedValue(platformConfig);

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(result.provider).toBe('ollama');
      expect(result.model).toBe('qwen2.5:7b');
      expect(result.temperature).toBe(0.5);
      expect(result.maxTokens).toBe(4096);
      expect(result.source).toBe('tenant');
      expect(result.providerConfig.apiKey).toBe('sk-tenant-custom');
      expect(result.providerConfig.baseUrl).toBe('http://localhost:11434');
      expect(result.systemPrompt).toBe('你是租户自定义助手');
    });

    it('租户 apiKey 为 null 时应降级到平台默认 apiKey', async () => {
      const tenantConfig = makeTenantConfig({ apiKey: null });
      const platformConfig = makePlatformConfig();
      tenantRepo.findOne.mockResolvedValue(tenantConfig);
      platformRepo.findOne.mockResolvedValue(platformConfig);

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(result.providerConfig.apiKey).toBe('sk-platform-default');
    });

    it('租户 systemPrompt 为 null 时应降级到平台默认', async () => {
      const tenantConfig = makeTenantConfig({ systemPrompt: null });
      const platformConfig = makePlatformConfig();
      tenantRepo.findOne.mockResolvedValue(tenantConfig);
      platformRepo.findOne.mockResolvedValue(platformConfig);

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(result.systemPrompt).toBe('你是智享AI助手');
    });
  });

  describe('租户配置存在但未启用（enabled=0）', () => {
    it('应降级到平台默认配置', async () => {
      const tenantConfig = makeTenantConfig({ enabled: 0 });
      const platformConfig = makePlatformConfig();
      tenantRepo.findOne.mockResolvedValue(tenantConfig);
      platformRepo.findOne.mockResolvedValue(platformConfig);

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-chat');
      expect(result.source).toBe('platform');
      expect(result.providerConfig.apiKey).toBe('sk-platform-default');
    });
  });

  describe('租户无配置（findOne 返回 null）', () => {
    it('应降级到平台默认配置', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const result = await tenantContext.run({ tenantId: 'tenant-002' }, () =>
        service.getResolvedConfig(),
      );

      expect(result.provider).toBe('deepseek');
      expect(result.source).toBe('platform');
    });
  });

  describe('平台默认配置不存在', () => {
    it('应抛异常', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(null);

      await expect(
        tenantContext.run({ tenantId: 'tenant-001' }, () =>
          service.getResolvedConfig(),
        ),
      ).rejects.toThrow('平台默认 AI 配置不存在');
    });
  });

  describe('便捷方法', () => {
    it('getProviderConfig 应返回 provider 和 config', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getProviderConfig(),
      );

      expect(result.provider).toBe('deepseek');
      expect(result.config.apiKey).toBe('sk-platform-default');
      expect(result.config.model).toBe('deepseek-chat');
    });

    it('getProviderConfig 选择外部模型时用外部库补全 baseUrl/apiKey', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue({
        ...makePlatformConfig({
          defaultProvider: 'custom_kimi',
          defaultApiKey: null,
          defaultEndpoint: null,
        }),
      });
      externalModelService.getRuntimeConfig.mockResolvedValue({
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKey: 'sk-kimi-real',
        model: 'moonshot-v1-8k',
      });

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getProviderConfig(),
      );

      expect(result.provider).toBe('custom_kimi');
      expect(result.config.baseUrl).toBe('https://api.moonshot.cn/v1');
      expect(result.config.apiKey).toBe('sk-kimi-real');
      expect(result.config.model).toBe('moonshot-v1-8k');
    });

    it('getSystemPrompt 应返回系统提示词', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const prompt = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getSystemPrompt(),
      );

      expect(prompt).toBe('你是智享AI助手');
    });
  });

  describe('缓存', () => {
    it('clearCache 后应重新读取平台配置', async () => {
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      // eslint-disable-next-line @typescript-eslint/unbound-method -- 测试断言需引用 mock 方法
      const findOneMock = platformRepo.findOne;

      // 第一次读取
      await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      // 平台配置应只查一次（缓存）
      expect(findOneMock).toHaveBeenCalledTimes(1);

      // 再次读取（命中缓存）
      await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(findOneMock).toHaveBeenCalledTimes(1);

      // 清除缓存
      service.clearCache();

      // 再次读取（重新查库）
      await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getResolvedConfig(),
      );

      expect(findOneMock).toHaveBeenCalledTimes(2);
    });
  });
});
