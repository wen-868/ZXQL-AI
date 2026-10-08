/**
 * R101-AI-08 反测：出站守卫收敛到「商家可写」的 AI 配置端点链路
 *
 * 规格（卡内信任边界，凌舟 2026-10-09 裁定）：
 * - 商家可写的 `t_tenant_ai_config.api_endpoint` ⇒ **必须过守卫**
 *   （规则 a/b/c 同步拒绝；规则 d 由 strictEgress 在连接期用同一次解析校验）
 * - 平台 `t_platform_ai_config.default_endpoint` ⇒ **只记录 + 告警，不得拒绝**
 * - 不得改 P0-2「密钥↔端点同源」语义
 *
 * 反测方向：回退 `resolveFromTenant` 里的 `assertAllowedOutboundUrl(tenantEndpoint)`
 * ⇒ 本文件「商家端点被拒」3 条断言变红。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObjectLiteral, Repository } from 'typeorm';
import { AiConfigService } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
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

describe('R101-AI-08 商家可写端点接入出站守卫', () => {
  let service: AiConfigService;
  let tenantRepo: jest.Mocked<Repository<TenantAiConfigEntity>>;
  let platformRepo: jest.Mocked<Repository<PlatformAiConfigEntity>>;
  let tenantContext: TenantContext;
  let crypto: CryptoService;

  function makeRepo<T extends ObjectLiteral>(): jest.Mocked<Repository<T>> {
    return {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<T>>;
  }

  function makeTenantConfig(
    overrides: Partial<TenantAiConfigEntity> = {},
  ): TenantAiConfigEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      enabled: 1,
      provider: 'deepseek',
      apiKey: crypto.encrypt('sk-tenant-own'),
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

  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    return {
      id: 1,
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
      defaultApiKey: crypto.encrypt('sk-platform-default'),
      defaultEndpoint: null,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2048,
      defaultSystemPrompt: null,
      ollamaFallbackEnabled: 1,
      evolutionAutoActivate: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    crypto = new CryptoService(createConfigService());
    tenantRepo = makeRepo<TenantAiConfigEntity>();
    platformRepo = makeRepo<PlatformAiConfigEntity>();
    tenantContext = new TenantContext();
    service = new AiConfigService(
      tenantRepo,
      platformRepo,
      tenantContext,
      crypto,
      {
        getRuntimeConfig: jest.fn().mockResolvedValue(null),
      } as unknown as ExternalModelService,
      makeRepo<AiModelPriceEntity>(),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function resolve(): Promise<unknown> {
    return tenantContext.run({ tenantId: 'tenant-001' }, () =>
      service.getResolvedConfig(),
    );
  }

  describe('商家可写 apiEndpoint ⇒ 必须过守卫（显式失败）', () => {
    it('http: 内网地址 → 400，且不含 P0-2 的静默拼接', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: 'http://169.254.169.254/latest' }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      await expect(resolve()).rejects.toBeInstanceOf(BadRequestException);
      await expect(resolve()).rejects.toThrow('出站目标被拒');
    });

    it('https: 私网字面量 → 400', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: 'https://10.0.0.5/v1' }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      await expect(resolve()).rejects.toThrow('命中受限网段');
    });

    it('内嵌凭据 → 400', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: 'https://u:p@api.example.com/v1' }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      await expect(resolve()).rejects.toThrow('不得内嵌凭据');
    });

    it('正例：合法公网 HTTPS → 放行且标记 strictEgress（连接期继续同源校验）', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: 'https://api.example.com/v1/' }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const resolved = (await resolve()) as {
        providerConfig: {
          apiKey: string;
          baseUrl?: string;
          strictEgress?: boolean;
        };
      };
      expect(resolved.providerConfig.baseUrl).toBe(
        'https://api.example.com/v1',
      );
      expect(resolved.providerConfig.apiKey).toBe('sk-tenant-own');
      expect(resolved.providerConfig.strictEgress).toBe(true);
    });

    it('租户自带 key 但未填端点 → 不挂守卫（回落 env 端点，非商家可写）', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: null }),
      );
      platformRepo.findOne.mockResolvedValue(
        makePlatformConfig({ defaultEndpoint: 'https://api.example.com/v1' }),
      );

      const resolved = (await resolve()) as {
        providerConfig: { strictEgress?: boolean };
      };
      expect(resolved.providerConfig.strictEgress).toBe(false);
    });
  });

  describe('平台端点 ⇒ 只记录 + 告警，不得拒绝', () => {
    it('平台 defaultEndpoint 非 https → 不抛错，落 WARN，strictEgress=false', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      // 租户未配自有 key ⇒ P0-2 同源口径下端点取平台默认端点
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({
          apiKey: null,
          apiEndpoint: 'https://tenant.example/v1',
        }),
      );
      platformRepo.findOne.mockResolvedValue(
        makePlatformConfig({ defaultEndpoint: 'http://10.0.0.5:8080/v1' }),
      );

      const resolved = (await resolve()) as {
        providerConfig: { baseUrl?: string; strictEgress?: boolean };
      };

      expect(resolved.providerConfig.baseUrl).toBe('http://10.0.0.5:8080/v1');
      expect(resolved.providerConfig.strictEgress).toBe(false);
      const platformWarn = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('平台端点不合'));
      expect(platformWarn).toBeDefined();
      expect(platformWarn).toContain('host=10.0.0.5');
      expect(platformWarn).toContain('不拒绝');
    });

    it('平台配置路径（租户无配置）同样只告警不拒绝', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      tenantRepo.findOne.mockResolvedValue(null);
      platformRepo.findOne.mockResolvedValue(
        makePlatformConfig({ defaultEndpoint: 'https://[::1]:443/v1' }),
      );

      const resolved = (await resolve()) as {
        providerConfig: { baseUrl?: string; strictEgress?: boolean };
      };
      expect(resolved.providerConfig.baseUrl).toBe('https://[::1]:443/v1');
      expect(resolved.providerConfig.strictEgress).toBe(false);
      expect(
        warnSpy.mock.calls.some((c) => String(c[0]).includes('平台端点不合')),
      ).toBe(true);
    });
  });

  describe('getProviderConfig 透传守卫标记', () => {
    it('商家端点路径 → strictEgress 透传', async () => {
      tenantRepo.findOne.mockResolvedValue(
        makeTenantConfig({ apiEndpoint: 'https://api.example.com/v1' }),
      );
      platformRepo.findOne.mockResolvedValue(makePlatformConfig());

      const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
        service.getProviderConfig(),
      );
      expect(result.config.strictEgress).toBe(true);
    });
  });
});
