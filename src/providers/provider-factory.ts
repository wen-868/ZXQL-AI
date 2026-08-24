import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IModelProvider, ProviderConfig } from './provider.interface';
import { GlmProvider } from './glm.provider';
import { DeepSeekProvider } from './deepseek.provider';
import { OllamaProvider } from './ollama.provider';
import { ProviderError } from './provider-error';
import { OpenAICompatProvider } from './openai-compat.provider';

/**
 * Provider 工厂（SimpleFactory 模式）
 *
 * 职责：
 * - 根据 provider 名称返回对应实例（DeepSeek / Ollama / ...）
 * - 支持运行时切换：通过 configure(config) 注入租户级配置（API Key / 模型 / 温度等）
 * - 缓存已创建的实例：DeepSeek/Ollama Provider 均为 NestJS 单例，工厂复用同一实例
 *
 * 设计权衡：
 * - 当前阶段（R70-03）所有调用方共享单例，configure() 会切换全局配置
 * - 多租户并发隔离问题留待 R70-07 多租户任务解决（届时改用 AsyncLocalStorage + 请求级实例）
 *
 * 用法：
 *   const provider = factory.create('deepseek', { apiKey, model });
 *   const result = await provider.chatSync(messages);
 *   // 或获取默认 provider：
 *   const defaultProvider = factory.getDefault();
 */
@Injectable()
export class ProviderFactory {
  private readonly logger = new Logger(ProviderFactory.name);
  /** 单例池：type → provider 实例 */
  private readonly providers = new Map<string, IModelProvider>();
  /** 默认 provider 类型（从 DEFAULT_MODEL_PROVIDER 读取） */
  private readonly defaultType: string;

  constructor(
    private readonly glm: GlmProvider,
    private readonly deepseek: DeepSeekProvider,
    private readonly ollama: OllamaProvider,
    private readonly configService: ConfigService,
  ) {
    // 注册所有已实现的 Provider
    this.providers.set('glm', this.glm);
    this.providers.set('deepseek', this.deepseek);
    this.providers.set('ollama', this.ollama);

    this.defaultType = this.configService.get<string>(
      'DEFAULT_MODEL_PROVIDER',
      'glm',
    );

    if (!this.providers.has(this.defaultType)) {
      this.logger.warn(
        `DEFAULT_MODEL_PROVIDER=${this.defaultType} 不在已注册列表 [${this.list().join(', ')}] 中，将回退到 glm`,
      );
    }
  }

  /**
   * 创建（或获取缓存的）Provider 实例
   *
   * @param type   Provider 类型（'glm' | 'deepseek' | 'ollama' | ...）
   * @param config 运行时配置（覆盖默认 env 配置，支持租户级切换）
   * @returns Provider 实例（已 configure）
   *
   * @throws ProviderError 未知 provider 时抛 400
   */
  create(type: string, config?: ProviderConfig): IModelProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new ProviderError(
        `未知的 Provider 类型：${type}，已注册：[${this.list().join(', ')}]`,
        400,
        type,
      );
    }
    if (config) {
      provider.configure(config);
    }
    return provider;
  }

  /**
   * 动态注册外部 OpenAI 兼容大模型（完善度-外部模型接入）
   *
   * 由 ExternalModelService 在启动/配置变更时调用：
   * - 同名注册视为更新（覆盖旧的通用实例）
   * - 注册后 create(name) / 平台/租户配置选择该模型即可直接使用
   *
   * @param name   外部模型唯一标识（如 custom_kimi）
   * @param config OpenAI 兼容 Provider 运行时配置
   */
  registerExternal(name: string, config: ProviderConfig): void {
    const provider = new OpenAICompatProvider(name, config);
    this.providers.set(name, provider);
    this.logger.log(
      `外部模型已注册：${name}（model=${config.model}, baseUrl=${config.baseUrl ?? '(默认)'}）`,
    );
  }

  /**
   * 注销外部模型（删除配置时调用，避免残留无效 Provider）
   *
   * @param name 外部模型唯一标识
   */
  unregisterExternal(name: string): void {
    if (this.providers.delete(name)) {
      this.logger.log(`外部模型已注销：${name}`);
    }
  }

  /**
   * 判断指定 Provider 类型是否已注册
   */
  isRegistered(type: string): boolean {
    return this.providers.has(type);
  }

  /**
   * 获取默认 Provider（从 DEFAULT_MODEL_PROVIDER 读取）
   *
   * 不传 config 时使用 env 中的默认配置（DeepSeekProvider 构造时已读取）。
   */
  getDefault(): IModelProvider {
    if (this.providers.has(this.defaultType)) {
      return this.providers.get(this.defaultType)!;
    }
    this.logger.warn(`默认 Provider ${this.defaultType} 不可用，回退到 glm`);
    return this.providers.get('glm')!;
  }

  /**
   * 获取指定 Provider（不 configure，用于 testConnection 等只读操作）
   *
   * @throws ProviderError 未知 provider 时抛 400
   */
  get(type: string): IModelProvider {
    const provider = this.providers.get(type);
    if (!provider) {
      throw new ProviderError(
        `未知的 Provider 类型：${type}，已注册：[${this.list().join(', ')}]`,
        400,
        type,
      );
    }
    return provider;
  }

  /**
   * 判断 Provider 是否已注册
   */
  has(type: string): boolean {
    return this.providers.has(type);
  }

  /**
   * 列出所有已注册的 Provider 类型
   */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * 列出所有已注册 Provider 的详情（用于工作台展示）
   */
  listWithDetails(): Array<{ type: string; name: string }> {
    return Array.from(this.providers.entries()).map(([type, p]) => ({
      type,
      name: p.name,
    }));
  }

  /**
   * 测试指定 Provider 的连通性（不传 type 则测试默认 Provider）
   */
  async testConnection(type?: string): Promise<{
    type: string;
    success: boolean;
    message: string;
    latencyMs: number;
  }> {
    const target = type ?? this.defaultType;
    const provider = this.providers.get(target) ?? this.getDefault();
    const result = await provider.testConnection();
    return {
      type: target,
      ...result,
    };
  }
}
