/**
 * AI用量日统计表 Entity
 *
 * 对应表: t_ai_usage_daily
 * 按租户+日期+服务商汇总AI用量，唯一键防重复汇总
 * ⚠️唯一键为 (tenant_id, stat_date, provider) 三列（P0-014），不含 model。
 *   字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
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
// P0-014 重做：写入侧 audit-logger.ts 的 INSERT ... ON DUPLICATE KEY UPDATE 依赖
// (tenant_id, stat_date, provider) 唯一键才能走 UPDATE 分支。该键缺失时
// UPSERT 退化为纯 INSERT，表按请求数膨胀，用量报表与超阈值告警静默失真。
// 库侧由 migrations/014_usage_daily_unique_key.sql 建立，此处保持实体与库一致。
//
// ⚠️ 为什么是三列而不是四列（含 model）：生产上已存在的唯一键就是三列
//   （uk_tenant_date_provider），而 UPSERT 命中哪一列的唯一键就按哪一列累加
//   ⇒ 生产实际的累加口径早已是三列。014 的存量合并同样按三列口径。
//   ⚠️ 代价（不可逆）：合并后 model 退化为「代表值」，本表不能再按 model 拆分；
//   需要按 model 分析用量时必须查明细表 t_ai_audit_log。
//
// provider / model 两列已由 014 第 6 步收敛为 NOT NULL DEFAULT 'unknown'：
// MySQL 唯一索引视每个 NULL 互不相同，只有列层面禁止 NULL，哨兵口径才真正生效。
// 哨兵值 'unknown' 三处一致：库默认值（此处）、迁移回填值（014 第 5 步）、
// 写入侧空值兜底（audit-logger.ts 的 `?? 'unknown'`）。
@Index('uk_tenant_date_provider', ['tenantId', 'statDate', 'provider'], {
  unique: true,
})
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

  /**
   * AI服务商
   *
   * P0-014：NOT NULL DEFAULT 'unknown'（库侧由 014 第 6 步建立）。
   * 唯一键不含可空列，NULL 行不会被去重 ⇒ 空值统一用哨兵值 'unknown'。
   */
  @Column({
    name: 'provider',
    type: 'varchar',
    length: 32,
    nullable: false,
    default: 'unknown',
    comment: "AI服务商；未指定时为哨兵值 'unknown'（P0-014）",
  })
  provider!: string;

  /**
   * 模型名称
   *
   * P0-014：NOT NULL DEFAULT 'unknown'（库侧由 014 第 6 步建立）。
   * ⚠️ 三列唯一键不含 model ⇒ 存量合并后本字段是「代表值」（组内字典序最小的
   * 有效 model），**不能**用它按模型维度拆分用量；需要按 model 分析时查
   * 明细表 t_ai_audit_log。
   */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 64,
    nullable: false,
    default: 'unknown',
    comment:
      "模型名称；未指定时为哨兵值 'unknown'。三列唯一键不含本列，存量合并后为组内代表值，不可用于按模型拆分用量（P0-014）",
  })
  model!: string;

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
