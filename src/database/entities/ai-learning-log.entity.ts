/**
 * AI 学习回流记录 Entity
 *
 * 对应表: t_ai_learning_log（迁移 159）
 * 自主学习（P2 LN）：经验应用记录 + 采纳评估（positive/negative）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_learning_log')
export class AiLearningLogEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('idx_learning_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'exp_id',
    type: 'bigint',
    nullable: true,
    comment: '关联情节经验ID',
  })
  expId!: number | null;

  @Column({
    name: 'hint_key',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '回流提示键',
  })
  hintKey!: string | null;

  @Column({
    name: 'applied_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '应用时间',
  })
  appliedAt!: Date;

  @Column({
    name: 'effect',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '效果：positive/negative',
  })
  effect!: string | null;

  @Column({
    name: 'note',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '备注',
  })
  note!: string | null;
}
