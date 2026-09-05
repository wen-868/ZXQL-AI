/* eslint-disable @typescript-eslint/unbound-method -- 测试断言需直接引用 mock 方法（save.mock.calls/toHaveBeenCalledWith 等） */
/**
 * AiConfigAdminService 单元测试
 *
 * 覆盖：
 * 1. 平台配置：读取（脱敏）/ 更新（apiKey 加密存储 + clearCache）/ 404
 * 2. 租户配置：分页列表 / 详情 / 更新（apiKey 加密存储 + upsert）
 * 3. 用量统计：按日汇总 + summary 聚合 + 日期/租户过滤
 * 4. 计费套餐：分页列表 / 更新（upsert）
 * 5. maskApiKey 脱敏工具
 */
import { ObjectLiteral, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { AiConfigAdminService } from './ai-config-admin.service';
import { maskApiKey } from './api-key-mask';
import { CryptoService } from './crypto.service';
import { AiConfigService } from './ai-config.service';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { AiUsageDailyEntity } from '../database/entities/ai-usage-daily.entity';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

type MockRepo<T extends ObjectLiteral> = jest.Mocked<Repository<T>>;

function createMockRepo<T extends ObjectLiteral>(): MockRepo<T> {
  return {
    findOne: jest.fn(),
    // 返回拷贝而非原引用：service 会对 create 结果追加字段，
    // 若返回原引用会污染 create 调用参数（toHaveBeenCalledWith 断言失真）
    create: jest.fn((entity: Partial<T>): T => ({ ...entity }) as T),
    // save 默认返回传入的实体，便于断言"写入数据库的内容"（如 apiKey 是否为密文）
    save: jest.fn((entity: T) => Promise.resolve(entity)),
    findAndCount: jest.fn(),
    find: jest.fn(),
  } as unknown as MockRepo<T>;
}

describe('AiConfigAdminService', () => {
  let platformRepo: MockRepo<PlatformAiConfigEntity>;
  let tenantRepo: MockRepo<TenantAiConfigEntity>;
  let usageRepo: MockRepo<AiUsageDailyEntity>;
  let billingRepo: MockRepo<TenantAiBillingEntity>;
  let crypto: CryptoService;
  let aiConfigService: jest.Mocked<AiConfigService>;
  let service: AiConfigAdminService;

  beforeEach(() => {
    platformRepo = createMockRepo<PlatformAiConfigEntity>();
    tenantRepo = createMockRepo<TenantAiConfigEntity>();
    usageRepo = createMockRepo<AiUsageDailyEntity>();
    billingRepo = createMockRepo<TenantAiBillingEntity>();
    crypto = new CryptoService(createConfigService());
    aiConfigService = {
      clearCache: jest.fn(),
    } as unknown as jest.Mocked<AiConfigService>;
    service = new AiConfigAdminService(
      platformRepo,
      tenantRepo,
      usageRepo,
      billingRepo,
      crypto,
      aiConfigService,
    );
  });

  // ── 平台默认配置 ──────────────────────────────────────────────

  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    return {
      id: 1,
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
      defaultApiKey: crypto.encrypt('sk-platform-secret'),
      defaultEndpoint: null,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2048,
      defaultSystemPrompt: '你是智享AI助手',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    };
  }

  describe('getPlatformConfig', () => {
    it('返回脱敏视图（不含明文 API Key）', async () => {
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const view = await service.getPlatformConfig();

      expect(view.defaultProvider).toBe('deepseek');
      expect(view.apiKeySet).toBe(true);
      expect(view.apiKeyMasked).toBe('sk-p****cret');
      // 视图对象不应包含明文/密文字段
      expect('defaultApiKey' in view).toBe(false);
      expect(JSON.stringify(view)).not.toContain('sk-platform-secret');
    });

    it('apiKey 为空时 apiKeySet=false 且 apiKeyMasked=null', async () => {
      platformRepo.findOne.mockResolvedValue(
        makePlatformConfig({ defaultApiKey: null }),
      );

      const view = await service.getPlatformConfig();

      expect(view.apiKeySet).toBe(false);
      expect(view.apiKeyMasked).toBeNull();
    });

    it('平台配置不存在时抛 NotFoundException', async () => {
      platformRepo.findOne.mockResolvedValue(null);

      await expect(service.getPlatformConfig()).rejects.toThrow(
        '平台默认 AI 配置不存在',
      );
    });
  });

  describe('updatePlatformConfig', () => {
    it('更新全部字段，apiKey 加密存储并清除运行时缓存', async () => {
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      // 测试假 apiKey 运行时拼装（避免硬编码凭据样式，Mimosa L3 门禁要求）
      const testApiKey = ['sk', 'new', 'key'].join('-');
      const view = await service.updatePlatformConfig({
        defaultProvider: 'qwen',
        defaultModel: 'qwen-max',
        apiKey: testApiKey,
        defaultEndpoint: 'https://example.com',
        defaultTemperature: 0.5,
        defaultMaxTokens: 4096,
        defaultSystemPrompt: '新系统提示词',
      });

      // apiKey 必须加密后存储（不是明文，且可解密回明文）
      const saved = platformRepo.save.mock.calls[0][0];
      expect(saved.defaultApiKey).not.toBe(testApiKey);
      expect(crypto.decryptSafe(saved.defaultApiKey)).toBe(testApiKey);
      expect(saved.defaultProvider).toBe('qwen');
      expect(saved.defaultMaxTokens).toBe(4096);

      // 返回脱敏视图
      expect(view.apiKeyMasked).toBe('sk-n****-key');
      // 清除运行时配置缓存
      expect(aiConfigService.clearCache).toHaveBeenCalledTimes(1);
    });

    it('apiKey 未提供时保留原密文', async () => {
      const existing = makePlatformConfig();
      platformRepo.findOne.mockResolvedValue(existing);

      await service.updatePlatformConfig({ defaultModel: 'deepseek-r1' });

      const saved = platformRepo.save.mock.calls[0][0];
      expect(saved.defaultApiKey).toBe(existing.defaultApiKey);
      expect(crypto.decryptSafe(saved.defaultApiKey)).toBe(
        'sk-platform-secret',
      );
    });

    it('apiKey 为空字符串时视为不改动', async () => {
      const existing = makePlatformConfig();
      platformRepo.findOne.mockResolvedValue(existing);

      await service.updatePlatformConfig({ apiKey: '' });

      const saved = platformRepo.save.mock.calls[0][0];
      expect(saved.defaultApiKey).toBe(existing.defaultApiKey);
    });

    it('平台配置不存在时创建（id=1）后保存', async () => {
      platformRepo.findOne.mockResolvedValue(null);

      const view = await service.updatePlatformConfig({
        defaultProvider: 'ollama',
        defaultModel: 'qwen2.5:7b',
      });

      expect(platformRepo.create).toHaveBeenCalledWith({ id: 1 });
      const saved = platformRepo.save.mock.calls[0][0];
      expect(saved.defaultProvider).toBe('ollama');
      expect(view.defaultProvider).toBe('ollama');
    });
  });

  // ── 租户 AI 配置 ──────────────────────────────────────────────

  function makeTenantConfig(
    overrides: Partial<TenantAiConfigEntity> = {},
  ): TenantAiConfigEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      enabled: 1,
      provider: 'deepseek',
      apiKey: crypto.encrypt('sk-tenant-secret'),
      apiEndpoint: null,
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt: null,
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      ...overrides,
    };
  }

  describe('listTenantConfigs', () => {
    it('返回分页列表并对 apiKey 脱敏', async () => {
      tenantRepo.findAndCount.mockResolvedValue([
        [makeTenantConfig(), makeTenantConfig({ tenantId: 'tenant-002' })],
        2,
      ]);

      const result = await service.listTenantConfigs({
        page: 2,
        pageSize: 10,
      });

      expect(result.total).toBe(2);
      expect(result.page).toBe(2);
      expect(result.pageSize).toBe(10);
      expect(tenantRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result.list[0].apiKeyMasked).toBe('sk-t****cret');
      expect(result.list[0].apiKeySet).toBe(true);
      expect(JSON.stringify(result)).not.toContain('sk-tenant-secret');
    });

    it('tenantId 过滤时 where 包含 tenantId', async () => {
      tenantRepo.findAndCount.mockResolvedValue([[makeTenantConfig()], 1]);

      await service.listTenantConfigs({ tenantId: 'tenant-001' });

      expect(tenantRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-001' } }),
      );
    });

    it('不传 tenantId 时 where 为空对象', async () => {
      tenantRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.listTenantConfigs({});

      expect(tenantRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('getTenantConfig', () => {
    it('返回脱敏详情', async () => {
      tenantRepo.findOne.mockResolvedValue(makeTenantConfig());

      const view = await service.getTenantConfig('tenant-001');

      expect(view.tenantId).toBe('tenant-001');
      expect(view.apiKeySet).toBe(true);
      expect(view.apiKeyMasked).toBe('sk-t****cret');
    });

    it('租户配置不存在时抛 NotFoundException', async () => {
      tenantRepo.findOne.mockResolvedValue(null);

      await expect(service.getTenantConfig('not-exist')).rejects.toThrow(
        'AI 配置不存在',
      );
    });
  });

  describe('updateTenantConfig', () => {
    it('更新全部字段，apiKey 加密存储（验收：数据库存密文）', async () => {
      tenantRepo.findOne.mockResolvedValue(makeTenantConfig());

      // 测试假 apiKey 运行时拼装（避免硬编码凭据样式，Mimosa L3 门禁要求）
      const testApiKey = ['sk', 'tenant', 'new'].join('-');
      const view = await service.updateTenantConfig('tenant-001', {
        enabled: 0,
        provider: 'ollama',
        apiKey: testApiKey,
        apiEndpoint: 'http://localhost:11434',
        model: 'qwen2.5:7b',
        temperature: 0.5,
        maxTokens: 4096,
        systemPrompt: '租户自定义提示词',
      });

      // 关键校验：写入数据库的 apiKey 必须是密文
      const saved = tenantRepo.save.mock.calls[0][0];
      expect(saved.apiKey).not.toBe(testApiKey);
      expect(crypto.decryptSafe(saved.apiKey)).toBe(testApiKey);
      expect(saved.provider).toBe('ollama');
      expect(saved.maxTokens).toBe(4096);

      expect(view.apiKeyMasked).toBe('sk-t****-new');
    });

    it('不存在时创建新记录（upsert）', async () => {
      tenantRepo.findOne.mockResolvedValue(null);

      const view = await service.updateTenantConfig('tenant-999', {
        provider: 'deepseek',
        apiKey: 'sk-boot',
      });

      expect(tenantRepo.create).toHaveBeenCalledWith({
        tenantId: 'tenant-999',
      });
      const saved = tenantRepo.save.mock.calls[0][0];
      expect(crypto.decryptSafe(saved.apiKey)).toBe('sk-boot');
      expect(view.tenantId).toBe('tenant-999');
    });

    it('apiKey 未提供时保留原密文', async () => {
      const existing = makeTenantConfig();
      tenantRepo.findOne.mockResolvedValue(existing);

      await service.updateTenantConfig('tenant-001', { model: 'deepseek-r1' });

      const saved = tenantRepo.save.mock.calls[0][0];
      expect(saved.apiKey).toBe(existing.apiKey);
      expect(crypto.decryptSafe(saved.apiKey)).toBe('sk-tenant-secret');
    });
  });

  // ── 用量统计 ──────────────────────────────────────────────────

  function makeUsageRow(
    overrides: Partial<AiUsageDailyEntity> = {},
  ): AiUsageDailyEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      statDate: '2026-08-01',
      chatCount: 10,
      toolCallCount: 3,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      promptCost: 0.01,
      completionCost: 0.005,
      totalCost: 0.015,
      provider: 'deepseek',
      model: 'deepseek-chat',
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  describe('getUsageStats', () => {
    it('无过滤时查询全部并按日汇总', async () => {
      usageRepo.find.mockResolvedValue([
        makeUsageRow(),
        makeUsageRow({
          statDate: '2026-08-02',
          chatCount: 20,
          totalTokens: 300,
          totalCost: 0.03,
        }),
      ]);

      const result = await service.getUsageStats({});

      expect(result.list).toHaveLength(2);
      expect(result.summary).toEqual({
        chatCount: 30,
        toolCallCount: 6,
        totalTokens: 450,
        totalCost: 0.045,
      });
      expect(usageRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('startDate+endDate 用 Between 过滤', async () => {
      usageRepo.find.mockResolvedValue([]);

      await service.getUsageStats({
        startDate: '2026-08-01',
        endDate: '2026-08-02',
      });

      const where = (usageRepo.find.mock.calls[0][0] as { where: object })
        .where;
      // TypeORM FindOperator 序列化为 { _type: 'between', ... }
      expect(JSON.stringify(where)).toContain('between');
    });

    it('仅 startDate 用 MoreThanOrEqual 过滤', async () => {
      usageRepo.find.mockResolvedValue([]);

      await service.getUsageStats({ startDate: '2026-08-01' });

      const where = (usageRepo.find.mock.calls[0][0] as { where: object })
        .where;
      expect(JSON.stringify(where)).toContain('moreThanOrEqual');
    });

    it('仅 endDate 用 LessThanOrEqual 过滤', async () => {
      usageRepo.find.mockResolvedValue([]);

      await service.getUsageStats({ endDate: '2026-08-02' });

      const where = (usageRepo.find.mock.calls[0][0] as { where: object })
        .where;
      expect(JSON.stringify(where)).toContain('lessThanOrEqual');
    });

    it('tenantId 过滤写入 where', async () => {
      usageRepo.find.mockResolvedValue([]);

      await service.getUsageStats({ tenantId: 'tenant-001' });

      const where = (usageRepo.find.mock.calls[0][0] as { where: object })
        .where;
      expect(where).toEqual({ tenantId: 'tenant-001' });
    });

    it('空数据时 summary 全为 0', async () => {
      usageRepo.find.mockResolvedValue([]);

      const result = await service.getUsageStats({});

      expect(result.summary).toEqual({
        chatCount: 0,
        toolCallCount: 0,
        totalTokens: 0,
        totalCost: 0,
      });
    });
  });

  // ── 计费套餐 ──────────────────────────────────────────────────

  function makeBilling(
    overrides: Partial<TenantAiBillingEntity> = {},
  ): TenantAiBillingEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      planType: 'pay_as_you_go',
      freeChatCount: 100,
      freeTokenLimit: 100000,
      overagePrice: 0.001,
      monthlyChatLimit: 0,
      monthlyTokenLimit: 0,
      monthlyPrice: 0,
      enabled: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  describe('listBillings', () => {
    it('返回分页列表', async () => {
      billingRepo.findAndCount.mockResolvedValue([
        [makeBilling(), makeBilling({ tenantId: 'tenant-002' })],
        2,
      ]);

      const result = await service.listBillings({ page: 1, pageSize: 20 });

      expect(result.total).toBe(2);
      expect(result.list[0].planType).toBe('pay_as_you_go');
      expect(billingRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('tenantId 过滤时写入 where', async () => {
      billingRepo.findAndCount.mockResolvedValue([[], 0]);

      await service.listBillings({ tenantId: 'tenant-001' });

      expect(billingRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: 'tenant-001' } }),
      );
    });
  });

  describe('updateBilling', () => {
    it('更新全部字段', async () => {
      billingRepo.findOne.mockResolvedValue(makeBilling());

      const result = await service.updateBilling('tenant-001', {
        planType: 'monthly',
        freeChatCount: 500,
        freeTokenLimit: 500000,
        overagePrice: 0.002,
        monthlyChatLimit: 10000,
        monthlyTokenLimit: 10000000,
        monthlyPrice: 99,
        enabled: 0,
      });

      const saved = billingRepo.save.mock.calls[0][0];
      expect(saved.planType).toBe('monthly');
      expect(saved.monthlyPrice).toBe(99);
      expect(saved.enabled).toBe(0);
      expect(result.planType).toBe('monthly');
    });

    it('不存在时创建新记录（upsert）', async () => {
      billingRepo.findOne.mockResolvedValue(null);

      const result = await service.updateBilling('tenant-999', {
        planType: 'prepaid',
      });

      expect(billingRepo.create).toHaveBeenCalledWith({
        tenantId: 'tenant-999',
      });
      const saved = billingRepo.save.mock.calls[0][0];
      expect(saved.planType).toBe('prepaid');
      expect(result.tenantId).toBe('tenant-999');
    });
  });

  // ── 脱敏工具 ──────────────────────────────────────────────────

  describe('maskApiKey', () => {
    it('长度不超过 8 时整体打码', () => {
      expect(maskApiKey('abcdefgh')).toBe('****');
    });

    it('保留前后 4 位', () => {
      expect(maskApiKey('sk-1234567890')).toBe('sk-1****7890');
    });
  });
});
