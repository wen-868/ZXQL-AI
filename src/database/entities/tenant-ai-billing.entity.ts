/**
 * 租户AI计费套餐配置 Entity
 *
 * 对应表: t_tenant_ai_billing
 * 每租户1条记录，存储计费套餐类型/免费额度/超额单价/月费等配置
 * 字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_tenant_ai_billing')
@Index('idx_tenant_id', ['tenantId'])
@Index('idx_created_at', ['createdAt'])
@Index('idx_tenant_created', ['tenantId', 'createdAt'])
export class TenantAiBillingEntity {
  /** 主键ID */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户ID（唯一约束，每租户1条） */
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 36,
    unique: true,
    comment: '租户ID',
  })
  tenantId!: string;

  /** 套餐类型: pay_as_you_go=按量后付 / monthly=包月 / prepaid=预付费 */
  @Column({
    name: 'plan_type',
    type: 'varchar',
    length: 32,
    default: 'pay_as_you_go',
    comment: '套餐类型: pay_as_you_go/monthly/prepaid',
  })
  planType!: string;

  /** 免费对话次数 */
  @Column({
    name: 'free_chat_count',
    type: 'int',
    default: 100,
    comment: '免费对话次数',
  })
  freeChatCount!: number;

  /** 免费Token额度 */
  @Column({
    name: 'free_token_limit',
    type: 'bigint',
    default: 100000,
    comment: '免费Token额度',
  })
  freeTokenLimit!: number;

  /** 超额单价（元/千Token） */
  @Column({
    name: 'overage_price',
    type: 'decimal',
    precision: 10,
    scale: 6,
    default: 0.001,
    comment: '超额单价（元/千Token）',
  })
  overagePrice!: number;

  /** 月对话上限（0=不限） */
  @Column({
    name: 'monthly_chat_limit',
    type: 'int',
    default: 0,
    comment: '月对话上限（0=不限）',
  })
  monthlyChatLimit!: number;

  /** 月Token上限（0=不限） */
  @Column({
    name: 'monthly_token_limit',
    type: 'bigint',
    default: 0,
    comment: '月Token上限（0=不限）',
  })
  monthlyTokenLimit!: number;

  /** 月费（元） */
  @Column({
    name: 'monthly_price',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0.0,
    comment: '月费（元）',
  })
  monthlyPrice!: number;

  /** 是否启用: 1=启用 0=禁用 */
  @Column({
    name: 'enabled',
    type: 'tinyint',
    default: 1,
    comment: '是否启用: 1=启用 0=禁用',
  })
  enabled!: number;

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
