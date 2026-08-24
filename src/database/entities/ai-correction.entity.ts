/**
 * AI 用户纠正 Entity（ai_db 独立库，P1-1）
 *
 * 对应表: ai_correction（文档 26.4）
 * 用户纠正 Agent 抽错/写错的样本——校准金标准：
 * wrong_payload / right_payload 均已脱敏，reason 记录"为什么错"。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_correction')
export class AiCorrectionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户 ID */
  @Index('idx_corr_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 32, comment: '租户ID' })
  tenantId!: string;

  /** 任务类型（如 customer_create / 毛利归因） */
  @Index('idx_corr_type')
  @Column({
    name: 'task_type',
    type: 'varchar',
    length: 64,
    comment: '任务类型',
  })
  taskType!: string;

  /** Agent 原产出（已脱敏） */
  @Column({
    name: 'wrong_payload',
    type: 'json',
    nullable: true,
    comment: 'Agent 原产出（脱敏）',
  })
  wrongPayload!: Record<string, unknown> | null;

  /** 正确版本（已脱敏） */
  @Column({
    name: 'right_payload',
    type: 'json',
    nullable: true,
    comment: '正确版本（脱敏）',
  })
  rightPayload!: Record<string, unknown> | null;

  /** 纠正原因（"为什么错"） */
  @Column({
    name: 'reason',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '纠正原因',
  })
  reason!: string | null;

  /** 已反哺到的 Schema/模板版本 */
  @Column({
    name: 'applied_to_version',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '已反哺到的版本',
  })
  appliedToVersion!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
