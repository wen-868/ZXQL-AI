/**
 * RateLimiterService — 令牌桶限流服务
 *
 * 职责：
 * 1. 按租户维度限流（默认 60 次/分钟，可通过 RATE_LIMIT_PER_MINUTE 环境变量调整）
 * 2. Redis 计数（ioredis + Lua 脚本原子操作），Redis 不可用时降级为进程内内存令牌桶
 * 3. 供 RateLimiterMiddleware 调用，超限由中间件返回 HTTP 429
 *
 * 令牌桶算法：
 * - 桶容量 capacity = 每分钟限额（可突发）
 * - 补充速率 refillPerMs = 每分钟限额 / 60000（按毫秒补充）
 * - 每次请求消耗 1 个令牌，令牌不足则拒绝
 *
 * Redis Key 格式（PX 120s 自动过期，避免空闲租户 key 无限积累）：
 * - ai:rl:{key}:tokens — 当前令牌数
 * - ai:rl:{key}:ts     — 上次补充时间戳
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.2 安全设计（限流）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/** 限流窗口（毫秒）= 1 分钟 */
const WINDOW_MS = 60_000;

/** Redis Key 过期时间（毫秒）：空闲 2 分钟后桶自动清理 */
const KEY_TTL_MS = 120_000;

/** 内存桶清理阈值：超过该数量触发一次过期清理 */
const DEFAULT_CLEANUP_THRESHOLD = 10_000;

/**
 * Lua 脚本 — 原子化令牌桶消耗
 *
 * KEYS[1]: 令牌数字符串
 * KEYS[2]: 上次补充时间戳字符串
 * ARGV[1]: 当前时间戳（毫秒）
 * ARGV[2]: 桶容量
 * ARGV[3]: 每毫秒补充速率
 * ARGV[4]: 本次请求消耗令牌数
 *
 * 返回: [allowed(0/1), remaining(剩余令牌数)]
 */
const RATE_LIMITER_LUA = `
local tokens_key = KEYS[1]
local ts_key = KEYS[2]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill_per_ms = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])

local tokens = tonumber(redis.call('GET', tokens_key))
local ts = tonumber(redis.call('GET', ts_key))
if tokens == nil then tokens = capacity end
if ts == nil then ts = now end

local delta = (now - ts) * refill_per_ms
if delta < 0 then delta = 0 end
tokens = tokens + delta
if tokens > capacity then tokens = capacity end

local allowed = 0
if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
end

redis.call('SET', tokens_key, tokens, 'PX', tonumber(ARGV[5]))
redis.call('SET', ts_key, now, 'PX', tonumber(ARGV[5]))
return { allowed, math.floor(tokens) }
`;

/** 限流判定结果 */
export interface RateLimitResult {
  /** 是否放行 */
  allowed: boolean;
  /** 剩余令牌数 */
  remaining: number;
}

/** 内存令牌桶条目 */
interface MemoryBucket {
  tokens: number;
  lastRefillMs: number;
}

