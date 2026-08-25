/**
 * AiConfigAdminService — AI 配置管理服务（平台总后台专用）
 *
 * 职责：
 * 1. 平台默认配置：读取 / 更新（t_platform_ai_config）
 * 2. 租户 AI 配置：分页列表 / 详情 / 更新（t_tenant_ai_config，apiKey 加密存储）
 * 3. 用量统计：按租户 + 日期范围查询（t_ai_usage_daily，按日汇总）
 * 4. 计费套餐：列表 / 更新（t_tenant_ai_billing）
 *
 * 安全约定：
 * - 所有对外返回的配置视图均对 apiKey 脱敏（不返回明文/密文，仅 apiKeySet + apiKeyMasked）
 * - 写入时 apiKey 必须经 CryptoService.encrypt()（AES-256-GCM）加密后存储
 * - 更新平台配置后调用 AiConfigService.clearCache() 使运行时读取立即生效
 *
 * 端点对应（全局前缀 /api，实际路径 /api/admin/ai-config/...）：
 * - GET  /api/admin/ai-config/platform
 * - PUT  /api/admin/ai-config/platform
 * - GET  /api/admin/ai-config/tenants
 * - GET  /api/admin/ai-config/tenants/:tenantId
 * - PUT  /api/admin/ai-config/tenants/:tenantId
 * - GET  /api/admin/ai-config/usage
 * - GET  /api/admin/ai-config/billing
 * - PUT  /api/admin/ai-config/billing/:tenantId
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  Between,
  FindOptionsWhere,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { AiUsageDailyEntity } from '../database/entities/ai-usage-daily.entity';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { CryptoService } from './crypto.service';
import { AiConfigService } from './ai-config.service';
import { maskApiKey } from './api-key-mask';

/** 平台配置对外视图（apiKey 脱敏） */
export interface PlatformConfigView {
  id: number;
  defaultProvider: string;
  defaultModel: string;
  defaultEndpoint: string | null;
  defaultTemperature: number;
  defaultMaxTokens: number;
  defaultSystemPrompt: string | null;
  /** 本地 Ollama 兜底开关（1=开启 0=关闭） */
  ollamaFallbackEnabled: number;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 租户配置对外视图（apiKey 脱敏） */
export interface TenantConfigView {
  id: number;
  tenantId: string;
  enabled: number;
  provider: string;
  apiEndpoint: string | null;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string | null;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 用量统计汇总 */
export interface UsageSummary {
  chatCount: number;
  toolCallCount: number;
  totalTokens: number;
  totalCost: number;
}

@Injectable()
export class AiConfigAdminService {
  private readonly logger = new Logger(AiConfigAdminService.name);

