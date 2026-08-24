/**
 * ExternalModelService — 外部大模型管理服务（完善度-外部模型接入）
 *
 * 职责：
 * 1. 平台外部模型库 CRUD（t_ai_external_model，apiKey AES-256-GCM 加密存储）
 * 2. 启动时加载启用模型并注册到 ProviderFactory（OpenAI 兼容动态 Provider）
 * 3. 配置变更后同步注册表（新增/更新即注册，停用/删除即注销）
 * 4. 连通性测试（不落库，直接以明文配置发起调用）
 *
 * 安全约定（与 AiConfigAdminService 一致）：
 * - 对外视图 apiKey 脱敏（apiKeySet + apiKeyMasked）
 * - 写入时 apiKey 经 CryptoService.encrypt() 加密存储
 * - 更新时 apiKey 留空表示不修改
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiExternalModelEntity } from '../database/entities/ai-external-model.entity';
import { ProviderConfig } from '../providers/provider.interface';
import { ProviderFactory } from '../providers/provider-factory';
import { OpenAICompatProvider } from '../providers/openai-compat.provider';
import { CryptoService } from './crypto.service';
import { maskApiKey } from './api-key-mask';

/** 外部模型创建/更新载荷（class 供 Nest ValidationPipe 使用） */
export class ExternalModelInput {
  name!: string;
  displayName!: string;
  providerBaseUrl!: string;
  apiKey?: string;
  modelName!: string;
  enabled?: number;
  sortOrder?: number;
}

/** 对外视图（apiKey 脱敏） */
export interface ExternalModelView {
  id: number;
  name: string;
  displayName: string;
  providerBaseUrl: string;
  modelName: string;
  enabled: number;
  sortOrder: number;
  apiKeySet: boolean;
  apiKeyMasked: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 简化选项（配置页下拉用） */
export interface ExternalModelOption {
  name: string;
  displayName: string;
  modelName: string;
}

@Injectable()
export class ExternalModelService implements OnModuleInit {
  private readonly logger = new Logger(ExternalModelService.name);

  constructor(
    @InjectRepository(AiExternalModelEntity)
    private readonly repo: Repository<AiExternalModelEntity>,
    private readonly crypto: CryptoService,
    private readonly factory: ProviderFactory,
  ) {}

