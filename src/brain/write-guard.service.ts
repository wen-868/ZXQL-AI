/**
 * WriteGuardService — 写全审核令牌服务（P0-1）
 *
 * 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 23 章 WriteGuard 令牌机制
 * 原则：读全自动、写全审核、令牌确认。
 *
 * 核心职责：
 * 1. 写操作挂起时生成唯一 token（Redis 存储，24h TTL），返回 pendingWrite（docType/risk/summary）
 * 2. 令牌确认/取消：租户隔离 + 状态机（pending → first_confirmed → confirmed / cancelled / expired）
 * 3. 高危写（risk=high / needsReview）二次确认：首次确认进入 first_confirmed，二次确认才真正放行
 * 4. Redis 不可用时降级内存 Map（与 MemoryManager 同模式），保证单测与降级场景可用
 * 5. 全轨迹审计：挂起/首次确认/确认/取消/过期均写入 t_ai_audit_log（token 脱敏后入库）
 *
 * Redis Key 格式：
 * - 记录：ai:writeguard:{tenantId}:{token}（value = PendingWrite JSON，TTL 24h）
 * - 租户索引：ai:writeguard:idx:{tenantId}（Set[token]，供 listPending 按租户列出）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import type { ToolResult, ToolRisk } from '../tools/tool.interface';
import { AuditLogger } from '../bridge/audit-logger';

/** WriteGuard 状态机 */
export type WriteGuardStatus =
  | 'pending' // 待确认（预览已生成，等待用户确认）
  | 'first_confirmed' // 首次确认（高危写，等待二次确认）
  | 'confirmed' // 已确认（可执行）
  | 'cancelled' // 已取消
  | 'expired'; // 已过期

/** 待确认写操作记录（pendingWrite） */
export interface PendingWrite {
  /** 唯一令牌（confirmationId 兼容：前端确认卡沿用同一标识） */
  token: string;
  /** 租户 ID（多租户隔离） */
  tenantId: string;
  /** 会话 ID（可选） */
  conversationId?: string;
  /** 自主任务计划 ID（可选；批次2 Agent 内核写步骤挂起） */
  planId?: number;
  /** 计划步骤 ID（可选；批次2 Agent 内核写步骤挂起） */
  planStepId?: string;
  /** 待执行工具名称 */
  toolName: string;
  /** 文档类型（写入业务对象，如 sales_order_create；P0-2 由 WriteSchemaRegistry 统一定义） */
  docType: string;
  /** 风险分级（low/medium/high） */
  risk: ToolRisk;
  /** 是否强制人工审核（risk=high 或工具显式 needsReview） */
  needsReview: boolean;
  /** 工具参数（confirm 未置 true 的预览参数） */
  args: Record<string, unknown>;
  /** 预览卡片数据（操作名/摘要/结构化明细） */
  preview?: ToolResult['preview'];
  /** 操作名称（如"创建销售单"，供确认卡展示） */
  operationLabel: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 过期时间戳（创建 + 24h TTL） */
  expiresAt: number;
  /** 状态 */
  status: WriteGuardStatus;
  /** 已确认次数（高危写二次确认计数） */
  confirmCount: number;
}

/** 挂起写操作的输入 */
export interface SuspendWriteInput {
  tenantId: string;
  conversationId?: string;
  planId?: number;
  planStepId?: string;
  toolName: string;
  docType: string;
  risk: ToolRisk;
  needsReview: boolean;
  args: Record<string, unknown>;
  preview?: ToolResult['preview'];
  operationLabel: string;
}

/** 确认结果 */
export interface WriteGuardConfirmResult {
  success: boolean;
  pendingWrite?: PendingWrite;
  /** true = 高危写首次确认，需二次确认 */
  needsSecondConfirm?: boolean;
  error?: string;
}

/** 写操作令牌 TTL：24 小时（毫秒） */
export const WRITE_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Redis Key 前缀 */
const WG_KEY_PREFIX = 'ai:writeguard';
const WG_INDEX_PREFIX = 'ai:writeguard:idx';

@Injectable()
export class WriteGuardService {
  private readonly logger = new Logger(WriteGuardService.name);
  private redis: Redis | null = null;
  private redisAvailable = false;

