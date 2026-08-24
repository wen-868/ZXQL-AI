/**
 * AI用量日统计表 Entity
 *
 * 对应表: t_ai_usage_daily
 * 按租户+日期+服务商汇总AI用量，唯一键防重复汇总
 * 字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_usage_daily')
@Index('idx_tenant_id', ['tenantId'])
@Index('idx_created_at', ['createdAt'])
@Index('idx_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_tenant_date', ['tenantId', 'statDate'])
@Index('idx_date', ['statDate'])
export class AiUsageDailyEntity {
  /** 主键ID */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户ID */
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 36,
    comment: '租户ID',
  })
  tenantId!: string;

  /** 统计日期 */
  @Column({
    name: 'stat_date',
    type: 'date',
    comment: '统计日期',
  })
  statDate!: string;

  /** 对话次数 */
  @Column({
    name: 'chat_count',
    type: 'int',
    default: 0,
    comment: '对话次数',
  })
  chatCount!: number;

  /** 工具调用次数 */
  @Column({
    name: 'tool_call_count',
    type: 'int',
    default: 0,
    comment: '工具调用次数',
  })
  toolCallCount!: number;

  /** 提示Token数 */
  @Column({
    name: 'prompt_tokens',
    type: 'bigint',
    default: 0,
    comment: '提示Token数',
  })
  promptTokens!: number;

  /** 完成Token数 */
  @Column({
    name: 'completion_tokens',
    type: 'bigint',
    default: 0,
    comment: '完成Token数',
  })
  completionTokens!: number;

  /** 总Token数 */
  @Column({
    name: 'total_tokens',
    type: 'bigint',
    default: 0,
    comment: '总Token数',
  })
  totalTokens!: number;

  /** 提示费用（元） */
  @Column({
    name: 'prompt_cost',
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0.0,
    comment: '提示费用（元）',
  })
  promptCost!: number;

  /** 完成费用（元） */
  @Column({
    name: 'completion_cost',
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0.0,
    comment: '完成费用（元）',
  })
  completionCost!: number;

  /** 总费用（元） */
  @Column({
    name: 'total_cost',
    type: 'decimal',
    precision: 12,
    scale: 4,
    default: 0.0,
    comment: '总费用（元）',
  })
  totalCost!: number;

  /** AI服务商 */
  @Column({
    name: 'provider',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: 'AI服务商',
  })
  provider!: string | null;

  /** 模型名称 */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '模型名称',
  })
  model!: string | null;

  /** 创建时间 */
  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;

  /** 更新时间 */
  @Column({
    name: 'updated_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
    comment: '更新时间',
  })
  updatedAt!: Date;
}
