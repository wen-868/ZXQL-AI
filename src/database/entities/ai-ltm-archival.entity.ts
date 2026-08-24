/**
 * AI 长期记忆-归档 Entity
 *
 * 对应表: t_ai_ltm_archival（迁移 158）
 * 存储文档/知识沉淀（选品库、话术模板、复盘结论）。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_ltm_archival')
export class AiLtmArchivalEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('idx_ltm_archival_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '标题' })
  title!: string;

  @Column({
    name: 'body',
    type: 'text',
    nullable: true,
    comment: '正文',
  })
  body!: string | null;

  @Column({
    name: 'source',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '来源',
  })
  source!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
