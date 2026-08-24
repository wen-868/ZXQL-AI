/**
 * AI 训练样本 Entity（ai_db 独立库，P1-1）
 *
 * 对应表: ai_sample（文档 26.4）
 * 脱敏输入输出对（prompt/completion），用于本地模型蒸馏/微调
 * （触发阈值：同 task_type 样本 ≥50 且 quality ≥4）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_sample')
export class AiSampleEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户 ID */
  @Index('idx_sample_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 32, comment: '租户ID' })
  tenantId!: string;

  /** 任务类型 */
  @Index('idx_sample_type')
  @Column({
    name: 'task_type',
    type: 'varchar',
    length: 64,
    comment: '任务类型',
  })
  taskType!: string;

  /** 输入（脱敏） */
  @Column({
    name: 'prompt',
    type: 'text',
    nullable: true,
    comment: '输入（脱敏）',
  })
  prompt!: string | null;

  /** 期望输出（脱敏） */
  @Column({
    name: 'completion',
    type: 'text',
    nullable: true,
    comment: '期望输出（脱敏）',
  })
  completion!: string | null;

  /** 质量评分（5 分制，采纳=高） */
  @Column({ name: 'quality', type: 'tinyint', default: 1, comment: '质量评分' })
  quality!: number;

  /** 是否已用于训练 */
  @Column({
    name: 'used_for_training',
    type: 'tinyint',
    default: 0,
    comment: '是否已用于训练',
  })
  usedForTraining!: number;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
