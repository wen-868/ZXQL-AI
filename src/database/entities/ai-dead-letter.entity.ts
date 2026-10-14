/**
 * bestEffort 死信实体（死信 sink 生产注册，R101-AI-22）
 *
 * 表：`t_ai_dead_letter`（业务库，迁移 `migrations/017_ai_dead_letter.sql`）
 * 与 `DeadLetterRecord`（src/common/error-semantics.ts:48）**逐字段对齐**：
 * op / tenantId / detail / error / stack / level（恒 best_effort） / at（ISO8601 → DATETIME(3)）
 *
 * 用途：`setDefaultDeadLetterSink` 的落库端 ⇒ bestEffort 失败（审计流水、用量上报、
 * 消息推送、幂等闸门 fail-open 等「可最终一致」的旁路）的死信可复盘、可重放。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-12
 */
import { Column, Entity } from 'typeorm';
import { primaryGeneratedColumn } from '../dialect';

@Entity('t_ai_dead_letter')
export class AiDeadLetterEntity {
  /** 主键 ID（BIGINT UNSIGNED；mysql2 以字符串返回） */
  @primaryGeneratedColumn('bigint')
  id!: string;

  /** 失败的操作名（模块.动作，如 `idem.claim`） */
  @Column({ name: 'op', type: 'varchar', length: 64 })
  op!: string;

  /** 租户 ID（可空：非租户链路失败） */
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, nullable: true })
  tenantId!: string | null;

  /** 补充说明（如 key、订单号） */
  @Column({ name: 'detail', type: 'text', nullable: true })
  detail!: string | null;

  /** 错误消息 */
  @Column({ name: 'error', type: 'text' })
  error!: string;

  /** 错误堆栈（便于复盘，可能为空） */
  @Column({ name: 'stack', type: 'text', nullable: true })
  stack!: string | null;

  /** 语义级别（恒 `best_effort`；与 error-semantics 的 ErrorSemanticsLevel 取值一致） */
  @Column({
    name: 'level',
    type: 'varchar',
    length: 16,
    default: 'best_effort',
  })
  level!: string;

  /** 失败发生时间（由 ISO8601 解析，迁移侧 DATETIME(3) 保留毫秒） */
  @Column({ name: 'at', type: 'datetime', precision: 3 })
  at!: Date;

  /** 写入时间（清理依据） */
  @Column({ name: 'created_at', type: 'datetime' })
  createdAt!: Date;
}
