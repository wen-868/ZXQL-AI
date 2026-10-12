/**
 * AI 写工具幂等键实体（阶段 3 幂等键 · MySQL 唯一索引兜底层）
 *
 * 表：`t_ai_idempotency`（业务库，迁移 `migrations/016_ai_idempotency.sql`）
 * 唯一键：`uk_ai_idempotency (tenant_id, tool_name, idem_key)`
 * 作用：写工具「至多一次落单」的最终防线 —— Redis SET NX 只做前置快筛，
 * 本表的唯一键负责并发互斥与持久兜底（Redis 宕机/重启/被 FLUSH 后仍生效）。
 *
 * 字段与迁移**逐列对齐**（12 列 = id + 11 业务列，卡片所称「11 列」即不含 id 的业务列）：
 * id / tenant_id / tool_name / idem_key / key_source / status / result_json /
 * error_text / first_seen_at / completed_at / created_at / updated_at
 *
 * 语义（方案 §3.1/§3.2）：
 * - 认领（INSERT status='in_flight'）必须发生在 `tool.execute()` **之前**；
 *   唯一键冲突方读既有行 → 回放（succeeded）或返回「处理中」（in_flight）。
 * - 失败置 'failed' 并允许同键重试；仅 'succeeded' 才回放。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** 幂等键来源（可观测键质量；与迁移 key_source 列取值一致） */
export type IdempotencyKeySource =
  | 'confirm_token' // 确认通道令牌（toolCall.id = confirm-<写审核令牌>）
  | 'explicit' // 调用方显式幂等键（options.idempotencyKey）
  | 'payload_hash'; // 业务参数规范化哈希（兜底）

/** 幂等行状态（与迁移 status 列取值一致） */
export type IdempotencyStatus = 'in_flight' | 'succeeded' | 'failed';

@Entity('t_ai_idempotency')
export class AiIdempotencyEntity {
  /** 主键 ID（BIGINT UNSIGNED；mysql2 以字符串返回） */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: string;

  /** 租户 ID（幂等键第一段，多租户隔离） */
  @Column({ name: 'tenant_id', type: 'varchar', length: 36 })
  tenantId!: string;

  /** 工具名（幂等键第二段） */
  @Column({ name: 'tool_name', type: 'varchar', length: 64 })
  toolName!: string;

  /** 幂等键 sha256 hex（第三段） */
  @Column({ name: 'idem_key', type: 'char', length: 64 })
  idemKey!: string;

  /** 键来源：confirm_token / explicit / payload_hash */
  @Column({ name: 'key_source', type: 'varchar', length: 16 })
  keySource!: IdempotencyKeySource;

  /** 状态：in_flight / succeeded / failed */
  @Column({ name: 'status', type: 'varchar', length: 16, default: 'in_flight' })
  status!: IdempotencyStatus;

  /** 首次执行结果（ToolResult JSON，供重复请求回放） */
  @Column({ name: 'result_json', type: 'mediumtext', nullable: true })
  resultJson!: string | null;

  /** 失败摘要（脱敏，仅排障） */
  @Column({ name: 'error_text', type: 'varchar', length: 512, nullable: true })
  errorText!: string | null;

  /** 认领时刻 */
  @Column({ name: 'first_seen_at', type: 'datetime' })
  firstSeenAt!: Date;

  /** 完成时刻（in_flight 超时看护用） */
  @Column({ name: 'completed_at', type: 'datetime', nullable: true })
  completedAt!: Date | null;

  /** 创建时间 */
  @Column({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;

  /** 更新时间 */
  @Column({ name: 'updated_at', type: 'datetime' })
  updatedAt!: Date;
}
