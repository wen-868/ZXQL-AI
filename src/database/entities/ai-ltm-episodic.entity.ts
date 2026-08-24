/**
 * AI 长期记忆-情节 Entity
 *
 * 对应表: t_ai_ltm_episodic（迁移 158）
 * 存储历史交互摘要与成败经验（what/why/outcome）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_ltm_episodic')
export class AiLtmEpisodicEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('idx_ltm_episodic_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'summary',
    type: 'varchar',
    length: 1000,
    nullable: true,
    comment: '经验摘要',
  })
  summary!: string | null;

  @Column({
    name: 'what',
    type: 'varchar',
    length: 1000,
    nullable: true,
    comment: '发生了什么',
  })
  what!: string | null;

  @Column({
    name: 'why',
    type: 'varchar',
    length: 1000,
    nullable: true,
    comment: '原因',
  })
  why!: string | null;

  @Column({
    name: 'outcome',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: 'good/bad',
  })
  outcome!: string | null;

  @Column({ name: 'score', type: 'int', default: 0, comment: '重要度评分' })
  score!: number;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
