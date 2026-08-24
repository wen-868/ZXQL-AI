/**
 * CheckpointerService — 图状态持久化（完善度 P0-2）
 *
 * 职责：
 * 1. 按 tenantId+sessionId 持久化图状态（Redis，JSON 序列化）
 * 2. 支持暂停/恢复/续跑：执行中断后从 Checkpoint 恢复
 * 3. TTL 24h 自动过期；Redis 不可用时降级为内存 Map（进程内续跑）
 *
 * Redis Key 格式: ai:graph:{tenantId}:{sessionId}
 *
 * 对应计划：
 * - docs/ai-base/管理系统AI底座完善计划.md P0-2 Checkpointer
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { GraphState } from './graph.types';

/** 图状态 TTL（秒，24h） */
const GRAPH_TTL_SECONDS = 24 * 3600;

@Injectable()
export class CheckpointerService implements OnModuleInit {
  private readonly logger = new Logger(CheckpointerService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;
  /** Redis 不可用时的内存兜底（进程内可续跑） */
  private readonly memoryStore = new Map<string, GraphState>();

  constructor(private readonly configService: ConfigService) {}

  /**
   * 初始化 Redis 连接（失败降级内存，不阻塞启动）
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
              'Redis 重连次数超过 3 次，图状态降级为内存模式（跨进程不可续跑）',
            );
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        maxRetriesPerRequest: 1,
      });
      await this.redis.ping();
      this.redisAvailable = true;
      this.logger.log('Redis 连接成功（图状态 Checkpointer 就绪）');
      this.redis.on('error', (err) => {
        this.logger.debug(`Redis 图状态连接错误：${err.message}`);
      });
    } catch (err) {
      this.redisAvailable = false;
      this.logger.warn(
        `Redis 不可用，图状态降级为内存模式：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** 生成状态 Key */
  private key(tenantId: string, sessionId: string): string {
    return `ai:graph:${tenantId}:${sessionId}`;
  }

  /**
   * 保存图状态
   */
  async save(state: GraphState): Promise<void> {
    state.updatedAt = Date.now();
    if (this.redisAvailable && this.redis) {
      try {
        await this.redis.set(
          this.key(state.tenantId, state.sessionId),
          JSON.stringify(state),
          'EX',
          GRAPH_TTL_SECONDS,
        );
        return;
      } catch (err) {
        this.logger.debug(
          `图状态 Redis 写入失败（降级内存）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.memoryStore.set(this.key(state.tenantId, state.sessionId), state);
  }

  /**
   * 加载图状态（无则返回 null）
   */
  async load(tenantId: string, sessionId: string): Promise<GraphState | null> {
    if (this.redisAvailable && this.redis) {
      try {
        const raw = await this.redis.get(this.key(tenantId, sessionId));
        if (raw) {
          return JSON.parse(raw) as GraphState;
        }
        return null;
      } catch (err) {
        this.logger.debug(
          `图状态 Redis 读取失败（回退内存）：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return this.memoryStore.get(this.key(tenantId, sessionId)) ?? null;
  }

  /**
   * 清除图状态（完成/回滚后调用）
   */
  async clear(tenantId: string, sessionId: string): Promise<void> {
    this.memoryStore.delete(this.key(tenantId, sessionId));
    if (this.redisAvailable && this.redis) {
      try {
        await this.redis.del(this.key(tenantId, sessionId));
      } catch (err) {
        this.logger.debug(
          `图状态 Redis 清除失败：${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }
}
