/**
 * ProviderRouterService — C9 自适应路由 + 降级链（完善度 P0-6 / P1-3）
 *
 * 职责：
 * 1. 统一 Provider 选择入口：用户指定模型 > 租户/平台配置 > 系统默认
 * 2. 支持 SYSTEM_SCOPE 维度（mgmt 管理系统 / ops 运营系统）：
 *    配置决定，能力无差别；ops 形态可优先本地 Ollama（配置项）
 * 3. P1-3 降级链（文档 17.2）：云端默认（智谱 GLM）+ 本地 Ollama 兜底；
 *    Provider 调用超时/失败自动切换下一个候选，全部失败才抛错
 * 4. 降级可观测：返回 fallback 元数据（from/to/reason/attempts/latencyMs），
 *    调用方写入审计日志
 * 5. 路由决策留痕（日志），供 LN 后期自学习路由扩展
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-6 C9 自适应路由
 * - docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 17.2 Provider 故障切换
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from '../../providers/provider-factory';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  IModelProvider,
} from '../../providers/provider.interface';
import type { ResolvedAiConfig } from '../../tenant/ai-config.service';
import { AiConfigService } from '../../tenant/ai-config.service';

/** 路由输入 */
export interface RouteInput {
  /** 用户显式指定的模型标识（可选） */
  requestedModel?: string;
  /** 租户/平台解析后的配置 */
  resolved: ResolvedAiConfig;
  /** 系统形态（mgmt/ops，来自 SYSTEM_SCOPE） */
  systemScope: string;
}

/** 路由结果 */
export interface RouteResult {
  /** 最终 Provider 名 */
  providerName: string;
  /** Provider 实例 */
  provider: IModelProvider;
  /** 路由依据说明 */
  reason: string;
}

/** 降级链元数据（可观测，写入审计） */
export interface FallbackMeta {
  /** 是否发生了降级 */
  used: boolean;
  /** 原始主 Provider */
  from: string;
  /** 实际使用的 Provider */
  to: string;
  /** 降级原因（上一个候选的失败信息） */
  reason: string;
  /** 尝试过的候选（含成功者） */
  attempts: string[];
  /** 总耗时（含降级切换） */
  latencyMs: number;
}

/** 带降级元数据的 ChatResult */
export type ChatResultWithFallback = ChatResult & {
  fallback?: FallbackMeta;
};

/**
 * Provider 降级链（文档 17.2）
 *
 * glm（云端默认）→ 本地 Ollama 兜底 → 其他云端备用
 * ollama（本地）→ 云端兜底
 */
const FALLBACK_CHAIN: Record<string, string[]> = {
  glm: ['ollama', 'deepseek', 'qwen'],
  deepseek: ['ollama', 'glm', 'qwen'],
  qwen: ['ollama', 'glm', 'deepseek'],
  ollama: ['glm', 'deepseek'],
};

/** 主 Provider 降级快速失败超时（ms，env FALLBACK_PROVIDER_TIMEOUT_MS 可配，默认 30s） */
const DEFAULT_FALLBACK_TIMEOUT_MS = 30000;

@Injectable()
export class ProviderRouterService {
  private readonly logger = new Logger(ProviderRouterService.name);

  constructor(
    private readonly factory: ProviderFactory,
    private readonly configService: ConfigService,
    private readonly aiConfig: AiConfigService,
  ) {}

  /**
   * 路由 Provider（C9）
   *
   * 优先级：
   * 1. 用户显式指定且已注册 → 使用指定模型
   * 2. 租户/平台配置 → 使用配置 Provider
   * 3. 兜底：内置默认（glm）
   */
  route(input: RouteInput): RouteResult {
    const requested = input.requestedModel?.trim();

    // 1. 用户指定模型（对话级切换）
    if (requested && this.factory.isRegistered(requested)) {
      return {
        providerName: requested,
        provider: this.factory.create(requested),
        reason: `用户指定模型：${requested}`,
      };
    }

    // 2. 租户/平台配置
    try {
      const provider = this.factory.create(
        input.resolved.provider,
        input.resolved.providerConfig,
      );
      return {
        providerName: input.resolved.provider,
        provider,
        reason: `租户/平台配置：${input.resolved.provider}（source=${input.resolved.source}）`,
      };
    } catch (err) {
      this.logger.warn(
        `配置 Provider ${input.resolved.provider} 不可用（${
          err instanceof Error ? err.message : String(err)
        }），回退内置默认`,
      );
    }

    // 3. 兜底：内置默认
    const fallback = this.factory.create('glm');
    return {
      providerName: 'glm',
      provider: fallback,
      reason: `回退内置默认：glm`,
    };
  }

  /**
   * 当前系统形态（SYSTEM_SCOPE，默认 mgmt）
   */
  getSystemScope(): string {
    return this.configService.get<string>('SYSTEM_SCOPE', 'mgmt');
  }

