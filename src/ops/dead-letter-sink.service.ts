/**
 * DeadLetterSinkService — bestEffort 死信的生产落库端（R101-AI-22）
 *
 * 上游缺陷（R101-AI-21 自报备第 1 条）：`setDefaultDeadLetterSink` 全仓无生产注册
 * ⇒ bestEffort 失败只进日志 + 指标（`error-semantics.ts:228` 打「无死信接收方」），
 * 死信无法复盘、无法重放。本服务在启动阶段注册 sink，把死信写入 `t_ai_dead_letter`（017）。
 *
 * ⚠️ 本单最关键的难点：**循环依赖**
 *   死信落库依赖 MySQL，而最需要死信的 fail-open 场景恰恰是 MySQL 不可用。
 *   显式处理（三条硬约束，均有测试）：
 *   1. **不抛**：sink 内部吞掉所有异常 ⇒ 不触发 bestEffort 的二次错误日志（不递归、不刷屏）
 *   2. **不重试**：单次尝试，失败即放弃（不做退避重试，避免故障期自我放大）
 *   3. **不阻塞**：写库带上限等待（默认 `DEAD_LETTER_WRITE_TIMEOUT_MS=1000`ms），
 *      超时即放弃并计数 ⇒ MySQL 挂掉时 sink 最多拖慢 1s，且不 reject（无 unhandledRejection）
 *   4. **不刷屏**：失败静默计数；仅首条 + 每 100 条 + 60s 限流各 warn 一次
 *   ⇒ MySQL 不可用时死信**降级为日志 + 指标**（`ai_error_semantics_total{level="best_effort"}`），
 *     主流程不受影响；AI-21 幂等闸门的 fail-open 行为保持不变。
 *
 * 清理：沿用 R101-AI-17 同款 `@Cron` 命名任务（每日 03:00，分批 DELETE，保留 30 天，与 016 对齐）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AiDeadLetterEntity } from '../database/entities/ai-dead-letter.entity';
import {
  DeadLetterRecord,
  setDefaultDeadLetterSink,
} from '../common/error-semantics';

import { DeadLetterReplayService } from './dead-letter-replay.service';

/** 清理任务（每日 03:00；与 016 t_ai_idempotency 同款 @Cron 命名任务范式） */
export const DEAD_LETTER_CLEANUP_CRON = '0 3 * * *';
export const DEAD_LETTER_CLEANUP_JOB_NAME = 'dead-letter-cleanup-expired';
/** 保留期（天）：与 016 对齐，覆盖故障复盘/对账窗口 */
export const DEAD_LETTER_RETENTION_DAYS = 30;
/** 写库上限等待（毫秒）：MySQL 不可用时 sink 的最坏附加耗时 */
export const DEAD_LETTER_WRITE_TIMEOUT_MS = 1000;
/** 失败告警限流窗口（毫秒） */
export const DEAD_LETTER_WARN_THROTTLE_MS = 60_000;
/** 清理批量大小与循环上限 */
const CLEANUP_BATCH = 5000;
const CLEANUP_MAX_LOOPS = 200;

/** sink 运行统计（供运维/测试观测；不落库） */
export interface DeadLetterSinkStats {
  /** 成功落库条数 */
  persisted: number;
  /** 落库失败条数（含超时） */
  failed: number;
  /** 连续失败条数（成功后归零） */
  consecutiveFailures: number;
  /** 最近一次失败时间（ISO8601） */
  lastErrorAt: string | null;
}

