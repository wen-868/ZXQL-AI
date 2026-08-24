/**
 * AI 自主进化版本 Entity
 *
 * 对应表: t_ai_evolution（迁移 160）
 * 自主进化（P3 SE 门控）：proposed→review→gray→rolled_out / rejected / rolled_back，
 * current_snapshot 保证一键回滚；仅租户内生效。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_evolution')
export class AiEvolutionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('idx_evolution_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'target',
    type: 'varchar',
    length: 16,
    comment: '进化对象',
  })
  target!: string;

  @Column({ name: 'version', type: 'int', default: 1, comment: '版本号' })
  version!: number;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: 'proposed',
    comment: '状态',
  })
  status!: string;

  @Column({
    name: 'current_snapshot',
    type: 'text',
    nullable: true,
    comment: '现版本快照',
  })
  currentSnapshot!: string | null;

  @Column({
    name: 'proposed_diff',
    type: 'text',
    nullable: true,
    comment: '建议内容',
  })
  proposedDiff!: string | null;

  @Column({
    name: 'rationale',
    type: 'varchar',
    length: 1000,
    nullable: true,
    comment: '依据',
  })
  rationale!: string | null;

  @Column({
    name: 'review_id',
    type: 'bigint',
    nullable: true,
    comment: '关联待审工单ID',
  })
  reviewId!: number | null;

  @Column({
    name: 'gray_percent',
    type: 'int',
    default: 0,
    comment: '灰度比例',
  })
  grayPercent!: number;

  @Column({
    name: 'proposed_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '提出人',
  })
  proposedBy!: string | null;

  @Column({
    name: 'reviewed_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '审核人',
  })
  reviewedBy!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;

  @Column({
    name: 'rolled_out_at',
    type: 'datetime',
    nullable: true,
    comment: '生效时间',
  })
  rolledOutAt!: Date | null;
}
