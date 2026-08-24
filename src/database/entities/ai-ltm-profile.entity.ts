/**
 * AI 长期记忆-档案 Entity
 *
 * 对应表: t_ai_ltm_profile（迁移 158）
 * 存储租户/用户稳定事实：偏好、常用对象、品牌调性、禁区。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_ltm_profile')
export class AiLtmProfileEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('uk_ltm_profile', { unique: true })
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'entity_type',
    type: 'varchar',
    length: 32,
    default: 'tenant',
    comment: '主体类型',
  })
  entityType!: string;

  @Column({
    name: 'entity_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '主体ID',
  })
  entityId!: string | null;

  @Column({ name: 'k', type: 'varchar', length: 128, comment: '档案键' })
  k!: string;

  @Column({
    name: 'v_json',
    type: 'json',
    nullable: true,
    comment: '档案值',
  })
  vJson!: Record<string, unknown> | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
    comment: '更新时间',
  })
  updatedAt!: Date;
}
