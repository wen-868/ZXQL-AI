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
import { degrade } from '../common/error-semantics';
import {
  assertAllowedOutboundUrl,
  assertPublicResolvableTarget,
} from '../common/outbound-target.guard';

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
    // 表不存在（迁移未执行）时不阻塞启动：外部模型属可选旁路，仅降级
    await degrade(
      async () => {
        const models = await this.repo.find({ where: { enabled: 1 } });
        for (const model of models) {
          this.registerModel(model);
        }
        if (models.length > 0) {
          this.logger.log(`已加载 ${models.length} 个外部大模型`);
        }
      },
      undefined,
      { op: 'externalModel.loadAll' },
    );
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
    // R101-AI-13：运行时配置路径同样复验 a/b/c（存量/直插库违规行不得出站）。
    // 违规即抛（显式失败），不静默回落 —— 复用同一守卫，无第二套判定。
    const baseUrl = assertAllowedOutboundUrl(entity.providerBaseUrl);
    try {
      return {
        baseUrl,
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
   * R101-AI-04：出站目标收敛为「仅公网 HTTPS」，本方法同时覆盖
   * 传入 URL（a/b/c 同步 + d 解析全部 A/AAAA）。
   *
   * @param config 测试配置（baseUrl + apiKey + modelName）
   */
  async testConnection(config: {
    providerBaseUrl: string;
    apiKey: string;
    modelName: string;
  }): Promise<{ success: boolean; message: string; latencyMs: number }> {
    const baseUrl = await this.assertEgressTarget(config.providerBaseUrl);
    const provider = new OpenAICompatProvider('external_test', {
      baseUrl,
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
   *
   * R101-AI-04：库里**已存**的 providerBaseUrl 同样是出站目标，必须与传入路径
   * 走同一个收口（此前只校验入参、放过存量行）。
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
    const baseUrl = await this.assertEgressTarget(entity.providerBaseUrl);
    const provider = new OpenAICompatProvider(entity.name, {
      baseUrl,
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

  /**
   * 出站目标收口（R101-AI-04）
   *
   * 先走 normalizeBaseUrl（保留旧口径的协议错误文案），再做「仅公网 HTTPS」
   * 全量校验（含域名解析全部 A/AAAA）。
   */
  private async assertEgressTarget(raw: string): Promise<string> {
    const normalized = this.normalizeBaseUrl(raw);
    return assertPublicResolvableTarget(normalized);
  }

  /** 解密并注册单个模型到 ProviderFactory */
  private registerModel(entity: AiExternalModelEntity): void {
    if (!entity.apiKey) {
      this.logger.warn(
        `外部模型 ${entity.name} 未配置 API Key，跳过注册（请编辑补全）`,
      );
      return;
    }
    // R101-AI-13（P1）：**运行时注册入口复验规则 a/b/c**
    //
    // 存量违规行（`da2d5dd` 之前入库的 `http://127.0.0.1:8080` 等）或绕过管理端
    // 直插库的行，此前会跳过"保存前校验"直接注册 ⇒ 对话链路（chatSync）继续出站。
    // 连接期 `lookup` 只能兜"域名解析到私网"（规则 d），而 scheme 不复验、
    // IP 字面量又会跳过 lookup ⇒ 三层皆无拦截，故必须在此拦下。
    // 复用同一守卫（`assertAllowedOutboundUrl`），不另写第二套判定。
    let baseUrl: string;
    try {
      baseUrl = assertAllowedOutboundUrl(entity.providerBaseUrl);
    } catch (err) {
      this.logger.error(
        `外部模型 ${entity.name} 的 providerBaseUrl 未通过出站目标校验，**拒绝注册**` +
          `（id=${entity.id} host=${this.safeHostOf(entity.providerBaseUrl)}）：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return; // 只拒该行，不影响其余模型的注册
    }
    const config: ProviderConfig = {
      apiKey: this.crypto.decrypt(entity.apiKey),
      baseUrl,
      model: entity.modelName,
    };
    this.factory.registerExternal(entity.name, config);
  }

  /** 仅取 host 用于日志（不回显完整 URL，避免带出 GET 参数/内嵌凭据） */
  private safeHostOf(raw: string): string {
    try {
      return new URL(raw).hostname;
    } catch {
      return '(unparsable)';
    }
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

  /**
   * 规范化 baseUrl：去尾部斜杠，必须 http(s) 开头
   *
   * R101-AI-04：保存前（create/update）在此收口出站目标规则 a/b/c
   * —— 只允许 `https:`、拒绝内嵌凭据、拒绝受限网段 IP 字面量。
   * 规则 d（域名解析全部 A/AAAA）在出站前与连接期判定，见 assertEgressTarget。
   */
  private normalizeBaseUrl(raw: string): string {
    const url = raw.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) {
      throw new ConflictException('API 地址必须以 http:// 或 https:// 开头');
    }
    return assertAllowedOutboundUrl(url);
  }
}
