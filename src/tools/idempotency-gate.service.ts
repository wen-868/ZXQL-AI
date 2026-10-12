/**
 * IdempotencyGateService — 写工具幂等闸门（阶段 3 幂等键，R101-AI-21）
 *
 * 方案：`docs/plans/阶段3-幂等键-方案.md`（R101-AI-20，业主批准 A/B 口径）
 * 插入点：`ToolExecutor.executeToolCall()` 熔断之后、`tool.execute()` 之前；
 *         条件 `tool.isWriteOperation === true && args.confirm === true`（**预览不消耗键**）。
 *
 * 两层结构（严格按方案 §3.1/§3.2）：
 *  1. Redis `SET key 1 NX EX <ttl>` —— 前置快筛；不可用 ⇒ **fail-open**（degrade 口径 + 指标）
 *  2. MySQL `INSERT (status='in_flight')` —— **认领式**最终防线；唯一键是并发仲裁点
 *     冲突 ⇒ 读既有行：succeeded ⇒ **回放 + idempotent_replay 标记**（业主裁定 A）
 *                        in_flight ⇒ 返回「处理中」，不执行
 *                        failed    ⇒ 允许同键重试（重新认领）
 *     MySQL 不可用（非唯一键冲突）⇒ **fail-open**（裁定 B：可用性优先）+ 死信/指标
 *
 * 止血开关：`IDEMPOTENCY_ENABLED`（默认开）；关闭时直通**并落 warn 日志**（不静默）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { createHash } from 'crypto';
import {
  AiIdempotencyEntity,
  IdempotencyKeySource,
} from '../database/entities/ai-idempotency.entity';
import { RedisProvider } from '../common/redis.provider';
import { bestEffort, degrade } from '../common/error-semantics';
import type { ToolContext, ToolResult } from './tool.interface';

/** 确认通道 toolCall.id 前缀（`confirmation.service.ts` 构造 `confirm-<写审核令牌>`） */
export const CONFIRM_TOOLCALL_PREFIX = 'confirm-';

/** 清理任务（30 天批量清理 + 陈旧 in_flight 看护）；每日 03:00，与方案 §4 一致 */
export const IDEMPOTENCY_CLEANUP_CRON = '0 3 * * *';
/** 命名任务（与 R101-AI-17 同款 @Cron 模式；便于 ScheduleRegistry 断言） */
export const IDEMPOTENCY_CLEANUP_JOB_NAME = 'idempotency-cleanup-expired';

/** 幂等键 Redis TTL：令牌/显式键 600s；payload_hash 兜底键 60s（方案 §1.3） */
export const IDEMPOTENCY_REDIS_TTL_SEC = 600;
export const IDEMPOTENCY_PAYLOAD_TTL_SEC = 60;
/** 幂等行保留期（天）与 in_flight 超时看护（毫秒） */
export const IDEMPOTENCY_RETENTION_DAYS = 30;
export const IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS = 10 * 60 * 1000;
/** 清理批量大小与世界循环上限（避免长事务/死循环） */
const CLEANUP_BATCH = 5000;
const CLEANUP_MAX_LOOPS = 200;

/**
 * 显式幂等键规则（**唯一真源**：HTTP DTO 与闸门共用同一正则，避免两处漂移）
 *
 * - 长度 8~128 字符（防止滥用/超长键打爆 Redis 键空间与调用方内存）
 * - 首字符为字母或数字；其余仅允许 `A-Z a-z 0-9 . _ : -`（业务单号常见字符集）
 * - 键最终会 sha256 落库（`idem_key CHAR(64)`），故长度上限是**卫生约束**而非索引约束
 */
export const MAX_EXPLICIT_KEY_LENGTH = 128;
export const MIN_EXPLICIT_KEY_LENGTH = 8;
export const EXPLICIT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

/** 显式键是否合规（R101-AI-24） */
export function isValidExplicitKey(raw: string | undefined): boolean {
  return typeof raw === 'string' && EXPLICIT_KEY_PATTERN.test(raw);
}

