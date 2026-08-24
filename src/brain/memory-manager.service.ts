/**
 * MemoryManager — 对话记忆管理器
 *
 * 职责：
 * 1. 使用 Redis 存储对话历史（按 tenantId + sessionId 隔离）
 * 2. 保留最近 10 轮对话（20 条消息），超出自动截断
 * 3. TTL 1 小时自动过期，避免无限增长
 * 4. 支持会话清除（用户主动"新对话" / 管理接口）
 * 5. Redis 不可用时降级为无记忆模式（不阻塞业务）
 *
 * Redis Key 格式: ai:memory:{tenantId}:{sessionId}
 * 数据格式: JSON 数组 [ChatMessage, ChatMessage, ...]
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第十二章 12.4/12.5 会话管理
 * - docs/ai-base/智享AI底座-开发文档.md 第八章 8.3 MemoryManager
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { ChatMessage } from '../providers/provider.interface';

/** 保留最近 N 轮对话（1 轮 = 1 条 user + 1 条 assistant） */
const MEMORY_ROUNDS = 10;

/** 每轮 2 条消息，保留 20 条 */
const MAX_MESSAGES = MEMORY_ROUNDS * 2;
/** 单条历史消息最大长度（字符）：工具结果 JSON 可能很大，超长截断防止 prompt 膨胀 */
const MAX_MESSAGE_LENGTH = 800;

/** TTL 1 小时（秒） */
const TTL_SECONDS = 3600;

@Injectable()
export class MemoryManager implements OnModuleInit {
  private readonly logger = new Logger(MemoryManager.name);
  private redis: Redis | null = null;
  private redisAvailable = false;

  constructor(private readonly configService: ConfigService) {}

  /**
   * 初始化 Redis 连接
   *
   * 连接失败不抛异常，降级为无记忆模式。
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
              `Redis 重连次数超过 3 次，降级为无记忆模式（对话历史不会持久化）`,
            );
            return null; // 停止重连
          }
          return Math.min(times * 500, 2000);
        },
        maxRetriesPerRequest: 1,
      });

      // 测试连接
      await this.redis.ping();
      this.redisAvailable = true;
      this.logger.log(
        `Redis 连接成功：${host}:${port} db=${db}（对话记忆服务就绪）`,
      );

      // 监听错误
      this.redis.on('error', (err) => {
        this.logger.warn(`Redis 错误（降级为无记忆模式）：${err.message}`);
        this.redisAvailable = false;
      });

      this.redis.on('reconnecting', () => {
        this.logger.debug('Redis 重连中...');
      });
    } catch (err) {
      this.logger.warn(
        `Redis 连接失败，降级为无记忆模式：${err instanceof Error ? err.message : String(err)}`,
      );
      this.redisAvailable = false;
    }
  }

  /**
   * 生成会话 ID
   *
   * 格式: sess_{timestamp}_{random6}
   */
  generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 加载对话历史
   *
   * @param tenantId 租户 ID
   * @param sessionId 会话 ID
   * @returns 对话消息列表（可能为空数组）
   */
  async loadHistory(
    tenantId: string,
    sessionId: string,
  ): Promise<ChatMessage[]> {
    if (!this.redisAvailable || !this.redis) {
      return [];
    }

    const key = this.buildKey(tenantId, sessionId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) {
        return [];
      }
      const messages = JSON.parse(raw) as ChatMessage[];
      if (!Array.isArray(messages)) {
        this.logger.warn(`对话历史格式异常（非数组），返回空：key=${key}`);
        return [];
      }
      // prompt 减负：单条历史消息超长截断（工具结果 JSON 是大头）
      for (const msg of messages) {
        if (
          typeof msg.content === 'string' &&
          msg.content.length > MAX_MESSAGE_LENGTH
        ) {
          msg.content = `${msg.content.slice(0, MAX_MESSAGE_LENGTH)}…[已截断]`;
        }
      }
      return messages;
    } catch (err) {
      this.logger.warn(
        `加载对话历史失败（降级为空历史）：${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /**
   * 保存对话历史
   *
   * 追加新消息到已有历史，自动截断超出 MAX_MESSAGES 的旧消息，刷新 TTL。
   *
   * @param tenantId 租户 ID
   * @param sessionId 会话 ID
   * @param newMessages 新增的消息列表（user + assistant + 可能的 tool 消息）
   */
  async saveHistory(
    tenantId: string,
    sessionId: string,
    newMessages: ChatMessage[],
  ): Promise<void> {
    if (!this.redisAvailable || !this.redis) {
      return;
    }

    const key = this.buildKey(tenantId, sessionId);
    try {
      // 读取现有历史
      const existing = await this.loadHistory(tenantId, sessionId);
      const combined = [...existing, ...newMessages];

      // 截断：保留最近 MAX_MESSAGES 条
      const truncated =
        combined.length > MAX_MESSAGES
          ? combined.slice(-MAX_MESSAGES)
          : combined;

      // 写入 Redis + 刷新 TTL
      await this.redis.setex(key, TTL_SECONDS, JSON.stringify(truncated));
    } catch (err) {
      this.logger.warn(
        `保存对话历史失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 清除对话历史
   *
   * @param tenantId 租户 ID
   * @param sessionId 会话 ID
   */
  async clearHistory(tenantId: string, sessionId: string): Promise<void> {
    if (!this.redisAvailable || !this.redis) {
      return;
    }

    const key = this.buildKey(tenantId, sessionId);
    try {
      await this.redis.del(key);
      this.logger.debug(
        `对话历史已清除：tenant=${tenantId} session=${sessionId}`,
      );
    } catch (err) {
      this.logger.warn(
        `清除对话历史失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 获取 Redis 是否可用
   */
  isAvailable(): boolean {
    return this.redisAvailable;
  }

  /**
   * 构建 Redis Key
   *
   * 格式: ai:memory:{tenantId}:{sessionId}
   */
  private buildKey(tenantId: string, sessionId: string): string {
    return `ai:memory:${tenantId}:${sessionId}`;
  }
}