  /** 内存降级存储：`tenantId:token` → PendingWrite */
  private readonly memoryMap = new Map<string, PendingWrite>();
  /** 内存降级租户索引：tenantId → Set<token> */
  private readonly memoryIndex = new Map<string, Set<string>>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly auditLogger?: AuditLogger,
  ) {}

  /**
   * 初始化 Redis 连接（与 MemoryManager 同模式）
   *
   * 连接失败不抛异常，降级为内存模式（令牌 24h TTL 由进程内 Map 承担）。
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
              'Redis 重连次数超过 3 次，降级为内存模式（写审核令牌不跨进程持久）',
            );
            return null;
          }
          return Math.min(times * 500, 2000);
        },
        maxRetriesPerRequest: 1,
      });

      await this.redis.ping();
      this.redisAvailable = true;
      this.logger.log(
        `Redis 连接成功：${host}:${port} db=${db}（WriteGuard 令牌服务就绪）`,
      );

      this.redis.on('error', (err) => {
        this.logger.warn(`Redis 错误（降级为内存模式）：${err.message}`);
        this.redisAvailable = false;
      });

      this.redis.on('reconnecting', () => {
        this.logger.debug('Redis 重连中...');
      });
    } catch (err) {
      this.logger.warn(
        `Redis 连接失败，降级为内存模式：${err instanceof Error ? err.message : String(err)}`,
      );
      this.redisAvailable = false;
    }
  }

  /**
   * 挂起写操作：生成 token 并保存 pendingWrite
   *
   * @param input 挂起输入（含 docType/risk/needsReview）
   * @returns pendingWrite（token 即 confirmationId）
   */
  async suspend(input: SuspendWriteInput): Promise<PendingWrite> {
    const now = Date.now();
    const write: PendingWrite = {
      token: `wg_${randomUUID()}`,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      planId: input.planId,
      planStepId: input.planStepId,
      toolName: input.toolName,
      docType: input.docType,
      risk: input.risk,
      needsReview: input.needsReview,
      args: input.args,
      preview: input.preview,
      operationLabel: input.operationLabel,
      createdAt: now,
      expiresAt: now + WRITE_TOKEN_TTL_MS,
      status: 'pending',
      confirmCount: 0,
    };

    await this.save(write);
    this.audit(write, 'pending');
    this.logger.log(
      `写操作挂起：token=${write.token} tenant=${input.tenantId} tool=${input.toolName} risk=${input.risk}（${input.operationLabel}）`,
    );
    return write;
  }

  /**
   * 查询 pendingWrite（惰性过期检查：过期即删除并记审计）
   *
   * @param token    令牌
   * @param tenantId 租户 ID（隔离校验）
   * @returns 记录；不存在或已过期返回 null
   */
  async get(token: string, tenantId: string): Promise<PendingWrite | null> {
    const write = await this.load(token, tenantId);
    if (!write) {
      return null;
    }
    if (Date.now() > write.expiresAt) {
      await this.remove(write);
      this.audit(write, 'expired');
      this.logger.warn(
        `写审核令牌已过期：token=${write.token} tool=${write.toolName}`,
      );
      return null;
    }
    return write;
  }

  /**
   * 列出某租户全部待确认写操作（未过期）
   *
   * @param tenantId 租户 ID
   * @returns pendingWrite 列表（按创建时间倒序）
   */
  async listPending(tenantId: string): Promise<PendingWrite[]> {
    const tokens = await this.listTokens(tenantId);
    const records: PendingWrite[] = [];

    for (const token of tokens) {
      const write = await this.get(token, tenantId);
      if (write) {
        records.push(write);
      }
    }

    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 确认令牌（WriteGuard 状态机）
   *
   * - 非高危（risk=low/medium 且非 needsReview）：pending → confirmed，一次确认即放行
   * - 高危（risk=high 或 needsReview）：pending → first_confirmed（首次确认）→ confirmed（二次确认）
   * - 已取消/已确认/已过期：拒绝（令牌不可复用）
   *
   * @param token    令牌
   * @param tenantId 租户 ID
   * @returns 确认结果（needsSecondConfirm=true 时需二次确认）
   */
  async confirm(
    token: string,
    tenantId: string,
  ): Promise<WriteGuardConfirmResult> {
    const write = await this.get(token, tenantId);
    if (!write) {
      return {
        success: false,
        error: '待确认操作不存在或已过期，请重新发起操作',
      };
    }
    if (write.status === 'cancelled') {
      return { success: false, error: '该操作已取消，无法确认' };
    }
    if (write.status === 'confirmed') {
      return { success: false, error: '该操作已确认执行，请勿重复确认' };
    }

    const highRisk = write.risk === 'high' || write.needsReview;
    if (highRisk && write.status === 'pending') {
      // 首次确认：进入 first_confirmed，等待二次确认
      write.status = 'first_confirmed';
      write.confirmCount = 1;
      await this.save(write);
      this.audit(write, 'first_confirmed');
      this.logger.log(
        `高危写操作首次确认（待二次确认）：token=${token} tool=${write.toolName} risk=${write.risk}`,
      );
      return { success: true, pendingWrite: write, needsSecondConfirm: true };
    }

    // 非高危首次确认（pending → confirmed）或高危二次确认（first_confirmed → confirmed）
    write.status = 'confirmed';
    write.confirmCount += 1;
    await this.save(write);
    this.audit(write, 'confirmed');
    this.logger.log(
      `写操作已确认（${highRisk ? '二次' : '首次'}）：token=${token} tool=${write.toolName} risk=${write.risk}`,
    );
    return { success: true, pendingWrite: write, needsSecondConfirm: false };
  }

  /**
   * 取消令牌（pending / first_confirmed 可取消；已确认不可取消）
   *
   * @param token    令牌
   * @param tenantId 租户 ID
   * @returns 是否取消成功
   */
  async cancel(token: string, tenantId: string): Promise<boolean> {
    const write = await this.get(token, tenantId);
    if (!write) {
      return false;
    }
    if (write.status === 'confirmed') {
      this.logger.warn(
        `已确认的操作不可取消：token=${token} tool=${write.toolName}`,
      );
      return false;
    }

    write.status = 'cancelled';
    await this.remove(write);
    this.audit(write, 'cancelled');
    this.logger.log(
      `写操作已取消：token=${token} tool=${write.toolName}（${write.operationLabel}）`,
    );
    return true;
  }

  /**
   * 清理内存模式下的过期记录（Redis 模式由 TTL 自动过期）
   *
   * @returns 清理数量
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, write] of this.memoryMap) {
      if (now > write.expiresAt) {
        this.memoryMap.delete(key);
        const index = this.memoryIndex.get(write.tenantId);
        if (index) {
          index.delete(write.token);
          if (index.size === 0) {
            this.memoryIndex.delete(write.tenantId);
          }
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`清理过期写审核令牌：${cleaned} 条`);
    }
    return cleaned;
  }

  // ── 存储层（Redis 优先，内存降级）──

  private buildKey(tenantId: string, token: string): string {
    return `${WG_KEY_PREFIX}:${tenantId}:${token}`;
  }

  private buildIndexKey(tenantId: string): string {
    return `${WG_INDEX_PREFIX}:${tenantId}`;
  }

  private async save(write: PendingWrite): Promise<void> {
    if (this.redisAvailable && this.redis) {
      try {
        const ttlSeconds = Math.ceil(WRITE_TOKEN_TTL_MS / 1000);
        await this.redis
          .multi()
          .setex(
            this.buildKey(write.tenantId, write.token),
            ttlSeconds,
            JSON.stringify(write),
          )
          .sadd(this.buildIndexKey(write.tenantId), write.token)
          .exec();
        return;
      } catch (err) {
        this.logger.warn(
          `WriteGuard 写入 Redis 失败（降级内存）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 内存降级
    this.memoryMap.set(`${write.tenantId}:${write.token}`, write);
    const index = this.memoryIndex.get(write.tenantId) ?? new Set<string>();
    index.add(write.token);
    this.memoryIndex.set(write.tenantId, index);
  }

  private async load(
    token: string,
    tenantId: string,
  ): Promise<PendingWrite | null> {
    if (this.redisAvailable && this.redis) {
      try {
        const raw = await this.redis.get(this.buildKey(tenantId, token));
        if (!raw) {
          return null;
        }
        return JSON.parse(raw) as PendingWrite;
      } catch (err) {
        this.logger.warn(
          `WriteGuard 读取 Redis 失败（降级内存）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return this.memoryMap.get(`${tenantId}:${token}`) ?? null;
  }

  private async remove(write: PendingWrite): Promise<void> {
    if (this.redisAvailable && this.redis) {
      try {
        await this.redis
          .multi()
          .del(this.buildKey(write.tenantId, write.token))
          .srem(this.buildIndexKey(write.tenantId), write.token)
          .exec();
        return;
      } catch (err) {
        this.logger.warn(
          `WriteGuard 删除 Redis 失败（降级内存）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.memoryMap.delete(`${write.tenantId}:${write.token}`);
    const index = this.memoryIndex.get(write.tenantId);
    if (index) {
      index.delete(write.token);
      if (index.size === 0) {
        this.memoryIndex.delete(write.tenantId);
      }
    }
  }

  private async listTokens(tenantId: string): Promise<string[]> {
    if (this.redisAvailable && this.redis) {
      try {
        return await this.redis.smembers(this.buildIndexKey(tenantId));
      } catch (err) {
        this.logger.warn(
          `WriteGuard 读取租户索引失败（降级内存）：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return [...(this.memoryIndex.get(tenantId) ?? [])];
  }

  // ── 审计（best-effort，token 脱敏）──

  private audit(
    write: PendingWrite,
    event:
      'pending' | 'first_confirmed' | 'confirmed' | 'cancelled' | 'expired',
  ): void {
    if (!this.auditLogger) {
      return;
    }
    this.auditLogger.logWriteGuardEvent({
      tenantId: write.tenantId,
      sessionId: write.conversationId,
      event,
      token: maskToken(write.token),
      toolName: write.toolName,
      docType: write.docType,
      risk: write.risk,
      needsReview: write.needsReview,
      operationLabel: write.operationLabel,
      summary: write.preview?.summary,
    });
  }
}

/**
 * 令牌脱敏：仅保留前后片段，供审计追溯（完整 token 不入库，防凭证泄露）
 *
 * 示例：wg_xxxxxxxx-xxxx-xxxx → wg_xxxxx…xxxx
 */
export function maskToken(token: string): string {
  if (token.length <= 12) {
    return `${token.slice(0, 4)}…`;
  }
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}
