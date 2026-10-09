/**
 * RedisProvider — 全仓唯一 Redis 连接来源（R101-AI-10 / 阶段3-B-0）
 *
 * 背景：抽取前全仓有 **5 处**各自 `new Redis(`（checkpointer / write-guard /
 * rate-limiter / memory-manager / admin 健康探针），各自持有连接池与重试策略。
 * 阶段 3 幂等键再落一份就是第 6 个池，且 `/api/admin/ai/health` 的 Redis
 * 检查口径随之失真。本 provider 把「连接创建」这一件事收敛到唯一落点。
 *
 * 设计要点（**本单是抽取，不是优化**：各调用方的连接/降级语义逐字保留）：
 * 1. **按重试策略共享**（`RedisRetryPolicy`，与原 5 处一一对应）：
 *    - `stop-after-3`：`times > 3 → null`（停止重连，交由调用方降级）
 *      —— checkpointer / write-guard / rate-limiter 三处**同策略 ⇒ 共用同一实例**
 *    - `retry-forever`：`Math.min(times * 500, 5000)`（持续重试，网络恢复后可自愈）
 *      —— memory-manager 独用（其 P2 修复语义：不再放弃重连）
 *    ⚠️ 为什么不是"5 处共用 1 条连接"：这三种重试语义**互斥**（停止重连 vs 持续重试），
 *       强行合并必然改变至少一类调用方的连接语义，触本单红线「不得改变任何模块的
 *       连接/降级语义」。故按策略分池：代码落点 5→1，长连接 4→2（详见回传卡）。
 * 2. **一次性实例**（`createEphemeralClient`）：保持 admin 健康探针
 *    「每次调用新建再销毁、3s 连接超时、不重连」的原语义，仅把创建点收敛到本文件。
 * 3. 全仓 `new Redis(` 只在本文件出现 **1 次**（`private newClient`）。
 * 4. 不新增任何 Redis 依赖；不实现幂等键（属阶段 3 后续单）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { RedisOptions } from 'ioredis';

/** 长连接重试策略（与原 5 处一一对应；调用方按用途选择，语义不可混用） */
export type RedisRetryPolicy = 'stop-after-3' | 'retry-forever';

/** 停止重连时的回调：各调用方借此保留原有降级告警文案（可注册多个） */
export type RedisGiveUpHandler = () => void;

/** 解析后的连接参数（与原 5 处各自读取 .env 的口径一致） */
export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
}

/** 各策略的重试参数（与原实现的数值逐字一致） */
const RETRY_POLICY_PARAMS: Record<
  RedisRetryPolicy,
  { maxAttempts: number; backoffCapMs: number }
> = {
  'stop-after-3': { maxAttempts: 3, backoffCapMs: 2000 },
  'retry-forever': {
    maxAttempts: Number.POSITIVE_INFINITY,
    backoffCapMs: 5000,
  },
};

/** 一次性实例（健康探针）的连接超时默认值（与原实现一致） */
const EPHEMERAL_CONNECT_TIMEOUT_MS = 3000;

@Injectable()
export class RedisProvider {
  private readonly logger = new Logger(RedisProvider.name);
  /** 按策略缓存的共享长连接（同策略全仓唯一） */
  private readonly sharedClients = new Map<RedisRetryPolicy, Redis>();
  /** 各策略已注册的"停止重连"回调 */
  private readonly giveUpHandlers = new Map<
    RedisRetryPolicy,
    Set<RedisGiveUpHandler>
  >();

  constructor(private readonly configService: ConfigService) {}

  /**
   * 共享长连接：同策略复用同一实例；可注册"停止重连"回调（保留调用方原告警文案）
   */
  getSharedClient(
    policy: RedisRetryPolicy,
    onGiveUp?: RedisGiveUpHandler,
  ): Redis {
    if (onGiveUp) {
      const handlers = this.giveUpHandlers.get(policy) ?? new Set();
      handlers.add(onGiveUp);
      this.giveUpHandlers.set(policy, handlers);
    }
    const existing = this.sharedClients.get(policy);
    if (existing) {
      return existing;
    }
    const client = this.newClient({ policy });
    this.sharedClients.set(policy, client);
    return client;
  }

  /**
   * 一次性连接（健康探针专用）：每次调用新建，**调用方负责 disconnect**
   *
   * 保持原语义：3s 连接超时 + `retryStrategy: () => null`（不重连、快速失败）。
   */
  createEphemeralClient(
    connectTimeoutMs: number = EPHEMERAL_CONNECT_TIMEOUT_MS,
  ): Redis {
    return this.newClient({ policy: 'ephemeral', connectTimeoutMs });
  }

  /** 按 .env 解析连接参数（与抽取前 5 处各自的读取口径一致） */
  resolveConnection(): RedisConnectionConfig {
    return {
      host: this.configService.get<string>('REDIS_HOST', '127.0.0.1'),
      port: this.configService.get<number>('REDIS_PORT', 6379),
      password: this.configService.get<string>('REDIS_PASSWORD') || undefined,
      db: this.configService.get<number>('REDIS_DB', 1),
    };
  }

  /**
   * 唯一 `new Redis(` 落点
   *
   * 三型共用同一构造入口 ⇒ 全仓构造点从 5 处收敛为 1 处。
   */
  private newClient(opts: {
    policy: RedisRetryPolicy | 'ephemeral';
    connectTimeoutMs?: number;
  }): Redis {
    const options: RedisOptions = {
      ...this.resolveConnection(),
      // 原 5 处一致：命令在连接未就绪时快速失败（不排队等重连）
      maxRetriesPerRequest: 1,
    };

    if (opts.policy === 'ephemeral') {
      options.connectTimeout = opts.connectTimeoutMs;
      // 健康检查不重连：返回 null 立即停止重试，快速失败
      options.retryStrategy = () => null;
    } else {
      const { maxAttempts, backoffCapMs } = RETRY_POLICY_PARAMS[opts.policy];
      options.retryStrategy = (times: number): number | null => {
        if (times > maxAttempts) {
          this.invokeGiveUpHandlers(opts.policy as RedisRetryPolicy);
          return null;
        }
        return Math.min(times * 500, backoffCapMs);
      };
    }

    return new Redis(options);
  }

  /** 触发该策略下全部"停止重连"回调（各调用方打印原有降级告警） */
  private invokeGiveUpHandlers(policy: RedisRetryPolicy): void {
    const handlers = this.giveUpHandlers.get(policy);
    if (!handlers || handlers.size === 0) {
      this.logger.warn(
        `Redis 重连次数超过 3 次，停止重连（policy=${policy}，无调用方回调）`,
      );
      return;
    }
    for (const handler of handlers) {
      handler();
    }
  }
}
