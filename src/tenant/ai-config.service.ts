/**
 * AiConfigService — 租户 AI 配置服务
 *
 * 职责：
 * 1. 读取当前租户的 AI 配置（t_tenant_ai_config），未配置或未启用则降级到平台默认配置（t_platform_ai_config）
 * 2. 解密 API Key（AES-256-GCM），返回明文供 Provider 使用
 * 3. 返回 ProviderConfig 格式，直接传给 ProviderFactory.create()
 * 4. 返回系统提示词（租户自定义 > 平台默认）
 *
 * 配置优先级：
 *   租户已启用（enabled=1）的配置 > 平台默认配置
 *   租户配置中某个字段为 null → 降级使用平台默认的同名字段
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.1 配置表设计
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { ProviderConfig } from '../providers/provider.interface';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';

/**
 * 解析后的租户 AI 配置（包含 Provider 所需的全部信息）
 */
export interface ResolvedAiConfig {
  /** 服务商名称（deepseek / ollama / ...） */
  provider: string;
  /** Provider 运行时配置（直接传给 ProviderFactory.create()） */
  providerConfig: ProviderConfig;
  /** 模型名称 */
  model: string;
  /** 温度参数 */
  temperature: number;
  /** 最大 Token 数 */
  maxTokens: number;
  /** 系统提示词（租户自定义 > 平台默认） */
  systemPrompt: string | null;
  /** 配置来源：tenant=租户配置 / platform=平台默认 */
  source: 'tenant' | 'platform';
}