/**
 * 参数规范化时剔除的易变/流程字段（顶层）
 *
 * `confirm`/`force` 是流程开关，`requestId`/`sessionId`/`timestamp` 每次调用都不同，
 * 都不应参与业务指纹，否则同一业务操作会被算成不同键（漏防重）。
 */
const VOLATILE_ARG_FIELDS = new Set([
  'confirm',
  'force',
  'idempotencyKey',
  'requestId',
  'sessionId',
  'timestamp',
  'remark',
]);

/** 闸门入参 */
export interface IdempotencyCheckInput {
  toolName: string;
  args: Record<string, unknown>;
  /** LLM 侧 tool_call.id；确认通道为 `confirm-<写审核令牌>`（现成显式键） */
  toolCallId?: string;
  context: ToolContext;
  /** 调用方显式幂等键（优先级最高） */
  explicitKey?: string;
  /**
   * 工具声明的业务幂等字段（可选，声明式；R101-AI-25）
   *
   * 由 `ToolExecutor` 从 `tool.idempotencyKeyFields` 透传 ⇒ 有值时用「业务字段指纹」
   * 替代全量 payload 哈希（key_source='business_key'）；全部缺失 ⇒ 回落 payload 兜底。
   */
  keyFields?: readonly string[];
}

/** 认领句柄（仅"已认领"时非空；回放/处理中/直通均为 null） */
export interface IdempotencyHandle {
  id: string;
  tenantId: string;
  toolName: string;
  idemKey: string;
  keySource: IdempotencyKeySource;
}

/** 闸门决策 */
export type IdempotencyDecision =
  | { decision: 'proceed'; handle: IdempotencyHandle | null }
  | { decision: 'replay'; result: ToolResult; handle: null }
  | { decision: 'in_flight'; result: ToolResult; handle: null }
  | { decision: 'rejected'; result: ToolResult; handle: null };