  /**
   * 解析完整降级链（主 Provider + 备用候选）
   *
   * - 主 Provider 按 C9 路由（用户指定 > 租户/平台 > 默认）
   * - 备用候选按 FALLBACK_CHAIN；OLLAMA_FALLBACK_ENABLED=false 时跳过 ollama
   * - 未注册的候选跳过（factory.create 抛错）
   */
  resolveChain(input: RouteInput): RouteResult[] {
    const primary = this.route(input);
    const chain: RouteResult[] = [primary];
    const fallbacks = FALLBACK_CHAIN[primary.providerName] ?? [];

    for (const fb of fallbacks) {
      if (fb === primary.providerName) {
        continue;
      }
      try {
        chain.push({
          providerName: fb,
          provider: this.factory.create(fb),
          reason: `降级候选：${fb}`,
        });
      } catch (err) {
        this.logger.debug(
          `降级候选 ${fb} 不可用（跳过）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return chain;
  }

  /**
   * 流式对话 + 降级链（P1-3）
   *
   * 先拉取首个 chunk 验证候选可用；首个 chunk 抛错（连接/认证/超时）→
   * 自动切换下一个候选；已有输出后不切换（避免重复输出）。
   *
   * @param messages   对话消息
   * @param options    调用选项（内部叠加快速失败超时 signal）
   * @param input      路由输入
   * @returns 流式生成器；return 值为带 fallback 元数据的 ChatResult
   */
  async *chatWithFallback(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    input: RouteInput,
  ): AsyncGenerator<string, ChatResultWithFallback, unknown> {
    const chain = await this.resolveChainWithSwitch(input);
    const start = Date.now();
    let lastError: string | undefined;
    const fallbackTimeout = this.configService.get<number>(
      'FALLBACK_PROVIDER_TIMEOUT_MS',
      DEFAULT_FALLBACK_TIMEOUT_MS,
    );

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fallbackTimeout);
      try {
        const generator = entry.provider.chat(messages, {
          ...options,
          signal: controller.signal,
        });
        // 首个 chunk：连接/请求错误在此抛出 → 触发降级
        const first = await generator.next();
        if (first.done) {
          // 未产出文本即完成（如 LLM 直接结束）
          return {
            ...first.value,
            fallback: this.buildMeta(chain, i, start, lastError),
          };
        }
        // 首个 chunk 成功 → 转发并消费剩余
        yield first.value;
        let next: IteratorResult<string, ChatResult>;
        while (true) {
          next = await generator.next();
          if (next.done) {
            return {
              ...next.value,
              fallback: this.buildMeta(chain, i, start, lastError),
            };
          }
          yield next.value;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Provider ${entry.providerName} 调用失败（降级切换）：${lastError}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`所有 AI 服务商均不可用：${lastError ?? '未知错误'}`);
  }

  /**
   * 非流式对话 + 降级链（P1-3；供 MCP/抽取等同步调用场景）
   */
  async chatSyncWithFallback(
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    input: RouteInput,
  ): Promise<ChatResultWithFallback> {
    const chain = await this.resolveChainWithSwitch(input);
    const start = Date.now();
    let lastError: string | undefined;
    const fallbackTimeout = this.configService.get<number>(
      'FALLBACK_PROVIDER_TIMEOUT_MS',
      DEFAULT_FALLBACK_TIMEOUT_MS,
    );

    for (let i = 0; i < chain.length; i++) {
      const entry = chain[i];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), fallbackTimeout);
      try {
        const result = await entry.provider.chatSync(messages, {
          ...options,
          signal: controller.signal,
        });
        return {
          ...result,
          fallback: this.buildMeta(chain, i, start, lastError),
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Provider ${entry.providerName} 同步调用失败（降级切换）：${lastError}`,
        );
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error(`所有 AI 服务商均不可用：${lastError ?? '未知错误'}`);
  }

  /**
   * 解析降级链并应用「本地 Ollama 兜底开关」
   */
  private async resolveChainWithSwitch(
    input: RouteInput,
  ): Promise<RouteResult[]> {
    let fallbackEnabled = true;
    try {
      fallbackEnabled = await this.aiConfig.isFallbackEnabled();
    } catch {
      // 读取失败按默认开启处理
    }

    const chain = this.resolveChain(input);
    if (fallbackEnabled) {
      return chain;
    }
    // 开关关闭：移除 ollama 候选（主 Provider 是 ollama 时保留——用户/租户显式选择）
    const filtered = chain.filter(
      (entry, idx) => idx === 0 || entry.providerName !== 'ollama',
    );
    return filtered.length > 0 ? filtered : chain;
  }

  private buildMeta(
    chain: RouteResult[],
    usedIndex: number,
    start: number,
    lastError: string | undefined,
  ): FallbackMeta {
    return {
      used: usedIndex > 0,
      from: chain[0].providerName,
      to: chain[usedIndex].providerName,
      reason: lastError ?? '',
      attempts: chain
        .slice(0, usedIndex + 1)
        .map((entry) => entry.providerName),
      latencyMs: Date.now() - start,
    };
  }
}
