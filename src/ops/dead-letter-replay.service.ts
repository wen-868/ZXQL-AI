/**
 * DeadLetterReplayService — 死信重放队列（Redis Stream 故障缓冲 + 补录）
 *
 * 上游缺口（R101-AI-22 自报备第 1 条）：死信 sink 是尽力而为 —— MySQL 故障窗内产生的
 * 死信只进日志+指标、**事后不补写**。本服务用 Redis Stream 做故障缓冲：
 *
 *   正常路径（MySQL 可用）：sink 直接落 `t_ai_dead_letter`，**不经过 Stream**（行为零变化）
 *   降级路径（MySQL 不可用/超时）：sink 落库失败 ⇒ `XADD` 入队（不丢）
 *   补录（@Cron 定期消费）：`XREADGROUP` → 尝试补写 `t_ai_dead_letter` → 成功 `XACK`
 *
 * 重试边界（**不得无限重试**）：
 * - 每条最多 `DEAD_LETTER_REPLAY_MAX_ATTEMPTS`（默认 5）次；
 * - 退避 `min(2^(n-1) * base, 10min)`（base 默认 30s）：未到点的条目本次跳过；
 * - 超上限 ⇒ **明确终态**：转存到终态流 `ai:dead_letter:replay:terminal`（MAXLEN 截断）
 *   + `logger.error`（含完整记录）+ 计数 ⇒ `XACK` 从待办中摘除，不再重试。
 *   （不新增迁移：不动 `t_ai_dead_letter` 结构；终态可见性由终态流 + 日志 + stats 提供）
 *
 * 连接口径（卡内风险项）：**复用 R101-AI-10 共享 provider**，取 `retry-forever` 池
 * （与 MemoryManager 同池：长连接仍是已收口的 2 个池，**不新建连接**）；
 * 该池「不放弃重连」的语义正适合 ops 侧缓冲——Redis 恢复后缓冲立刻可用。
 *
 * 清理/调度：沿用 R101-AI-17 同款 `@Cron` 命名任务范式（每 5 分钟一次，与 ops 侧粒度一致）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { AiDeadLetterEntity } from '../database/entities/ai-dead-letter.entity';
import { RedisProvider } from '../common/redis.provider';
import type { DeadLetterRecord } from '../common/error-semantics';

/** 重放流（故障缓冲）与终态流 */
export const DEAD_LETTER_REPLAY_STREAM = 'ai:dead_letter:replay';
export const DEAD_LETTER_REPLAY_TERMINAL_STREAM =
  'ai:dead_letter:replay:terminal';
/** 消费组 / 消费者名（同组多实例时 Redis 自动分摊，天然不重复消费） */
export const DEAD_LETTER_REPLAY_GROUP = 'ai-dead-letter-replay';
export const DEAD_LETTER_REPLAY_CONSUMER = 'ai-base-ops';
/** 消费任务（R101-AI-17 同款命名 @Cron 范式；每 5 分钟） */
export const DEAD_LETTER_REPLAY_CRON = '*/5 * * * *';
export const DEAD_LETTER_REPLAY_JOB_NAME = 'dead-letter-replay-consume';
/** 默认边界 */
export const DEAD_LETTER_REPLAY_MAX_ATTEMPTS = 5;
export const DEAD_LETTER_REPLAY_BACKOFF_BASE_MS = 30_000;
export const DEAD_LETTER_REPLAY_BACKOFF_CAP_MS = 10 * 60 * 1000;
export const DEAD_LETTER_REPLAY_BATCH = 100;
export const DEAD_LETTER_REPLAY_STREAM_MAXLEN = 10_000;

/** 重放队列统计（供日志/测试观测） */
export interface DeadLetterReplayStats {
  /** 本轮补录成功条数 */
  replayed: number;
  /** 本轮补录失败条数（留待下次） */
  failed: number;
  /** 本轮因退避未到点跳过条数 */
  deferred: number;
  /** 本轮达上限转终态条数 */
  terminal: number;
  /** 入队成功/失败累计 */
  enqueued: number;
  enqueueFailed: number;
  /** 最近一次读到的积压深度（XLEN；null = 未取到） */
  depth: number | null;
}

