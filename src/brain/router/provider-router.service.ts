/**
 * ProviderRouterService — C9 自适应路由（完善度 P0-6）
 *
 * 职责：
 * 1. 统一 Provider 选择入口：用户指定模型 > 租户/平台配置 > 系统默认
 * 2. 支持 SYSTEM_SCOPE 维度（mgmt 管理系统 / ops 运营系统）：
 *    配置决定，能力无差别；ops 形态可优先本地 Ollama（配置项）
 * 3. 路由决策留痕（日志），供 LN 后期自学习路由扩展
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-6 C9 自适应路由
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderFactory } from '../../providers/provider-factory';
import type { IModelProvider } from '../../providers/provider.interface';
import type { ResolvedAiConfig } from '../../tenant/ai-config.service';

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

@Injectable()
export class ProviderRouterService {
  private readonly logger = new Logger(ProviderRouterService.name);

  constructor(
    private readonly factory: ProviderFactory,
    private readonly configService: ConfigService,
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
}
