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
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import type { ChatMessage } from '../providers/provider.interface';
import { AiSessionArchiveEntity } from '../database/entities/ai-session-archive.entity';

/** 保留最近 N 轮对话（1 轮 = 1 条 user + 1 条 assistant） */
const MEMORY_ROUNDS = 10;

/** 每轮 2 条消息，保留 20 条 */
const MAX_MESSAGES = MEMORY_ROUNDS * 2;
/** 单条历史消息最大长度（字符）：工具结果 JSON 可能很大，超长截断防止 prompt 膨胀 */
const MAX_MESSAGE_LENGTH = 800;

/** TTL 1 小时（秒） */
const TTL_SECONDS = 3600;

/**
 * saveHistory 乐观锁冲突重试上限（P2 2026-10-06）
 *
 * 同会话并发写入时 WATCH 会检测到冲突并整次重试；3 次足以覆盖
 * "用户连发 2~3 轮"的真实并发，超限则按最后一次快照写入并 warn。
 */
const WATCH_CONFLICT_MAX_RETRIES = 3;

@Injectable()
export class MemoryManager implements OnModuleInit {
  private readonly logger = new Logger(MemoryManager.name);
  private redis: Redis | null = null;
  private redisAvailable = false;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(AiSessionArchiveEntity)
    private readonly archiveRepo: Repository<AiSessionArchiveEntity>,
  ) {}

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
        // P2 修复（2026-10-04）：不再放弃重连——此前 3 次失败即永久停摆，
        // 网络恢复后记忆静默失效直到进程重启；指数退避封顶 5s 持续重试
        retryStrategy: (times) => Math.min(times * 500, 5000),
        maxRetriesPerRequest: 1,
      });

      // 测试连接
      await this.redis.ping();
      this.redisAvailable = true;
      this.logger.log(
        `Redis 连接成功：${host}:${port} db=${db}（对话记忆服务就绪）`,
      );

      this.bindRedisEvents();
    } catch (err) {
      this.logger.warn(
        `Redis 连接失败，降级为无记忆模式：${err instanceof Error ? err.message : String(err)}`,
      );
      this.redisAvailable = false;
    }
  }

  /**
   * 绑定 Redis 连接事件（onModuleInit 内调用；独立成方法便于测试注入桩后直调）
   */
  private bindRedisEvents(): void {
    if (!this.redis) {
      return;
    }
    // 监听错误
    this.redis.on('error', (err: Error) => {
      this.logger.warn(`Redis 错误（降级为无记忆模式）：${err.message}`);
      this.redisAvailable = false;
    });

    this.redis.on('reconnecting', () => {
      this.logger.debug('Redis 重连中...');
    });

    // P2 修复（2026-10-04）：恢复钩子——error 置 false 后必须在 ready 时
    // 置回 true，否则一次网络抖动后记忆永久失效（即使 ioredis 已重连成功）
    this.redis.on('ready', () => {
      if (!this.redisAvailable) {
        this.logger.log('Redis 连接恢复，记忆服务重新可用');
      }
      this.redisAvailable = true;
    });
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
    customerId?: string,
  ): Promise<ChatMessage[]> {
    if (!this.redisAvailable || !this.redis) {
      return [];
    }

    const key = this.buildKey(tenantId, sessionId, customerId);
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
    customerId?: string,
  ): Promise<void> {
    if (!this.redisAvailable || !this.redis) {
      return;
    }

    const key = this.buildKey(tenantId, sessionId, customerId);
    // P2 修复（2026-10-06）：乐观锁 WATCH/MULTI/EXEC 消除读改写竞态——
    // 此前 get → 拼 → setex 三步分离，同会话并发请求（用户快速连发、
    // 或前端重试）后写覆盖前写，整轮对话丢失。
    // WATCH 在 EXEC 前检测到 key 被他人改动则整次重试；重试上限
    // WATCH_CONFLICT_MAX_RETRIES，超限则按最后一次读到的快照写入
    // （降级：可能丢最新一轮，但绝不抛错打断对话）。
    for (let attempt = 0; attempt <= WATCH_CONFLICT_MAX_RETRIES; attempt++) {
      try {
        await this.redis.watch(key);
        const raw = await this.redis.get(key);
        let existing: ChatMessage[] = [];
        if (raw) {
          try {
            const parsed = JSON.parse(raw) as ChatMessage[];
            existing = Array.isArray(parsed) ? parsed : [];
          } catch {
            this.logger.warn(
              `对话历史格式异常（非数组），按空历史覆盖：key=${key}`,
            );
          }
        }
        const combined = [...existing, ...newMessages];

        // 截断：保留最近 MAX_MESSAGES 条
        const truncated =
          combined.length > MAX_MESSAGES
            ? combined.slice(-MAX_MESSAGES)
            : combined;

        const tx = this.redis
          .multi()
          .setex(key, TTL_SECONDS, JSON.stringify(truncated));
        const res = await tx.exec();
        // exec() 返回 null 表示 WATCH 检测到冲突（key 在 get 与 exec 之间被改）
        if (res === null) {
          continue;
        }
        return;
      } catch (err) {
        this.logger.warn(
          `保存对话历史失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
        );
        this.unwatchQuietly();
        return;
      } finally {
        this.unwatchQuietly();
      }
    }
    this.logger.warn(
      `对话历史并发冲突重试超限（可能丢失最新一轮）：key=${key}`,
    );
  }

  /** 清理 WATCH 状态（失败降级：Redis 不可用时忽略） */
  private unwatchQuietly(): void {
    try {
      // fire-and-forget：清理是尽力而为，不能因失败影响主流程
      void this.redis?.unwatch()?.catch(() => undefined);
    } catch {
      // 忽略
    }
  }

  /**
   * 清除对话历史
   *
   * @param tenantId 租户 ID
   * @param sessionId 会话 ID
   */
  async clearHistory(
    tenantId: string,
    sessionId: string,
    customerId?: string,
  ): Promise<void> {
    if (!this.redisAvailable || !this.redis) {
      return;
    }

    // P2 修复（2026-10-04）：透传 customerId——运营客户端记忆 key 含客户
    // 分区，缺了它 clear 删的是不存在的 key（静默无效）
    const key = this.buildKey(tenantId, sessionId, customerId);
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
   * 会话冷备归档（A4，文档 12.5 L2 冷存储）
   *
   * 会话结束时将完整对话历史写入 t_ai_session_archive（best-effort，
   * 写库失败仅记日志，不影响主流程）。Redis 热记忆仍按 TTL 管理。
   *
   * @param tenantId  租户 ID
   * @param sessionId 会话 ID
   * @param userId    用户 ID（可选）
   * @param messages  完整对话消息
   */
  async archiveSession(
    tenantId: string,
    sessionId: string,
    userId: string | undefined,
    messages: ChatMessage[],
  ): Promise<void> {
    try {
      const safeMessages = messages.slice(-50).map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string' && m.content.length > 4000
            ? `${m.content.slice(0, 4000)}…[截断]`
            : m.content,
      }));
      await this.archiveRepo.save(
        this.archiveRepo.create({
          sessionId,
          tenantId,
          userId: userId ?? null,
          messagesJson: safeMessages as Array<Record<string, unknown>>,
          messageCount: safeMessages.length,
          startedAt: new Date(),
          endedAt: new Date(),
        }),
      );
      this.logger.debug(
        `会话已归档：tenant=${tenantId} session=${sessionId} 消息=${safeMessages.length}`,
      );
    } catch (err) {
      this.logger.warn(
        `会话归档失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
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
   * 格式: ai:memory:{tenantId}[:{customerId}]:{sessionId}（运营客户端追加 customerId，见文档 10.1 第 4 条）
   */
  private buildKey(
    tenantId: string,
    sessionId: string,
    customerId?: string,
  ): string {
    return buildMemoryKey(tenantId, sessionId, customerId);
  }
}

/**
 * 对话记忆 Redis Key（导出供测试与运维排查）
 *
 * - 管理端（staff）：ai:memory:{tenantId}:{sessionId}
 * - 运营客户端（customer）：ai:memory:{tenantId}:{customerId}:{sessionId}（数据边界，见文档 10.1 第 4 条）
 */
export function buildMemoryKey(
  tenantId: string,
  sessionId: string,
  customerId?: string,
): string {
  // P2 修复（2026-10-04）：分段 encodeURIComponent——此前 staff 端传含 ':'
  // 的 sessionId 可与 customer 分区 key 拼出完全相同的字符串（同租户跨端
  // 串记忆）。编码只影响含特殊字符的段（常规 sess_/emp_ 前缀不变），
  // 存量 key TTL 仅 1 小时，切换窗口可忽略。
  const enc = (v: string) => encodeURIComponent(v);
  return customerId
    ? `ai:memory:${enc(tenantId)}:${enc(customerId)}:${enc(sessionId)}`
    : `ai:memory:${enc(tenantId)}:${enc(sessionId)}`;
}
