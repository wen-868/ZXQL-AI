/**
 * AI 经验样本 Entity（ai_db 独立库，P1-1）
 *
 * 对应表: ai_experience（文档 26.4）
 * 每次任务结束落一条：成功/失败路径（trajectory 已脱敏），
 * 供经验抽取器归纳"为什么错、正确做法"。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_experience')
export class AiExperienceEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户 ID */
  @Index('idx_exp_tenant')
  @Column({ name: 'tenant_id', type: 'varchar', length: 32, comment: '租户ID' })
  tenantId!: string;

  /** 领域：analysis=分析 / write=写入 / push=推送 */
  @Index('idx_exp_domain')
  @Column({
    name: 'domain',
    type: 'varchar',
    length: 16,
    comment: '领域：analysis/write/push',
  })
  domain!: string;

  /** 意图标签（如 sales_order_create / margin_analysis） */
  @Column({
    name: 'intent',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '意图标签',
  })
  intent!: string | null;

  /** 输入脱敏指纹（MD5，去重聚合用） */
  @Index('idx_exp_input_hash')
  @Column({
    name: 'input_hash',
    type: 'char',
    length: 32,
    nullable: true,
    comment: '输入脱敏指纹',
  })
  inputHash!: string | null;

  /** 规划/调用/观察链路（已脱敏） */
  @Column({
    name: 'trajectory',
    type: 'text',
    nullable: true,
    comment: '规划/调用/观察链路（脱敏）',
  })
  trajectory!: string | null;

  /** 结果：success=成功 / corrected=被纠正 / failed=失败 */
  @Column({
    name: 'outcome',
    type: 'varchar',
    length: 16,
    comment: '结果：success/corrected/failed',
  })
  outcome!: string;

  /** 产出是否被采纳（分析/话术） */
  @Column({
    name: 'adopted',
    type: 'tinyint',
    nullable: true,
    comment: '产出是否被采纳：1=采纳 0=否定 NULL=未知',
  })
  adopted!: number | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