  /**
   * 启动时加载全部启用模型并注册到 ProviderFactory
   */
  async onModuleInit(): Promise<void> {
    try {
      const models = await this.repo.find({ where: { enabled: 1 } });
      for (const model of models) {
        this.registerModel(model);
      }
      if (models.length > 0) {
        this.logger.log(`已加载 ${models.length} 个外部大模型`);
      }
    } catch (err) {
      // 表不存在（迁移未执行）时不阻塞启动，仅记日志
      this.logger.warn(
        `外部模型加载失败（可能是迁移未执行）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * 外部模型列表（按 sortOrder/createdAt 排序，apiKey 脱敏）
   */
  async list(): Promise<ExternalModelView[]> {
    const rows = await this.repo.find({
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return rows.map((r) => this.toView(r));
  }

  /**
   * 配置页下拉选项（仅启用模型）
   */
  async options(): Promise<ExternalModelOption[]> {
    const rows = await this.repo.find({
      where: { enabled: 1 },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
    return rows.map((r) => ({
      name: r.name,
      displayName: r.displayName,
      modelName: r.modelName,
    }));
  }

  /**
   * 获取外部模型运行时配置（解密 apiKey）
   *
   * 供 AiConfigService 在平台/租户配置选择外部模型时补全 baseUrl/apiKey。
   *
   * @param name 外部模型唯一标识
   * @returns 未找到或未启用时返回 null
   */
  async getRuntimeConfig(
    name: string,
  ): Promise<{ baseUrl: string; apiKey: string; model: string } | null> {
    const entity = await this.repo.findOne({
      where: { name, enabled: 1 },
    });
    if (!entity || !entity.apiKey) return null;
    try {
      return {
        baseUrl: entity.providerBaseUrl,
        apiKey: this.crypto.decrypt(entity.apiKey),
        model: entity.modelName,
      };
    } catch {
      return null;
    }
  }

  /**
   * 添加外部模型（同名冲突校验；加密存储并注册）
   */
  async create(input: ExternalModelInput): Promise<ExternalModelView> {
    const name = this.normalizeName(input.name);
    const existing = await this.repo.findOne({ where: { name } });
    if (existing) {
      throw new ConflictException(`外部模型标识 ${name} 已存在`);
    }
    if (!input.apiKey) {
      throw new ConflictException('API Key 必填（外部模型接入需提供密钥）');
    }

    const entity = this.repo.create({
      name,
      displayName: input.displayName.trim(),
      providerBaseUrl: this.normalizeBaseUrl(input.providerBaseUrl),
      apiKey: this.crypto.encrypt(input.apiKey),
      modelName: input.modelName.trim(),
      enabled: input.enabled ?? 1,
      sortOrder: input.sortOrder ?? 0,
    });
    const saved = await this.repo.save(entity);
    this.registerModel(saved);
    this.logger.log(`外部模型已添加并注册：${name}（${saved.displayName}）`);
    return this.toView(saved);
  }

  /**
   * 更新外部模型（apiKey 留空不修改；更新后同步注册表）
   */
  async update(
    id: number,
    input: ExternalModelInput,
  ): Promise<ExternalModelView> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`外部模型不存在：id=${id}`);
    }

    const name = this.normalizeName(input.name);
    const dup = await this.repo.findOne({ where: { name } });
    if (dup && dup.id !== id) {
      throw new ConflictException(`外部模型标识 ${name} 已存在`);
    }

    entity.name = name;
    entity.displayName = input.displayName.trim();
    entity.providerBaseUrl = this.normalizeBaseUrl(input.providerBaseUrl);
    entity.modelName = input.modelName.trim();
    if (input.enabled !== undefined) entity.enabled = input.enabled;
    if (input.sortOrder !== undefined) entity.sortOrder = input.sortOrder;
    if (input.apiKey) {
      entity.apiKey = this.crypto.encrypt(input.apiKey);
    }

    const saved = await this.repo.save(entity);
    // 同步注册表：启用则注册（更新），停用则注销
    if (saved.enabled === 1) {
      this.registerModel(saved);
    } else {
      this.factory.unregisterExternal(saved.name);
    }
    this.logger.log(
      `外部模型已更新：${saved.name}（enabled=${saved.enabled}）`,
    );
    return this.toView(saved);
  }

  /**
   * 删除外部模型（同步注销）
   */
  async remove(id: number): Promise<{ success: boolean }> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw new NotFoundException(`外部模型不存在：id=${id}`);
    }
    this.factory.unregisterExternal(entity.name);
    await this.repo.remove(entity);
    this.logger.log(`外部模型已删除并注销：${entity.name}`);
    return { success: true };
  }

  /**
   * 连通性测试（不落库，直接以传入配置发起调用）
   *
   * @param config 测试配置（baseUrl + apiKey + modelName）
   */
  async testConnection(config: {
    providerBaseUrl: string;
    apiKey: string;
    modelName: string;
  }): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const provider = new OpenAICompatProvider('external_test', {
      baseUrl: this.normalizeBaseUrl(config.providerBaseUrl),
      apiKey: config.apiKey,
      model: config.modelName.trim(),
    });
    const result = await provider.testConnection();
    return {
      success: result.success,
      message: result.message,
      latencyMs: result.latencyMs,
    };
  }

  /**
   * 按 ID 测试已保存的外部模型（后端解密真实密钥后调用，前端不接触明文）
   */
  async testById(id: number): Promise<{
    success: boolean;
    message: string;
    latencyMs: number;
  }> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity || !entity.apiKey) {
      throw new NotFoundException(`外部模型不存在或未配置 API Key：id=${id}`);
    }
    const provider = new OpenAICompatProvider(entity.name, {
      baseUrl: entity.providerBaseUrl,
      apiKey: this.crypto.decrypt(entity.apiKey),
      model: entity.modelName,
    });
    const result = await provider.testConnection();
    return {
      success: result.success,
      message: result.message,
      latencyMs: result.latencyMs,
    };
  }

  /** 解密并注册单个模型到 ProviderFactory */
  private registerModel(entity: AiExternalModelEntity): void {
    if (!entity.apiKey) {
      this.logger.warn(
        `外部模型 ${entity.name} 未配置 API Key，跳过注册（请编辑补全）`,
      );
      return;
    }
    const config: ProviderConfig = {
      apiKey: this.crypto.decrypt(entity.apiKey),
      baseUrl: entity.providerBaseUrl,
      model: entity.modelName,
    };
    this.factory.registerExternal(entity.name, config);
  }

  private toView(r: AiExternalModelEntity): ExternalModelView {
    const plain = r.apiKey ? this.safeDecrypt(r.apiKey) : null;
    return {
      id: r.id,
      name: r.name,
      displayName: r.displayName,
      providerBaseUrl: r.providerBaseUrl,
      modelName: r.modelName,
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      apiKeySet: Boolean(r.apiKey),
      apiKeyMasked: plain ? maskApiKey(plain) : null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** 解密 apiKey 用于脱敏（解密失败返回 null，不抛错） */
  private safeDecrypt(encrypted: string): string | null {
    try {
      return this.crypto.decrypt(encrypted);
    } catch {
      return null;
    }
  }

  /** 规范化唯一标识：小写 + 非字母数字转下划线，确保与 Provider 类型命名兼容 */
  private normalizeName(raw: string): string {
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!normalized) {
      throw new ConflictException('模型标识不能为空（仅限字母数字与下划线）');
    }
    return normalized;
  }

  /** 规范化 baseUrl：去尾部斜杠，必须 http(s) 开头 */
  private normalizeBaseUrl(raw: string): string {
    const url = raw.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
      throw new ConflictException('API 地址必须以 http:// 或 https:// 开头');
    }
    return url;
  }
}