  constructor(
    @InjectRepository(PlatformAiConfigEntity)
    private readonly platformRepo: Repository<PlatformAiConfigEntity>,
    @InjectRepository(TenantAiConfigEntity)
    private readonly tenantRepo: Repository<TenantAiConfigEntity>,
    @InjectRepository(AiUsageDailyEntity)
    private readonly usageRepo: Repository<AiUsageDailyEntity>,
    @InjectRepository(TenantAiBillingEntity)
    private readonly billingRepo: Repository<TenantAiBillingEntity>,
    private readonly crypto: CryptoService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // 平台默认配置
  // ──────────────────────────────────────────────────────────────

  /**
   * 获取平台默认配置（脱敏）
   */
  async getPlatformConfig(): Promise<PlatformConfigView> {
    const config = await this.platformRepo.findOne({ where: { id: 1 } });
    if (!config) {
      throw new NotFoundException(
        '平台默认 AI 配置不存在（t_platform_ai_config 无 id=1 记录），请先执行数据库迁移',
      );
    }
    return this.toPlatformView(config);
  }

  /**
   * 更新平台默认配置（apiKey 非空时加密存储，空字符串视为不改动）
   */
  async updatePlatformConfig(input: {
    defaultProvider?: string;
    defaultModel?: string;
    apiKey?: string;
    defaultEndpoint?: string;
    defaultTemperature?: number;
    defaultMaxTokens?: number;
    defaultSystemPrompt?: string;
    ollamaFallbackEnabled?: number;
  }): Promise<PlatformConfigView> {
    let config = await this.platformRepo.findOne({ where: { id: 1 } });
    if (!config) {
      config = this.platformRepo.create({ id: 1 });
    }

    if (input.defaultProvider !== undefined) {
      config.defaultProvider = input.defaultProvider;
    }
    if (input.defaultModel !== undefined) {
      config.defaultModel = input.defaultModel;
    }
    if (input.apiKey !== undefined && input.apiKey !== '') {
      config.defaultApiKey = this.crypto.encrypt(input.apiKey);
    }
    if (input.defaultEndpoint !== undefined) {
      config.defaultEndpoint = input.defaultEndpoint;
    }
    if (input.defaultTemperature !== undefined) {
      config.defaultTemperature = input.defaultTemperature;
    }
    if (input.defaultMaxTokens !== undefined) {
      config.defaultMaxTokens = input.defaultMaxTokens;
    }
    if (input.defaultSystemPrompt !== undefined) {
      config.defaultSystemPrompt = input.defaultSystemPrompt;
    }
    if (input.ollamaFallbackEnabled !== undefined) {
      config.ollamaFallbackEnabled = input.ollamaFallbackEnabled;
    }

    const saved = await this.platformRepo.save(config);
    // 清除运行时缓存，使平台配置立即生效
    this.aiConfigService.clearCache();
    this.logger.log(`平台默认 AI 配置已更新（id=${saved.id}）`);
    return this.toPlatformView(saved);
  }

  // ──────────────────────────────────────────────────────────────
  // 租户 AI 配置
  // ──────────────────────────────────────────────────────────────

  /**
   * 租户 AI 配置分页列表（可按 tenantId 过滤）
   */
  async listTenantConfigs(options: {
    tenantId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    list: TenantConfigView[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { tenantId, page = 1, pageSize = 20 } = options;
    const where: FindOptionsWhere<TenantAiConfigEntity> = tenantId
      ? { tenantId }
      : {};

    const [rows, total] = await this.tenantRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { id: 'DESC' },
    });

    return {
      list: rows.map((row) => this.toTenantView(row)),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 租户 AI 配置详情（脱敏）
   */
  async getTenantConfig(tenantId: string): Promise<TenantConfigView> {
    const config = await this.tenantRepo.findOne({ where: { tenantId } });
    if (!config) {
      throw new NotFoundException(`租户 ${tenantId} 的 AI 配置不存在`);
    }
    return this.toTenantView(config);
  }

  /**
   * 更新租户 AI 配置（不存在则创建，apiKey 非空时加密存储）
   */
  async updateTenantConfig(
    tenantId: string,
    input: {
      enabled?: number;
      provider?: string;
      apiKey?: string;
      apiEndpoint?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      systemPrompt?: string;
    },
  ): Promise<TenantConfigView> {
    let config = await this.tenantRepo.findOne({ where: { tenantId } });
    if (!config) {
      config = this.tenantRepo.create({ tenantId });
    }

    if (input.enabled !== undefined) {
      config.enabled = input.enabled;
    }
    if (input.provider !== undefined) {
      config.provider = input.provider;
    }
    if (input.apiKey !== undefined && input.apiKey !== '') {
      config.apiKey = this.crypto.encrypt(input.apiKey);
    }
    if (input.apiEndpoint !== undefined) {
      config.apiEndpoint = input.apiEndpoint;
    }
    if (input.model !== undefined) {
      config.model = input.model;
    }
    if (input.temperature !== undefined) {
      config.temperature = input.temperature;
    }
    if (input.maxTokens !== undefined) {
      config.maxTokens = input.maxTokens;
    }
    if (input.systemPrompt !== undefined) {
      config.systemPrompt = input.systemPrompt;
    }

    const saved = await this.tenantRepo.save(config);
    this.logger.log(`租户 ${tenantId} 的 AI 配置已更新（id=${saved.id}）`);
    return this.toTenantView(saved);
  }

  // ──────────────────────────────────────────────────────────────
  // 用量统计
  // ──────────────────────────────────────────────────────────────

  /**
   * 用量统计（t_ai_usage_daily 按日汇总，支持 tenantId + 日期范围过滤）
   */
  async getUsageStats(options: {
    startDate?: string;
    endDate?: string;
    tenantId?: string;
  }): Promise<{ list: AiUsageDailyEntity[]; summary: UsageSummary }> {
    const { startDate, endDate, tenantId } = options;

    const where: FindOptionsWhere<AiUsageDailyEntity> = {};
    if (tenantId) {
      where.tenantId = tenantId;
    }
    if (startDate && endDate) {
      where.statDate = Between(startDate, endDate);
    } else if (startDate) {
      where.statDate = MoreThanOrEqual(startDate);
    } else if (endDate) {
      where.statDate = LessThanOrEqual(endDate);
    }

    const rows = await this.usageRepo.find({
      where,
      order: { statDate: 'DESC' },
    });

    const summary: UsageSummary = rows.reduce(
      (acc, row) => {
        acc.chatCount += row.chatCount;
        acc.toolCallCount += row.toolCallCount;
        acc.totalTokens += Number(row.totalTokens);
        acc.totalCost += Number(row.totalCost);
        return acc;
      },
      { chatCount: 0, toolCallCount: 0, totalTokens: 0, totalCost: 0 },
    );

    return { list: rows, summary };
  }

  // ──────────────────────────────────────────────────────────────
  // 计费套餐
  // ──────────────────────────────────────────────────────────────

  /**
   * 租户计费套餐分页列表（可按 tenantId 过滤）
   */
  async listBillings(options: {
    tenantId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{
    list: TenantAiBillingEntity[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const { tenantId, page = 1, pageSize = 20 } = options;
    const where: FindOptionsWhere<TenantAiBillingEntity> = tenantId
      ? { tenantId }
      : {};

    const [rows, total] = await this.billingRepo.findAndCount({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      order: { id: 'DESC' },
    });

    return { list: rows, total, page, pageSize };
  }

  /**
   * 更新租户计费套餐（不存在则创建）
   */
  async updateBilling(
    tenantId: string,
    input: {
      planType?: string;
      freeChatCount?: number;
      freeTokenLimit?: number;
      overagePrice?: number;
      monthlyChatLimit?: number;
      monthlyTokenLimit?: number;
      monthlyPrice?: number;
      enabled?: number;
    },
  ): Promise<TenantAiBillingEntity> {
    let billing = await this.billingRepo.findOne({ where: { tenantId } });
    if (!billing) {
      billing = this.billingRepo.create({ tenantId });
    }

    if (input.planType !== undefined) {
      billing.planType = input.planType;
    }
    if (input.freeChatCount !== undefined) {
      billing.freeChatCount = input.freeChatCount;
    }
    if (input.freeTokenLimit !== undefined) {
      billing.freeTokenLimit = input.freeTokenLimit;
    }
    if (input.overagePrice !== undefined) {
      billing.overagePrice = input.overagePrice;
    }
    if (input.monthlyChatLimit !== undefined) {
      billing.monthlyChatLimit = input.monthlyChatLimit;
    }
    if (input.monthlyTokenLimit !== undefined) {
      billing.monthlyTokenLimit = input.monthlyTokenLimit;
    }
    if (input.monthlyPrice !== undefined) {
      billing.monthlyPrice = input.monthlyPrice;
    }
    if (input.enabled !== undefined) {
      billing.enabled = input.enabled;
    }

    const saved = await this.billingRepo.save(billing);
    this.logger.log(`租户 ${tenantId} 的计费套餐已更新（id=${saved.id}）`);
    return saved;
  }

  // ──────────────────────────────────────────────────────────────
  // 私有工具
  // ──────────────────────────────────────────────────────────────

  /**
   * 平台配置 → 脱敏视图
   */
  private toPlatformView(config: PlatformAiConfigEntity): PlatformConfigView {
    const apiKey = this.crypto.decryptSafe(config.defaultApiKey);
    return {
      id: config.id,
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      defaultEndpoint: config.defaultEndpoint,
      defaultTemperature: Number(config.defaultTemperature),
      defaultMaxTokens: config.defaultMaxTokens,
      defaultSystemPrompt: config.defaultSystemPrompt,
      ollamaFallbackEnabled: config.ollamaFallbackEnabled,
      apiKeySet: apiKey !== null && apiKey !== '',
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : null,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * 租户配置 → 脱敏视图
   */
  private toTenantView(config: TenantAiConfigEntity): TenantConfigView {
    const apiKey = this.crypto.decryptSafe(config.apiKey);
    return {
      id: config.id,
      tenantId: config.tenantId,
      enabled: config.enabled,
      provider: config.provider,
      apiEndpoint: config.apiEndpoint,
      model: config.model,
      temperature: Number(config.temperature),
      maxTokens: config.maxTokens,
      systemPrompt: config.systemPrompt,
      apiKeySet: apiKey !== null && apiKey !== '',
      apiKeyMasked: apiKey ? maskApiKey(apiKey) : null,
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }
}