@Injectable()
export class DeadLetterSinkService implements OnModuleInit {
  private readonly logger = new Logger(DeadLetterSinkService.name);
  private registered = false;
  private lastWarnAt = 0;
  private readonly stats: DeadLetterSinkStats = {
    persisted: 0,
    failed: 0,
    consecutiveFailures: 0,
    lastErrorAt: null,
  };

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(AiDeadLetterEntity)
    private readonly repo: Repository<AiDeadLetterEntity>,
    private readonly dataSource: DataSource,
    // R101-AI-23：落库失败时的故障缓冲（Redis Stream 重放队列）；正常路径不经过它
    private readonly replayQueue: DeadLetterReplayService,
  ) {}

  /**
   * 生产注册点：启动阶段注册全局死信接收方
   *
   * **注册失败不得阻断启动**：捕获所有异常并落 error 日志（此时死信回落为
   * 「日志 + 指标」，与注册前行为一致，不影响任何业务链路）。
   */
  onModuleInit(): void {
    try {
      setDefaultDeadLetterSink(this.sink);
      this.registered = true;
      this.logger.log(
        `死信接收方已注册（sink → t_ai_dead_letter；写超时 ${this.num(
          'DEAD_LETTER_WRITE_TIMEOUT_MS',
          DEAD_LETTER_WRITE_TIMEOUT_MS,
        )}ms，保留 ${this.num('DEAD_LETTER_RETENTION_DAYS', DEAD_LETTER_RETENTION_DAYS)} 天）`,
      );
    } catch (err) {
      this.registered = false;
      this.logger.error(
        `死信接收方注册失败（不阻断启动；死信回落为日志+指标）：${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /** 是否已注册（供运维/测试断言） */
  isRegistered(): boolean {
    return this.registered;
  }

  /** 运行统计快照 */
  getStats(): DeadLetterSinkStats {
    return { ...this.stats };
  }

  /**
   * 全局死信 sink（箭头属性：可直接传入 `setDefaultDeadLetterSink`，this 绑定稳定）
   *
   * 语义要点：**永不抛异常、永不重试、永不递归**；失败只计数 + 限流 warn。
   */
  sink = async (record: DeadLetterRecord): Promise<void> => {
    const result = await this.insertWithDeadline({
      op: record.op,
      tenantId: record.tenantId ?? null,
      detail: record.detail ?? null,
      error: record.error,
      stack: record.stack ?? null,
      level: record.level ?? 'best_effort',
      at: this.parseAt(record.at),
      createdAt: new Date(),
    });

    if (result.ok) {
      this.stats.persisted += 1;
      this.stats.consecutiveFailures = 0;
      return;
    }

    // sink 自身失败：静默计数 + 限流 warn（不抛 ⇒ bestEffort 不会二次报错刷屏；不重试）
    this.stats.failed += 1;
    this.stats.consecutiveFailures += 1;
    this.stats.lastErrorAt = new Date().toISOString();
    this.maybeWarn(record.op, result.err);
    // R101-AI-23：落库失败 ⇒ 先把死信塞进 Redis Stream 重放队列（不丢）；
    // enqueue 自身永不抛（Redis 也挂时只记日志+计数，与 AI-22 降级行为一致）
    await this.replayQueue.enqueue(record);
  };

  /**
   * 定时清理（复用 R101-AI-17 的 @Cron 范式：命名任务 + 每日一次 + 分批 DELETE）
   *
   * 保留 30 天（与 016 对齐）：覆盖故障复盘/对账窗口；走 idx_dead_letter_created_at。
   */
  @Cron(DEAD_LETTER_CLEANUP_CRON, { name: DEAD_LETTER_CLEANUP_JOB_NAME })
  async cleanupExpired(): Promise<{ deleted: number }> {
    let deleted = 0;
    try {
      const cutoff = new Date(
        Date.now() -
          this.num('DEAD_LETTER_RETENTION_DAYS', DEAD_LETTER_RETENTION_DAYS) *
            24 *
            60 *
            60 *
            1000,
      );
      for (let i = 0; i < CLEANUP_MAX_LOOPS; i++) {
        // dataSource.query 返回 any（驱动 ResultSetHeader）⇒ 显式收窄
        const raw = (await this.dataSource.query(
          'DELETE FROM t_ai_dead_letter WHERE created_at < ? LIMIT ?',
          [cutoff, CLEANUP_BATCH],
        )) as unknown;
        const affected =
          (raw as { affectedRows?: number } | null)?.affectedRows ?? 0;
        deleted += affected;
        if (affected < CLEANUP_BATCH) {
          break;
        }
      }
      if (deleted > 0) {
        this.logger.log(
          `死信表清理完成：删除过期 ${deleted} 条（保留 ${this.num(
            'DEAD_LETTER_RETENTION_DAYS',
            DEAD_LETTER_RETENTION_DAYS,
          )} 天）`,
        );
      }
    } catch (err) {
      // 清理失败不阻断调度（MySQL 不可用时静默跳过，下个周期再试）
      this.logger.error(
        `死信表清理失败（不阻断调度）：${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
    return { deleted };
  }

  // ──────────────────────────────────────────────────────────────
  // 内部实现
  // ──────────────────────────────────────────────────────────────

  /**
   * 带上限等待的落库
   *
   * - 返回 `{ok:false}` 而非抛异常 ⇒ 不产生 unhandledRejection
   * - 内置超时 ⇒ MySQL 不可用时最多等待 `DEAD_LETTER_WRITE_TIMEOUT_MS`，
   *   超时即放弃（不重试），主流程不被无限拖住
   */
  private async insertWithDeadline(
    entity: Partial<AiDeadLetterEntity>,
  ): Promise<{ ok: true } | { ok: false; err: unknown }> {
    const timeoutMs = this.num(
      'DEAD_LETTER_WRITE_TIMEOUT_MS',
      DEAD_LETTER_WRITE_TIMEOUT_MS,
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout$ = new Promise<{ ok: false; err: unknown }>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          ok: false,
          err: new Error(
            `死信落库超时（>${timeoutMs}ms）：已放弃本次落库（不重试、不阻塞主流程）`,
          ),
        });
      }, timeoutMs);
      // 不让待触发的定时器拖住进程退出（测试/优雅停机友好）
      timer.unref?.();
    });
    const insert$ = this.repo
      .insert(entity)
      .then(() => ({ ok: true as const }))
      .catch((err: unknown) => ({ ok: false as const, err }));

    try {
      return await Promise.race([insert$, timeout$]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** 失败告警限流：首条 + 每 100 条 + 60s 一次（其余静默计数，绝不刷屏） */
  private maybeWarn(op: string, err: unknown): void {
    const now = Date.now();
    const throttleMs = this.num(
      'DEAD_LETTER_WARN_THROTTLE_MS',
      DEAD_LETTER_WARN_THROTTLE_MS,
    );
    const shouldWarn =
      this.stats.failed === 1 ||
      this.stats.failed % 100 === 0 ||
      now - this.lastWarnAt >= throttleMs;
    if (!shouldWarn) {
      return;
    }
    this.lastWarnAt = now;
    this.logger.warn(
      `死信落库失败（已降级为日志+指标；不重试、不阻塞；累计失败 ${this.stats.failed} 条、连续 ${this.stats.consecutiveFailures} 条）：op=${op} err=${this.messageOf(err)}`,
    );
  }

  /** `record.at`（ISO8601）→ Date；非法值回落为当前时间（不因脏数据丢记录） */
  private parseAt(raw: string): Date {
    const parsed = new Date(raw);
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
