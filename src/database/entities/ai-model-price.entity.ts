/**
 * AI 模型分档单价 Entity（R101-AI-07 甲-2）
 *
 * 对应表: t_ai_model_price（业务库侧，本仓独占；迁移 015_ai_model_price.sql）
 *
 * 定位：`prompt` / `completion` **分档单价**的真实来源（元/千Token）。
 * - 与 `t_tenant_ai_billing.overage_price`（blended「超额价」，实扣余额用）是
 *   两个不同概念：本表是**按 provider + model 的牌价**，供用量费用列折算。
 * - 价格只能来自本表配置，**不得**在代码里硬编码价格表。
 * - 解析口径：同 (provider, model) 且 `enabled=1`、`effective_from <= 当前时间`
 *   的多行中取 `effective_from` 最大者；**无行即「未配置」**（调用方拿 null，
 *   不得回落成 0 冒充已配置）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_model_price')
@Index(
  'uk_ai_model_price_provider_model_effective',
  ['provider', 'model', 'effectiveFrom'],
  { unique: true },
)
@Index('idx_ai_model_price_lookup', [
  'provider',
  'model',
  'enabled',
  'effectiveFrom',
])
export class AiModelPriceEntity {
  /** 主键ID */
  @PrimaryGeneratedColumn({ type: 'int', unsigned: true, comment: '主键ID' })
  id!: number;

  /**
   * AI 服务商
   *
   * 与 `t_ai_usage_daily.provider` 同口径（glm / deepseek / qwen / ollama 等）；
   * 外部大模型用其注册标识（`t_ai_external_model.name`，如 custom_kimi）。
   */
  @Column({
    name: 'provider',
    type: 'varchar',
    length: 32,
    comment: 'AI服务商（与 t_ai_usage_daily.provider 同口径）',
  })
  provider!: string;

  /**
   * 模型名
   *
   * 按调用侧 `model` **精确匹配**（不使用通配）；`t_ai_usage_daily` 的
   * model 列为「代表值」（014 三列唯一键的代价），故不许可用该列定价，
   * 定价须用调用明细（t_ai_audit_log）里的真实 model。
   */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 64,
    comment: '模型名（精确匹配，不使用通配）',
  })
  model!: string;

  /** 输入单价（元/千Token） */
  @Column({
    name: 'prompt_price',
    type: 'decimal',
    precision: 12,
    scale: 6,
    comment: '输入单价（元/千Token）',
  })
  promptPrice!: number;

  /** 输出单价（元/千Token） */
  @Column({
    name: 'completion_price',
    type: 'decimal',
    precision: 12,
    scale: 6,
    comment: '输出单价（元/千Token）',
  })
  completionPrice!: number;

  /** 币种（ISO 4217 三字母） */
  @Column({
    name: 'currency',
    type: 'char',
    length: 3,
    default: 'CNY',
    comment: '币种（ISO 4217）',
  })
  currency!: string;

  /**
   * 生效时间
   *
   * 解析取「`effective_from <= 当前时间` 中的最大者」⇒ 支持调价留痕：
   * 未来时间的行不会提前生效，历史行保留可追溯。
   */
  @Column({
    name: 'effective_from',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '生效时间（取 <= 当前时间的最大者）',
  })
  effectiveFrom!: Date;

  /** 是否启用: 1=启用 0=停用 */
  @Column({
    name: 'enabled',
    type: 'tinyint',
    default: 1,
    comment: '是否启用: 1=启用 0=停用',
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