@Injectable()
export class DeadLetterReplayService {
  private readonly logger = new Logger(DeadLetterReplayService.name);
  /** entryId → 已尝试次数（进程内；重启后重试预算重置，见类注释） */
  private readonly attempts = new Map<string, number>();
  /** entryId → 下次可尝试时间（退避） */
  private readonly dueAt = new Map<string, number>();
  private readonly stats: DeadLetterReplayStats = {
    replayed: 0,
    failed: 0,
    deferred: 0,
    terminal: 0,
    enqueued: 0,
    enqueueFailed: 0,
    depth: null,
  };

  constructor(
    private readonly configService: ConfigService,
    private readonly redisProvider: RedisProvider,
    @InjectRepository(AiDeadLetterEntity)
    private readonly repo: Repository<AiDeadLetterEntity>,
  ) {}

  /** 统计快照 */
  getStats(): DeadLetterReplayStats {
    return { ...this.stats };
  }

  /**
   * 入队（sink 落库失败时调用）
   *
   * **永不抛**：Redis 不可用时只记 `enqueueFailed` + 限流告警 —— 此时死信仍保留在
   * sink 的日志 + 指标里（与 AI-22 降级行为一致，不因重放队列自身故障而升级故障）。
   */
  async enqueue(record: DeadLetterRecord): Promise<boolean> {
    try {
      const client = this.redisProvider.getSharedClient('retry-forever');
      await client.xadd(
        DEAD_LETTER_REPLAY_STREAM,
        'MAXLEN',
        '~',
        String(
          this.num(
            'DEAD_LETTER_REPLAY_STREAM_MAXLEN',
            DEAD_LETTER_REPLAY_STREAM_MAXLEN,
          ),
        ),
        '*',
        'op',
        record.op,
        'tenantId',
        record.tenantId ?? '',
        'detail',
        record.detail ?? '',
        'error',
        record.error,
        'stack',
        record.stack ?? '',
        'level',
        record.level ?? 'best_effort',
        'at',
        record.at,
        'enqueuedAt',
        new Date().toISOString(),
      );
      this.stats.enqueued += 1;
      this.logger.warn(
        `死信落库失败已转入重放队列（不丢）：op=${record.op} stream=${DEAD_LETTER_REPLAY_STREAM}`,
      );
      return true;
    } catch (err) {
      this.stats.enqueueFailed += 1;
      this.logger.error(
        `死信入重放队列失败（该条仅存日志+指标）：op=${record.op} err=${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return false;
    }
  }

  /** 队列积压深度（XLEN；Redis 不可用返回 null，不抛） */
  async getQueueDepth(): Promise<number | null> {
    try {
      const client = this.redisProvider.getSharedClient('retry-forever');
      const depth = await client.xlen(DEAD_LETTER_REPLAY_STREAM);
      this.stats.depth = depth;
      return depth;
    } catch (err) {
      this.logger.warn(`读取死信队列积压深度失败：${this.messageOf(err)}`);
      return null;
    }
  }

  /**
   * 消费任务（R101-AI-17 同款命名 @Cron；每 5 分钟）
   *
   * **永不抛、不阻塞主流程**：整轮 try/catch，失败只记 error + 指标口径日志。
   */
  @Cron(DEAD_LETTER_REPLAY_CRON, { name: DEAD_LETTER_REPLAY_JOB_NAME })
  async consume(): Promise<DeadLetterReplayStats> {
    const round: DeadLetterReplayStats = {
      replayed: 0,
      failed: 0,
      deferred: 0,
      terminal: 0,
      enqueued: 0,
      enqueueFailed: 0,
      depth: null,
    };
    try {
      const client = this.redisProvider.getSharedClient('retry-forever');
      await this.ensureGroup(client);

      const batch = this.num(
        'DEAD_LETTER_REPLAY_BATCH',
        DEAD_LETTER_REPLAY_BATCH,
      );
      // 先取本消费者待办（PEL，上次失败的），再取新条目
      const pending = this.normalize(
        await client.xreadgroup(
          'GROUP',
          DEAD_LETTER_REPLAY_GROUP,
          DEAD_LETTER_REPLAY_CONSUMER,
          'COUNT',
          batch,
          'STREAMS',
          DEAD_LETTER_REPLAY_STREAM,
          '0',
        ),
      );
      const fresh = this.normalize(
        await client.xreadgroup(
          'GROUP',
          DEAD_LETTER_REPLAY_GROUP,
          DEAD_LETTER_REPLAY_CONSUMER,
          'COUNT',
          batch,
          'STREAMS',
          DEAD_LETTER_REPLAY_STREAM,
          '>',
        ),
      );

      for (const entry of [...pending, ...fresh]) {
        await this.processEntry(client, entry, round);
      }

      round.depth = await client.xlen(DEAD_LETTER_REPLAY_STREAM);
      this.stats.depth = round.depth;
      this.stats.replayed += round.replayed;
      this.stats.failed += round.failed;
      this.stats.deferred += round.deferred;
      this.stats.terminal += round.terminal;

      if (
        round.replayed > 0 ||
        round.failed > 0 ||
        round.terminal > 0 ||
        (round.depth ?? 0) > 0
      ) {
        // 可观测：积压深度（XLEN）随每轮消费落日志
        this.logger.log(
          `死信重放消费：补录 ${round.replayed} 条、失败留待下轮 ${round.failed} 条、退避跳过 ${round.deferred} 条、转终态 ${round.terminal} 条；积压 XLEN=${round.depth}`,
        );
      }
    } catch (err) {
      // 消费自身失败（Redis 不可用等）：不抛、不阻塞，下轮重试
      this.logger.error(
        `死信重放消费失败（不阻塞，下轮重试）：err=${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
    return round;
  }

  // ──────────────────────────────────────────────────────────────
  // 内部实现
  // ──────────────────────────────────────────────────────────────

  /** 懒建消费组（已存在则忽略 BUSYGROUP） */
  private async ensureGroup(client: Redis): Promise<void> {
    try {
      await client.xgroup(
        'CREATE',
        DEAD_LETTER_REPLAY_STREAM,
        DEAD_LETTER_REPLAY_GROUP,
        '$',
        'MKSTREAM',
      );
    } catch (err) {
      if (!this.messageOf(err).includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /** 单条处理：补录成功 ⇒ XACK；失败 ⇒ 计数+退避；超上限 ⇒ 终态流 + XACK */
  private async processEntry(
    client: Redis,
    entry: { id: string; fields: Record<string, string> },
    round: DeadLetterReplayStats,
  ): Promise<void> {
    const attempts = (this.attempts.get(entry.id) ?? 0) + 1;
    const maxAttempts = this.num(
      'DEAD_LETTER_REPLAY_MAX_ATTEMPTS',
      DEAD_LETTER_REPLAY_MAX_ATTEMPTS,
    );

    if (attempts > maxAttempts) {
      // 明确终态：转终态流（可人工处理）+ error 日志（含完整记录）+ 计数，然后摘除
      try {
        await client.xadd(
          DEAD_LETTER_REPLAY_TERMINAL_STREAM,
          'MAXLEN',
          '~',
          '1000',
          '*',
          ...Object.entries(entry.fields).flat(),
          'attempts',
          String(maxAttempts),
          'terminalAt',
          new Date().toISOString(),
        );
      } catch (err) {
        this.logger.error(
          `死信转终态失败（仍从重放队列摘除，记录见日志）：id=${entry.id} err=${this.messageOf(err)}`,
        );
      }
      await this.safeAck(client, entry.id);
      this.attempts.delete(entry.id);
      this.dueAt.delete(entry.id);
      round.terminal += 1;
      this.logger.error(
        `死信补录超过最大重试次数（${maxAttempts}），已转终态流 ${DEAD_LETTER_REPLAY_TERMINAL_STREAM}：id=${entry.id} op=${entry.fields.op ?? '-'} error=${entry.fields.error ?? '-'}`,
      );
      return;
    }

    const due = this.dueAt.get(entry.id) ?? 0;
    if (Date.now() < due) {
      round.deferred += 1; // 退避未到点：保留在 PEL，下轮再试
      return;
    }

    try {
      await this.repo.insert({
        op: entry.fields.op ?? 'unknown',
        tenantId: entry.fields.tenantId ? entry.fields.tenantId : null,
        detail: entry.fields.detail ? entry.fields.detail : null,
        error: entry.fields.error ?? '',
        stack: entry.fields.stack ? entry.fields.stack : null,
        level: entry.fields.level ?? 'best_effort',
        at: this.parseAt(entry.fields.at),
        createdAt: new Date(),
      });
      await this.safeAck(client, entry.id);
      this.attempts.delete(entry.id);
      this.dueAt.delete(entry.id);
      round.replayed += 1;
    } catch (err) {
      this.attempts.set(entry.id, attempts);
      this.dueAt.set(entry.id, Date.now() + this.backoffMs(attempts));
      round.failed += 1;
      this.logger.warn(
        `死信补录失败（第 ${attempts}/${maxAttempts} 次，退避 ${this.backoffMs(attempts)}ms 后重试）：id=${entry.id} op=${entry.fields.op ?? '-'} err=${this.messageOf(err)}`,
      );
    }
  }

  /** XACK 失败不阻断（下轮仍会因已落库而重复，但 insert 幂等性由调用方兜底；此处只记 warn） */
  private async safeAck(client: Redis, id: string): Promise<void> {
    try {
      await client.xack(
        DEAD_LETTER_REPLAY_STREAM,
        DEAD_LETTER_REPLAY_GROUP,
        id,
      );
    } catch (err) {
      this.logger.warn(
        `死信 XACK 失败（下轮可能重复处理）：id=${id} err=${this.messageOf(err)}`,
      );
    }
  }

  /** 退避：min(2^(n-1) * base, cap) */
  private backoffMs(attempts: number): number {
    const base = this.num(
      'DEAD_LETTER_REPLAY_BACKOFF_BASE_MS',
      DEAD_LETTER_REPLAY_BACKOFF_BASE_MS,
    );
    const cap = this.num(
      'DEAD_LETTER_REPLAY_BACKOFF_CAP_MS',
      DEAD_LETTER_REPLAY_BACKOFF_CAP_MS,
    );
    return Math.min(base * Math.pow(2, Math.max(0, attempts - 1)), cap);
  }

  /** XREADGROUP 返回值归一化（[[stream, [[id, [f, v, ...]], ...]]]） */
  private normalize(
    raw: unknown,
  ): Array<{ id: string; fields: Record<string, string> }> {
    const out: Array<{ id: string; fields: Record<string, string> }> = [];
    if (!Array.isArray(raw)) {
      return out;
    }
    for (const streamPart of raw as Array<
      [string, Array<[string, string[]]>]
    >) {
      const entries = Array.isArray(streamPart?.[1]) ? streamPart[1] : [];
      for (const [id, flat] of entries) {
        out.push({ id, fields: this.toFields(flat) });
      }
    }
    return out;
  }

  private toFields(flat: string[]): Record<string, string> {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < flat.length; i += 2) {
      fields[flat[i]] = flat[i + 1];
    }
    return fields;
  }

  /** `at`（ISO8601）→ Date；非法值回落当前时间 */
  private parseAt(raw: string | undefined): Date {
    const parsed = new Date(raw ?? '');
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  private num(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key, fallback);
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
