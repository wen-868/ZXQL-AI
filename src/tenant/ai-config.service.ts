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
import { LessThanOrEqual, Repository } from 'typeorm';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';
import { ProviderConfig } from '../providers/provider.interface';
import { assertAllowedOutboundUrl } from '../common/outbound-target.guard';
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

/**
 * 模型分档单价（元/千Token）——`t_ai_model_price` 的运行时视图（R101-AI-07）
 *
 * ⚠️ 本接口只表达「**已配置**」的一行单价。**未配置时调用方拿到的必须是
 * `null`，禁止回落成 0 冒充已配置**（0 只有作为「显式配置的 0 元」时才有意义，
 * 例如本地 ollama / 免费额度档）。
 */
export interface ModelPrice {
  /** AI 服务商（与 t_ai_usage_daily.provider 同口径） */
  provider: string;
  /** 模型名（精确匹配） */
  model: string;
  /** 输入单价（元/千Token） */
  promptPrice: number;
  /** 输出单价（元/千Token） */
  completionPrice: number;
  /** 币种（ISO 4217） */
  currency: string;
  /** 该单价的生效时间 */
  effectiveFrom: Date;
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
    // R101-AI-07：分档单价来源（t_ai_model_price，平台级配置，与租户上下文无关）
    @InjectRepository(AiModelPriceEntity)
    private readonly modelPriceRepo: Repository<AiModelPriceEntity>,
  ) {}

  /**
   * 读取 (provider, model) 当前生效的分档单价（R101-AI-07）
   *
   * 解析口径：`enabled=1` 且 `effective_from <= 当前时间` 的多行中取
   * `effective_from` 最大者（支持调价留痕，未来行不提前生效）。
   *
   * ⚠️ 未配置（无匹配行）→ 返回 `null`，**绝不**回落成 0：
   * 0 元与「未配置」是两种语义，用 0 冒充会让用量费用列静默失真。
   * 本方法不依赖租户上下文（单价是平台级配置）。
   *
   * @param provider AI 服务商（与 t_ai_usage_daily.provider 同口径）
   * @param model    模型名（精确匹配；不可用用量表的 model 代表值定价）
   * @returns 生效单价；未配置返回 null
   */
  async getModelPrice(
    provider: string,
    model: string,
  ): Promise<ModelPrice | null> {
    const row = await this.modelPriceRepo.findOne({
      where: {
        provider,
        model,
        enabled: 1,
        effectiveFrom: LessThanOrEqual(new Date()),
      },
      order: { effectiveFrom: 'DESC' },
    });
    if (!row) {
      // 未配置：显式返回 null（不落 0，不猜测）
      return null;
    }
    return {
      provider: row.provider,
      model: row.model,
      // decimal 列经 mysql2 以字符串返回，此处显式转数值
      promptPrice: Number(row.promptPrice),
      completionPrice: Number(row.completionPrice),
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
    };
  }

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
    // 平台跨租户身份（无目标租户）→ 直取平台默认配置（'default' 租户无配置行，
    // findOne 落空后自然走第 3 步降级分支）
    const tenantId = ctx.tenantId ?? 'default';

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
          // R101-AI-08：来源为商家可写端点时保留连接期守卫标记
          strictEgress: resolved.providerConfig.strictEgress,
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

    // P0-2（2026-10-09）：密钥与端点必须**同源**，禁止"平台密钥 + 租户端点"拼接。
    // 甲口径：租户自带 apiKey → 用租户 apiEndpoint；密钥降级到平台默认 → 端点
    // 钉死平台默认端点，显式忽略租户自填 apiEndpoint（告警留痕，不静默混搭），
    // 否则平台凭证会被发往租户指定地址。
    const tenantApiKey = this.crypto.decryptSafe(tenantConfig.apiKey);
    const platformApiKey = this.crypto.decryptSafe(
      platformConfig.defaultApiKey,
    );
    const apiKey = tenantApiKey ?? platformApiKey ?? '';

    if (!tenantApiKey && tenantConfig.apiEndpoint) {
      this.logger.warn(
        `租户 ${tenantConfig.tenantId} 未配置自有 API Key，已忽略其 apiEndpoint=${tenantConfig.apiEndpoint}，端点回退平台默认（禁止平台密钥发往租户指定地址）`,
      );
    }

    // 端点与密钥同源：租户密钥配租户端点；平台密钥配平台端点
    //
    // R101-AI-08：`api_endpoint` 是**商家可写**的（PUT tenants/:tenantId +
    // requireTenantAccess），必须过「仅公网 HTTPS」守卫（规则 a/b/c 同步拒绝；
    // 规则 d 由 strictEgress 在连接期用同一次解析校验）。平台 default_endpoint
    // 是平台维护的端点 ⇒ 只记录 + 告警，**不拒绝**（信任边界，无法读取生产取值）。
    const tenantEndpoint = tenantConfig.apiEndpoint;
    let baseUrl: string | undefined;
    let strictEgress = false;
    if (tenantApiKey && tenantEndpoint) {
      baseUrl = assertAllowedOutboundUrl(tenantEndpoint); // 违规即显式失败（400 语义）
      strictEgress = true;
    } else {
      baseUrl = platformConfig.defaultEndpoint ?? undefined;
      this.observePlatformEndpoint(tenantConfig.tenantId, baseUrl);
    }

    if (!apiKey) {
      this.logger.warn(
        `租户 ${tenantConfig.tenantId} 和平台默认配置均无可用 API Key`,
      );
    }

    return {
      provider: tenantConfig.provider,
      providerConfig: {
        apiKey,
        baseUrl,
        model: tenantConfig.model,
        temperature: Number(tenantConfig.temperature),
        max_tokens: tenantConfig.maxTokens,
        // R101-AI-08：租户自填端点 ⇒ 连接期仍需同源校验（防 DNS 重绑定）
        strictEgress,
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

    // R101-AI-08：平台端点只记录 + 告警，不拒绝（信任边界）
    this.observePlatformEndpoint(tenantId, platformConfig.defaultEndpoint);

    return {
      provider: platformConfig.defaultProvider,
      providerConfig: {
        apiKey,
        baseUrl: platformConfig.defaultEndpoint ?? undefined,
        model: platformConfig.defaultModel,
        temperature: Number(platformConfig.defaultTemperature),
        max_tokens: platformConfig.defaultMaxTokens,
        // 平台端点：不挂 strictEgress（本卡明确不得擅自拒绝）
        strictEgress: false,
      },
      model: platformConfig.defaultModel,
      temperature: Number(platformConfig.defaultTemperature),
      maxTokens: platformConfig.defaultMaxTokens,
      systemPrompt: platformConfig.defaultSystemPrompt,
      source: 'platform',
    };
  }

  /**
   * 平台端点「记录 + 告警」（R101-AI-08 信任边界）
   *
   * 平台 `t_platform_ai_config.default_endpoint` 由平台管理员维护 ⇒ 本卡**不得**
   * 擅自拒绝（生产取值读取不到，贸然拒绝可能误伤在用链路）。此处只做同步可判定
   * 的观察：scheme 非 https / 内嵌凭据 / 受限 IP 字面量 ⇒ WARN 留痕，不抛错。
   *
   * ⚠️ 残余风险：以**内网域名**形式配置的平台端点，在不产生额外 DNS 查询的前提下
   * 无法观察（连接期守卫按卡内要求不对平台端点生效）；需要时改用周期性审计任务。
   */
  private observePlatformEndpoint(
    tenantId: string,
    endpoint: string | null | undefined,
  ): void {
    if (!endpoint) {
      return;
    }
    try {
      assertAllowedOutboundUrl(endpoint);
    } catch (err) {
      // 只记 host，不记完整 URL（避免把内嵌凭据写进日志）
      let host = '(unparsable)';
      try {
        host = new URL(endpoint).hostname;
      } catch {
        host = '(unparsable)';
      }
      this.logger.warn(
        `平台端点不合「仅公网 HTTPS」口径（tenant=${tenantId} host=${host}）：` +
          `${err instanceof Error ? err.message : String(err)}` +
          ` —— 按 R101-AI-08 信任边界仅记录告警，不拒绝`,
      );
    }
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
