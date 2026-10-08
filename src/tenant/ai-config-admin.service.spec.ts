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

type MockRepo<T extends ObjectLiteral> = jest.Mocked<Repository<T>>;

function createMockRepo<T extends ObjectLiteral>(): MockRepo<T> {
  return {
    findOne: jest.fn(),
    // 返回拷贝而非原引用：service 会对 create 结果追加字段，
    // 若返回原引用会污染 create 调用参数（toHaveBeenCalledWith 断言失真）
    create: jest.fn((entity: Partial<T>): T => ({ ...entity }) as T),
    // save 默认返回传入的实体，便于断言"写入数据库的内容"（如 apiKey 是否为密文）
    save: jest.fn((entity: T) => Promise.resolve(entity)),
    // 阶段 3-A：updateBilling 改为 partial UPDATE，默认命中 1 行
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    findAndCount: jest.fn(),
    find: jest.fn(),
  } as unknown as MockRepo<T>;
}

describe('AiConfigAdminService', () => {
  let platformRepo: MockRepo<PlatformAiConfigEntity>;
  let tenantRepo: MockRepo<TenantAiConfigEntity>;
  let usageRepo: MockRepo<AiUsageDailyEntity>;
  let billingRepo: MockRepo<TenantAiBillingEntity>;
  let priceRepo: MockRepo<AiModelPriceEntity>;
  let crypto: CryptoService;
  let aiConfigService: jest.Mocked<AiConfigService>;
  let service: AiConfigAdminService;

  beforeEach(() => {
    platformRepo = createMockRepo<PlatformAiConfigEntity>();
    tenantRepo = createMockRepo<TenantAiConfigEntity>();
    usageRepo = createMockRepo<AiUsageDailyEntity>();
    billingRepo = createMockRepo<TenantAiBillingEntity>();
    // R101-AI-09：单价仓库为新增依赖（既有用例不触达，仅补齐构造参数）
    priceRepo = createMockRepo<AiModelPriceEntity>();
    crypto = new CryptoService(createConfigService());
    aiConfigService = {
      clearCache: jest.fn(),
    } as unknown as jest.Mocked<AiConfigService>;
    service = new AiConfigAdminService(
      platformRepo,
      tenantRepo,
      usageRepo,
      billingRepo,
      priceRepo,
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
      // 两个后续迁移新增的开关字段（缺省值与实体 @Column 默认一致：
      // ollama_fallback_enabled=1 开启、evolution_auto_activate=0 人工放行）
      ollamaFallbackEnabled: 1,
      evolutionAutoActivate: 0,
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
      balance: 0,
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
    /**
     * 计费行的内存库（阶段 3-A 并发用例用）
     *
     * 忠实模拟两种写法的差异——这也正是丢失更新的成因：
     * - `update(criteria, patch)`：只写 patch 里的列（partial UPDATE）
     * - `save(entity)`：**整行回写**，实体上有什么列就写什么列
     * findOne 返回拷贝：service 拿到的是快照，与库内当前值可分离。
     */
    function makeBillingStore(row: TenantAiBillingEntity) {
      const db: TenantAiBillingEntity = { ...row };
      // 快照在"管理员打开页面"那一刻就固定了：此后库内被并发 deduct 改动，
      // findOne 仍返回旧快照（这正是丢失更新的成因——快照里的旧值会被写回）
      const snapshot: TenantAiBillingEntity = { ...row };
      /** 落库的 SET 集合（按调用顺序） */
      const patches: Array<Partial<TenantAiBillingEntity>> = [];
      billingRepo.findOne = jest.fn(() => ({ ...snapshot })) as never;
      billingRepo.update = jest.fn(
        (
          criteria: { id: number },
          patch: Partial<TenantAiBillingEntity>,
        ): { affected: number } => {
          patches.push(patch);
          if (db.id !== criteria.id) {
            return { affected: 0 };
          }
          Object.assign(db, patch);
          return { affected: 1 };
        },
      ) as never;
      billingRepo.save = jest.fn((entity: TenantAiBillingEntity) => {
        Object.assign(db, entity);
        return entity;
      }) as never;
      return { db, patches };
    }

    it('更新全部字段（只写本次传入的列，不得整行回写）', async () => {
      const { patches } = makeBillingStore(makeBilling());

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

      // 阶段 3-A：写入方式是 partial UPDATE，不再是 save(整行)
      expect(patches).toHaveLength(1);
      expect(patches[0]).toEqual({
        planType: 'monthly',
        freeChatCount: 500,
        freeTokenLimit: 500000,
        overagePrice: 0.002,
        monthlyChatLimit: 10000,
        monthlyTokenLimit: 10000000,
        monthlyPrice: 99,
        enabled: 0,
      });
      // balance 未被本次修改 ⇒ 一个都不许进 SET
      expect(patches[0]).not.toHaveProperty('balance');
      expect(billingRepo.save).not.toHaveBeenCalled();
      expect(result.planType).toBe('monthly');
      expect(result.monthlyPrice).toBe(99);
      expect(result.enabled).toBe(0);
    });

    it('不存在时创建新记录（upsert）', async () => {
      billingRepo.findOne.mockResolvedValue(null);

      const result = await service.updateBilling('tenant-999', {
        planType: 'prepaid',
      });

      // 新行没有并发扣减历史，可整行写入（保留原 create 语义）
      expect(billingRepo.create).toHaveBeenCalledWith({
        tenantId: 'tenant-999',
        planType: 'prepaid',
      });
      const saved = billingRepo.save.mock.calls[0][0];
      expect(saved.planType).toBe('prepaid');
      expect(result.tenantId).toBe('tenant-999');
    });

    it('未传任何字段时一条 UPDATE 都不发（空写同样会盖掉并发扣减）', async () => {
      makeBillingStore(makeBilling({ id: 1, balance: 100 }));

      await service.updateBilling('tenant-001', {});

      expect(billingRepo.update).not.toHaveBeenCalled();
      expect(billingRepo.save).not.toHaveBeenCalled();
    });

    // 阶段 3-A（2026-10-09）新增：A 类丢失更新的并发用例。
    // 反测方向：把 updateBilling 改回「findOne → 内存改 → save(整行)」，
    // 本用例必须变红（db.balance 会被快照值 100 盖回）。
    it('并发 deduct 已扣减的 balance 不得被 updateBilling 整行回写覆盖（漏计费）', async () => {
      const { db, patches } = makeBillingStore(
        makeBilling({ id: 1, balance: 100, freeChatCount: 50 }),
      );

      // 时序：
      // t0 管理员打开套餐页 → service 读到快照（balance=100 / freeChatCount=50）
      // t1 期间有对话在跑：BillingService.deduct 用 raw SQL 原子扣减
      //    （billing.service.ts:137/157，绕过 ORM，不更新任何内存快照）
      db.balance = 90;
      db.freeChatCount = 49;
      // t2 管理员只提交「月费」一项改动
      await service.updateBilling('tenant-001', { monthlyPrice: 199 });

      // 反测信号：修复前 save(整行) 会把快照里的 balance=100 / freeChatCount=50
      // 一并盖回 ⇒ 这 10 元扣减凭空消失（用户白嫖，账目不平）
      expect(db.balance).toBe(90);
      expect(db.freeChatCount).toBe(49);
      expect(db.monthlyPrice).toBe(199);
      // SET 里只应有本次传入的那一列
      expect(Object.keys(patches[0])).toEqual(['monthlyPrice']);
      expect(patches[0]).not.toHaveProperty('balance');
      expect(patches[0]).not.toHaveProperty('freeChatCount');
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