@Injectable()
export class RateLimiterService implements OnModuleInit {
  private readonly logger = new Logger(RateLimiterService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;

  /** 桶容量（= 每分钟限额） */
  readonly capacity: number;
  /** 每毫秒补充速率 */
  readonly refillPerMs: number;
  /** 限流窗口（毫秒） */
  readonly windowMs: number = WINDOW_MS;
  /** 内存桶清理阈值（公开可变：测试可注入小值触发清理分支） */
  cleanupThreshold: number = DEFAULT_CLEANUP_THRESHOLD;

  /** 内存令牌桶（Redis 不可用时的降级实现） */
  private readonly memoryBuckets = new Map<string, MemoryBucket>();

  constructor(private readonly configService: ConfigService) {
    const ratePerMinute = this.configService.get<number>(
      'RATE_LIMIT_PER_MINUTE',
      60,
    );
    this.capacity = Math.max(1, ratePerMinute);
    this.refillPerMs = this.capacity / WINDOW_MS;
  }

  /**
   * 初始化 Redis 连接（失败降级为内存令牌桶，不抛异常）
   */
  async onModuleInit(): Promise<void> {
    const host = this.configService.get<string>('REDIS_HOST', '127.0.0.1');
    const port = this.configService.get<number>('REDIS_PORT', 6379);
    const password =
      this.configService.get<string>('REDIS_PASSWORD') || undefined;
    const db = this.configService.get<number>('REDIS_DB', 1);

    try {
      this.redis = new Redis({
        host,
        port,
        password,
        db,
        retryStrategy: (times) => {
          if (times > 3) {
            this.logger.warn(
              'Redis 重连次数超过 3 次，降级为内存令牌桶（限流计数不跨实例共享）',
            );
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        maxRetriesPerRequest: 1,
      });

      // 先注册错误监听，避免 ping 失败后 error 事件无人处理
      this.redis.on('error', (err: Error) => {
        this.logger.warn(`Redis 限流错误（降级内存令牌桶）：${err.message}`);
        this.redisAvailable = false;
      });

      await this.redis.ping();
      this.redisAvailable = true;
      this.logger.log(
        `Redis 限流计数连接成功：${host}:${port} db=${db}（每租户 ${this.capacity} 次/分钟）`,
      );
    } catch (err) {
      this.logger.warn(
        `Redis 限流连接失败，降级内存令牌桶：${err instanceof Error ? err.message : String(err)}`,
      );
      this.redisAvailable = false;
    }
  }

  /**
   * 消耗令牌
   *
   * @param key 限流维度标识（如 tenant:{tenantId} / ip:{ip}）
   * @param tokens 本次消耗的令牌数（默认 1）
   * @returns 是否放行 + 剩余令牌数
   */
  async consume(key: string, tokens = 1): Promise<RateLimitResult> {
    if (this.redisAvailable && this.redis) {
      try {
        const result = (await this.redis.eval(
          RATE_LIMITER_LUA,
          2,
          this.buildKey(key, 'tokens'),
          this.buildKey(key, 'ts'),
          Date.now(),
          this.capacity,
          this.refillPerMs,
          tokens,
          KEY_TTL_MS,
        )) as [number, number];

        return { allowed: result[0] === 1, remaining: result[1] };
      } catch (err) {
        this.logger.warn(
          `Redis 限流执行失败，本次降级内存令牌桶：${err instanceof Error ? err.message : String(err)}`,
        );
        this.redisAvailable = false;
      }
    }

    return this.consumeMemory(key, tokens);
  }

  /**
   * 内存令牌桶实现（Redis 不可用时的降级路径）
   */
  private consumeMemory(key: string, tokens: number): RateLimitResult {
    const now = Date.now();

    // 惰性清理：桶数量超阈值时清理过期条目，防止无限增长
    if (this.memoryBuckets.size >= this.cleanupThreshold) {
      this.cleanupStaleBuckets(now);
    }

    const bucket = this.memoryBuckets.get(key);
    const tokensNow = bucket ? bucket.tokens : this.capacity;
    const lastRefill = bucket ? bucket.lastRefillMs : now;

    const delta = Math.max(0, now - lastRefill) * this.refillPerMs;
    const refilled = Math.min(this.capacity, tokensNow + delta);

    const allowed = refilled >= tokens;
    const nextTokens = refilled - (allowed ? tokens : 0);

    this.memoryBuckets.set(key, {
      tokens: nextTokens,
      lastRefillMs: now,
    });

    return { allowed, remaining: Math.floor(nextTokens) };
  }

  /**
   * 清理超过窗口期未访问的桶条目
   */
  private cleanupStaleBuckets(now: number): void {
    const staleBefore = now - this.windowMs;
    for (const [key, bucket] of this.memoryBuckets) {
      if (bucket.lastRefillMs < staleBefore) {
        this.memoryBuckets.delete(key);
      }
    }
  }

  /**
   * 构建 Redis Key
   */
  private buildKey(key: string, part: 'tokens' | 'ts'): string {
    return `ai:rl:${key}:${part}`;
  }
}