@Injectable()
export class IdempotencyGateService {
  private readonly logger = new Logger(IdempotencyGateService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly redisProvider: RedisProvider,
    @InjectRepository(AiIdempotencyEntity)
    private readonly repo: Repository<AiIdempotencyEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /** 止血开关（默认开；仅显式 false/0/off/no 视为关闭） */
  isEnabled(): boolean {
    const raw = this.configService.get<string>('IDEMPOTENCY_ENABLED', 'true');
    return !['false', '0', 'off', 'no'].includes(
      String(raw).trim().toLowerCase(),
    );
  }

  /**
   * 闸门主入口（**永不抛异常**：自身异常一律 fail-open，写链路可用性优先）
   */
  async check(input: IdempotencyCheckInput): Promise<IdempotencyDecision> {
    if (!this.isEnabled()) {
      // 关时直通，但必须留痕（验收 #5：关闭路径有日志、不静默）
      this.logger.warn(
        `幂等闸门已关闭（IDEMPOTENCY_ENABLED=false），写工具直通、不落幂等键：tool=${input.toolName} tenant=${input.context.tenantId}`,
      );
      return { decision: 'proceed', handle: null };
    }

    try {
      return await this.runGate(input);
    } catch (err) {
      this.logger.error(
        `幂等闸门自身异常，按裁定 B fail-open 放行：tool=${input.toolName} err=${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      await this.reportFailure(err, 'idem.gate', input);
      return { decision: 'proceed', handle: null };
    }
  }

  /**
   * 首次执行完成后回填幂等行（成功 ⇒ succeeded 可回放；失败 ⇒ failed 允许重试）
   *
   * best-effort：失败只记 error/指标/死信，绝不抛（不阻断已完成的业务写入）。
   */
  async complete(
    handle: IdempotencyHandle | null,
    result: ToolResult,
  ): Promise<void> {
    if (!handle) {
      return;
    }
    await bestEffort(
      async () => {
        await this.repo.update(
          { id: handle.id },
          {
            status: result.success ? 'succeeded' : 'failed',
            resultJson: result.success ? JSON.stringify(result) : null,
            errorText: result.success
              ? null
              : (result.error ?? '未知失败').slice(0, 512),
            completedAt: new Date(),
            updatedAt: new Date(),
          },
        );
      },
      {
        op: 'idem.complete',
        tenantId: handle.tenantId,
        detail: `tool=${handle.toolName} status=${result.success ? 'succeeded' : 'failed'}`,
      },
    );
  }

  /**
   * 定时清理（复用 R101-AI-17 的 @Cron 模式；每日 03:00）
   *
   * 1. 陈旧 `in_flight`（超过 10 分钟：进程崩溃/未回填）置 `failed` ⇒ 允许重试（方案 R4）
   * 2. 30 天前批量删除（依赖 idx_ai_idempotency_cleanup；分批 LIMIT 5,000）
   */
  @Cron(IDEMPOTENCY_CLEANUP_CRON, { name: IDEMPOTENCY_CLEANUP_JOB_NAME })
  async cleanupExpired(): Promise<{ staleMarked: number; deleted: number }> {
    let staleMarked = 0;
    let deleted = 0;
    try {
      const stale = await this.repo.update(
        {
          status: 'in_flight',
          firstSeenAt: LessThan(
            new Date(Date.now() - IDEMPOTENCY_IN_FLIGHT_TIMEOUT_MS),
          ),
        },
        {
          status: 'failed',
          errorText:
            'in_flight 超时（进程崩溃或结果未回填），已置 failed 以允许重试',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      );
      staleMarked = stale.affected ?? 0;

      const cutoff = new Date(
        Date.now() - IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      );
      for (let i = 0; i < CLEANUP_MAX_LOOPS; i++) {
        // dataSource.query 返回 any（驱动 ResultSetHeader）⇒ 显式收窄，避免 unsafe 成员访问
        const raw = (await this.dataSource.query(
          'DELETE FROM t_ai_idempotency WHERE created_at < ? LIMIT ?',
          [cutoff, CLEANUP_BATCH],
        )) as unknown;
        const affected =
          (raw as { affectedRows?: number } | null)?.affectedRows ?? 0;
        deleted += affected;
        if (affected < CLEANUP_BATCH) {
          break;
        }
      }

      if (staleMarked > 0 || deleted > 0) {
        this.logger.log(
          `幂等表清理完成：陈旧 in_flight 置 failed ${staleMarked} 行、删除过期 ${deleted} 行（保留 ${IDEMPOTENCY_RETENTION_DAYS} 天）`,
        );
      }
    } catch (err) {
      this.logger.error(
        `幂等表清理失败（不阻断调度）：err=${this.messageOf(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
    return { staleMarked, deleted };
  }

  // ──────────────────────────────────────────────────────────────
  // 内部实现
  // ──────────────────────────────────────────────────────────────

  private async runGate(
    input: IdempotencyCheckInput,
  ): Promise<IdempotencyDecision> {
    // ⓪ 显式键合规校验（R101-AI-24）：不合规 ⇒ 明确拒绝（不落 Redis/不落库）
    //    注意：空串视同"未传"，回落 confirm_token / payload_hash，行为与接线前一致
    if (input.explicitKey && !isValidExplicitKey(input.explicitKey)) {
      const reason =
        `显式幂等键不合规（要求 ${MIN_EXPLICIT_KEY_LENGTH}~${MAX_EXPLICIT_KEY_LENGTH} 字符、字母数字开头、` +
        `仅可用 A-Z a-z 0-9 . _ : -）：长度 ${input.explicitKey.length}`;
      this.logger.warn(
        `幂等闸门拒绝执行（显式键不合规）：tool=${input.toolName} tenant=${input.context.tenantId} ${reason}`,
      );
      return {
        decision: 'rejected',
        handle: null,
        result: {
          success: false,
          error: `idempotencyKey 非法：${reason}`,
          suggestion:
            '请改用业务唯一键（如 ERP 单号/工单号，8~128 字符、字母数字开头）；' +
            '不传该字段则按确认令牌/业务参数指纹自动防重',
        },
      };
    }

    const { idemKey, keySource, ttlSec } = this.buildKey(input);
    const tenantId = input.context.tenantId;
    const redisKey = `ai:idem:${tenantId}:${input.toolName}:${idemKey}`;

    // ① Redis SET NX 前置快筛（不可用 ⇒ degrade + 指标，交 MySQL 兜底）
    const client = this.redisProvider.getSharedClient('stop-after-3');
    const nx = await degrade(
      async () => ({
        duplicate:
          (await client.set(redisKey, '1', 'EX', ttlSec, 'NX')) === null,
      }),
      { duplicate: false },
      {
        op: 'idem.redis_nx',
        tenantId,
        detail: `tool=${input.toolName} source=${keySource}`,
      },
    );

    if (nx.duplicate) {
      const row = await this.findRow(tenantId, input.toolName, idemKey);
      if (row) {
        return this.decideFromRow(row, input, { idemKey, keySource });
      }
      // Redis 命中但 MySQL 无行（键过期/被清理/键漂移）⇒ 以 MySQL 为准，继续认领
      this.logger.warn(
        `幂等 Redis 命中但 MySQL 无行，以 MySQL 为准重新认领：tool=${input.toolName} source=${keySource}`,
      );
    }

    // ② MySQL 认领（唯一键 = 并发仲裁点；必须早于 tool.execute）
    const now = new Date();
    try {
      const inserted = await this.repo.insert({
        tenantId,
        toolName: input.toolName,
        idemKey,
        keySource,
        status: 'in_flight',
        resultJson: null,
        errorText: null,
        firstSeenAt: now,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      const id = String(inserted.identifiers[0]?.id ?? '');
      return {
        decision: 'proceed',
        handle: { id, tenantId, toolName: input.toolName, idemKey, keySource },
      };
    } catch (err) {
      if (this.isDuplicateKeyError(err)) {
        const row = await this.findRow(tenantId, input.toolName, idemKey);
        if (row) {
          return this.decideFromRow(row, input, { idemKey, keySource });
        }
        // 唯一键冲突但读不到行（极端竞态/刚被清理）⇒ 宁可重放为首次，不丢用户操作
        this.logger.warn(
          `幂等唯一键冲突但读不到既有行（竞态/已清理），本次放行：tool=${input.toolName}`,
        );
        return { decision: 'proceed', handle: null };
      }

      // ③ MySQL 不可用 ⇒ 裁定 B：fail-open + 死信/指标（残余重复风险由 Redis 层与告警兜住）
      this.logger.error(
        `幂等认领失败（MySQL 不可用），按裁定 B fail-open 放行：tool=${input.toolName} err=${this.messageOf(err)}`,
      );
      await this.reportFailure(err, 'idem.claim', input);
      return { decision: 'proceed', handle: null };
    }
  }

  private async findRow(
    tenantId: string,
    toolName: string,
    idemKey: string,
  ): Promise<AiIdempotencyEntity | null> {
    return this.repo.findOne({ where: { tenantId, toolName, idemKey } });
  }

  /** 既有行 ⇒ 回放 / 处理中 / 失败重试 */
  private async decideFromRow(
    row: AiIdempotencyEntity,
    input: IdempotencyCheckInput,
    key: { idemKey: string; keySource: IdempotencyKeySource },
  ): Promise<IdempotencyDecision> {
    if (row.status === 'succeeded' && row.resultJson) {
      try {
        const original = JSON.parse(row.resultJson) as ToolResult;
        this.logger.log(
          `写工具幂等回放（裁定 A）：tool=${input.toolName} tenant=${input.context.tenantId} keySource=${key.keySource}`,
        );
        return {
          decision: 'replay',
          handle: null,
          result: {
            ...original,
            idempotent_replay: true,
            ...(row.completedAt
              ? { originalCompletedAt: row.completedAt.toISOString() }
              : {}),
          },
        };
      } catch (err) {
        this.logger.warn(
          `幂等结果 JSON 解析失败，按「处理中」返回（不回放脏结果）：tool=${input.toolName} err=${this.messageOf(err)}`,
        );
        return {
          decision: 'in_flight',
          handle: null,
          result: this.inFlightResult(input.toolName),
        };
      }
    }

    if (row.status === 'failed') {
      // 失败可重试：仅当成功从 failed 置回 in_flight 才算本次认领成功
      const res = await this.repo.update(
        { id: row.id, status: 'failed' },
        {
          status: 'in_flight',
          firstSeenAt: new Date(),
          completedAt: null,
          errorText: null,
          updatedAt: new Date(),
        },
      );
      if ((res.affected ?? 0) === 1) {
        this.logger.log(
          `幂等行此前失败，允许同键重试并重新认领：tool=${input.toolName} id=${row.id}`,
        );
        return {
          decision: 'proceed',
          handle: {
            id: String(row.id),
            tenantId: row.tenantId,
            toolName: row.toolName,
            idemKey: key.idemKey,
            keySource: key.keySource,
          },
        };
      }
    }

    // in_flight（或未知状态）：首笔尚未完成 ⇒ 既不能执行也不能回放'未完成'
    this.logger.warn(
      `写工具幂等命中「处理中」，拒绝重复执行：tool=${input.toolName} tenant=${input.context.tenantId}`,
    );
    return {
      decision: 'in_flight',
      handle: null,
      result: this.inFlightResult(input.toolName),
    };
  }

  /** 重复请求返回什么给 LLM（方案 §5）：in_flight ⇒ 明确"处理中"，不回放未完成结果 */
  private inFlightResult(toolName: string): ToolResult {
    return {
      success: false,
      error: `该写操作正在处理中（工具 ${toolName}），重复提交已被幂等闸门拦截`,
      suggestion:
        '请稍后查询该操作的结果；重复提交不会产生第二笔单据，无需再次确认',
    };
  }

  /**
   * 幂等键 = sha256(tenant_id | tool_name | key_material)（方案 §1.2）
   *
   * 优先级（R101-AI-25 后共四档；前两档语义**未改**）：
   * 1. `explicit`：调用方显式键（600s）
   * 2. `confirm_token`：确认通道令牌（600s）
   * 3. `business_key`：工具声明了 `idempotencyKeyFields` **且至少一个声明字段有值**
   *    ⇒ 只用这些业务字段做指纹（R101-AI-25，TTL 同 payload 档 60s）
   * 4. `payload_hash`：全量参数规范化哈希（兜底，60s）
   */
  private buildKey(input: IdempotencyCheckInput): {
    idemKey: string;
    keySource: IdempotencyKeySource;
    ttlSec: number;
  } {
    const explicit = input.explicitKey?.trim();
    let material: string;
    let keySource: IdempotencyKeySource;
    let ttlSec: number;

    if (explicit) {
      material = `explicit:${explicit}`;
      keySource = 'explicit';
      ttlSec = IDEMPOTENCY_REDIS_TTL_SEC;
    } else if (
      input.toolCallId &&
      input.toolCallId.startsWith(CONFIRM_TOOLCALL_PREFIX)
    ) {
      material = `token:${input.toolCallId}`;
      keySource = 'confirm_token';
      ttlSec = IDEMPOTENCY_REDIS_TTL_SEC;
    } else {
      const business = this.pickBusinessFields(input.args, input.keyFields);
      if (business) {
        // 业务字段指纹（提精）：只取声明字段，流程噪音天然不参与
        material = `business:${business.json}`;
        keySource = 'business_key';
        this.logger.debug(
          `幂等键走业务字段：tool=${input.toolName} fields=${business.present.join(',')}`,
        );
      } else {
        // 兜底（未声明，或声明字段全缺失）：与 AI-21 完全一致
        material = `payload:${this.canonicalJson(input.args)}`;
        keySource = 'payload_hash';
        if (input.keyFields?.length) {
          this.logger.debug(
            `幂等键回落 payload 兜底（声明字段均未传）：tool=${input.toolName} declared=${input.keyFields.join(',')}`,
          );
        }
      }
      ttlSec = IDEMPOTENCY_PAYLOAD_TTL_SEC;
    }

    const idemKey = createHash('sha256')
      .update(`${input.context.tenantId}|${input.toolName}|${material}`, 'utf8')
      .digest('hex');
    return { idemKey, keySource, ttlSec };
  }

  /**
   * 取工具声明的业务字段子集（R101-AI-25）
   *
   * @returns null = 未声明 或 声明字段在本次参数中**全部缺失**（⇒ 调用方回落 payload 兜底）
   */
  private pickBusinessFields(
    args: Record<string, unknown>,
    keyFields?: readonly string[],
  ): { json: string; present: string[] } | null {
    if (!keyFields || keyFields.length === 0) {
      return null;
    }
    const picked: Record<string, unknown> = {};
    const present: string[] = [];
    for (const field of keyFields) {
      const value = args[field];
      if (value === undefined) {
        continue; // 缺失字段不参与指纹（不崩、也不把 undefined 序列化进去）
      }
      picked[field] = value;
      present.push(field);
    }
    if (present.length === 0) {
      return null;
    }
    // 声明字段是**业务身份**，不做流程噪音剔除（`remark` 等正是声明要保留的区分字段）
    return { json: JSON.stringify(this.canonicalize(picked, false)), present };
  }

  /** 业务参数规范化（键排序 + 数值/字符串归一 + 剔除易变字段），保证同义同键 */
  private canonicalJson(args: Record<string, unknown>): string {
    return JSON.stringify(this.canonicalize(args, true));
  }

  /**
   * 归一化
   *
   * @param stripVolatile true = 剔除流程噪音字段（payload 兜底档用）；
   *        false = 全量保留（业务字段档用：声明字段即业务身份，含 remark）
   */
  private canonicalize(value: unknown, stripVolatile: boolean): unknown {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'string') {
        return value.trim();
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          return String(value);
        }
        return Object.is(value, -0) ? 0 : value;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.canonicalize(item, stripVolatile));
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (stripVolatile && VOLATILE_ARG_FIELDS.has(key)) {
        continue;
      }
      const item = source[key];
      if (item === undefined) {
        continue;
      }
      out[key] = this.canonicalize(item, stripVolatile);
    }
    return out;
  }

  /** 唯一键冲突识别（TypeORM QueryFailedError / mysql2 driverError 两种形态） */
  private isDuplicateKeyError(err: unknown): boolean {
    const e = err as {
      code?: string;
      errno?: number;
      message?: string;
      driverError?: { code?: string; errno?: number };
    };
    if (e?.code === 'ER_DUP_ENTRY' || e?.errno === 1062) {
      return true;
    }
    if (
      e?.driverError?.code === 'ER_DUP_ENTRY' ||
      e?.driverError?.errno === 1062
    ) {
      return true;
    }
    return (
      typeof e?.message === 'string' && e.message.includes('Duplicate entry')
    );
  }

  /** fail-open 留痕：error-semantics 死信口径（日志 + 指标 + 死信接收方） */
  private async reportFailure(
    err: unknown,
    op: string,
    input: IdempotencyCheckInput,
  ): Promise<void> {
    const error = err instanceof Error ? err : new Error(String(err));
    await bestEffort(() => Promise.reject(error), {
      op,
      tenantId: input.context.tenantId,
      detail: `tool=${input.toolName}（已 fail-open 放行，残余重复风险需人工核查）`,
    });
  }

  private messageOf(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 供 tool-executor 复用的 @Cron 表达式类型再导出（避免 schedule 依赖扩散） */
export { CronExpression };