@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);

  constructor(
    @InjectRepository(TenantAiConfigEntity)
    private readonly tenantRepo: Repository<TenantAiConfigEntity>,
    @InjectRepository(PlatformAiConfigEntity)
    private readonly platformRepo: Repository<PlatformAiConfigEntity>,
    private readonly tenantContext: TenantContext,
    private readonly crypto: CryptoService,
    // 显式 @Inject：避免 Nest 反射解析歧义（同模块 provider，本地容器复现 undefined dependency）
    @Inject(ExternalModelService)
    private readonly externalModelService: ExternalModelService,
  ) {}

  /**
   * 获取当前租户的解析后 AI 配置
   *
   * 调用此方法前必须已在租户上下文中（TenantGuard 已拦截）。
   *
   * @returns 解析后的配置
   * @throws Error 不在租户上下文中 / 平台默认配置不存在
   */
  async getResolvedConfig(): Promise<ResolvedAiConfig> {
    const ctx = this.tenantContext.require();
    const tenantId = ctx.tenantId;

    // 1. 尝试读取租户配置
    const tenantConfig = await this.tenantRepo.findOne({
      where: { tenantId },
    });

    // 2. 租户配置存在且已启用 → 使用租户配置（null 字段降级到平台默认）
    if (tenantConfig && tenantConfig.enabled === 1) {
      this.logger.debug(
        `租户 ${tenantId} 使用自定义 AI 配置（provider=${tenantConfig.provider}, model=${tenantConfig.model}）`,
      );
      return this.resolveFromTenant(tenantConfig);
    }

    // 3. 租户未配置或未启用 → 降级到平台默认
    this.logger.debug(
      `租户 ${tenantId} 无自定义配置或已禁用，降级到平台默认配置`,
    );
    return this.resolveFromPlatform(tenantId);
  }

  /**
   * 便捷方法：直接获取 ProviderConfig（供 ProviderFactory.create() 使用）
   */
  async getProviderConfig(): Promise<{
    provider: string;
    config: ProviderConfig;
  }> {
    const resolved = await this.getResolvedConfig();

    // 外部大模型：平台/租户配置选择外部模型时，用外部模型库补全 baseUrl/apiKey
    //（外部模型的密钥只存在 t_ai_external_model，配置项中 apiKey/endpoint 可为空）
    const external = await this.externalModelService.getRuntimeConfig(
      resolved.provider,
    );
    if (external) {
      return {
        provider: resolved.provider,
        config: {
          apiKey: resolved.providerConfig.apiKey || external.apiKey,
          baseUrl: resolved.providerConfig.baseUrl || external.baseUrl,
          // 外部模型的模型名以外部模型库配置为准（管理入口统一维护）
          model: external.model,
          temperature: resolved.temperature,
          max_tokens: resolved.maxTokens,
        },
      };
    }

    return {
      provider: resolved.provider,
      config: resolved.providerConfig,
    };
  }

  /**
   * 便捷方法：获取系统提示词
   */
  async getSystemPrompt(): Promise<string | null> {
    const resolved = await this.getResolvedConfig();
    return resolved.systemPrompt;
  }

  /**
   * 从租户配置解析（null 字段降级到平台默认）
   */
  private async resolveFromTenant(
    tenantConfig: TenantAiConfigEntity,
  ): Promise<ResolvedAiConfig> {
    // 读取平台默认配置（用于降级）
    const platformConfig = await this.getPlatformConfig();

    // 解密 API Key（租户未配置则用平台默认）
    const apiKey =
      this.crypto.decryptSafe(tenantConfig.apiKey) ??
      this.crypto.decryptSafe(platformConfig.defaultApiKey) ??
      '';

    if (!apiKey) {
      this.logger.warn(
        `租户 ${tenantConfig.tenantId} 和平台默认配置均无可用 API Key`,
      );
    }

    return {
      provider: tenantConfig.provider,
      providerConfig: {
        apiKey,
        baseUrl: tenantConfig.apiEndpoint ?? undefined,
        model: tenantConfig.model,
        temperature: Number(tenantConfig.temperature),
        max_tokens: tenantConfig.maxTokens,
      },
      model: tenantConfig.model,
      temperature: Number(tenantConfig.temperature),
      maxTokens: tenantConfig.maxTokens,
      systemPrompt:
        tenantConfig.systemPrompt ?? platformConfig.defaultSystemPrompt,
      source: 'tenant',
    };
  }

  /**
   * 从平台默认配置解析
   */
  private async resolveFromPlatform(
    tenantId: string,
  ): Promise<ResolvedAiConfig> {
    const platformConfig = await this.getPlatformConfig();

    // 解密 API Key
    const apiKey = this.crypto.decryptSafe(platformConfig.defaultApiKey) ?? '';

    if (!apiKey) {
      this.logger.warn(
        `租户 ${tenantId} 降级到平台默认配置，但平台未配置 API Key`,
      );
    }

    return {
      provider: platformConfig.defaultProvider,
      providerConfig: {
        apiKey,
        baseUrl: platformConfig.defaultEndpoint ?? undefined,
        model: platformConfig.defaultModel,
        temperature: Number(platformConfig.defaultTemperature),
        max_tokens: platformConfig.defaultMaxTokens,
      },
      model: platformConfig.defaultModel,
      temperature: Number(platformConfig.defaultTemperature),
      maxTokens: platformConfig.defaultMaxTokens,
      systemPrompt: platformConfig.defaultSystemPrompt,
      source: 'platform',
    };
  }

  /**
   * 获取平台默认配置（缓存，单例记录）
   *
   * 平台配置只有 1 条记录（id=1），首次读取后缓存到实例变量。
   */
  private platformConfigCache: PlatformAiConfigEntity | null = null;
  private platformConfigLoaded = false;

  private async getPlatformConfig(): Promise<PlatformAiConfigEntity> {
    if (this.platformConfigLoaded && this.platformConfigCache) {
      return this.platformConfigCache;
    }

    const config = await this.platformRepo.findOne({ where: { id: 1 } });
    if (!config) {
      throw new Error(
        '平台默认 AI 配置不存在（t_platform_ai_config 表无 id=1 记录），请执行 migration 脚本初始化',
      );
    }

    this.platformConfigCache = config;
    this.platformConfigLoaded = true;
    return config;
  }

  /**
   * 清除平台配置缓存（工作台修改配置后调用）
   */
  clearCache(): void {
    this.platformConfigCache = null;
    this.platformConfigLoaded = false;
    this.logger.debug('平台 AI 配置缓存已清除');
  }

  /**
   * 本地 Ollama 兜底开关（P1-3）
   *
   * 读取优先级：平台配置表 ollama_fallback_enabled > env OLLAMA_FALLBACK_ENABLED > 默认开启。
   * 无租户上下文也可调用（不依赖 TenantContext）。
   */
  async isFallbackEnabled(): Promise<boolean> {
    try {
      const config = await this.getPlatformConfig();
      // 旧数据字段未初始化（undefined）时回退 env/默认
      if (config.ollamaFallbackEnabled !== undefined) {
        return config.ollamaFallbackEnabled === 1;
      }
    } catch {
      // 平台配置不存在等异常 → 回退 env
    }
    const envValue = process.env.OLLAMA_FALLBACK_ENABLED;
    if (envValue !== undefined && envValue !== '') {
      return envValue !== 'false' && envValue !== '0';
    }
    return true;
  }
}
