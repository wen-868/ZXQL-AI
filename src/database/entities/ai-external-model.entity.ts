/**
 * AI 外部大模型配置 Entity
 *
 * 对应表: t_ai_external_model（迁移 154）
 * 平台级外部模型库：支持添加任意 OpenAI 兼容外部大模型，
 * 由 ExternalModelService 在启动时解密 api_key 并注册到 ProviderFactory，
 * 供平台默认配置 / 租户配置选择使用。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_external_model')
export class AiExternalModelEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '主键ID' })
  id!: number;

  /** 唯一标识（provider 类型名，如 custom_kimi） */
  @Index('uk_external_model_name', { unique: true })
  @Column({ name: 'name', type: 'varchar', length: 64, comment: '唯一标识' })
  name!: string;

  /** 展示名称（如 Kimi） */
  @Column({
    name: 'display_name',
    type: 'varchar',
    length: 128,
    comment: '展示名称',
  })
  displayName!: string;

  /** OpenAI 兼容 API 基础地址 */
  @Column({
    name: 'provider_base_url',
    type: 'varchar',
    length: 255,
    comment: 'OpenAI 兼容 API 基础地址',
  })
  providerBaseUrl!: string;

  /** API Key（AES-256-GCM 加密存储） */
  @Column({
    name: 'api_key',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: 'API Key（加密存储）',
  })
  apiKey!: string | null;

  /** 模型名称 */
  @Column({
    name: 'model_name',
    type: 'varchar',
    length: 128,
    comment: '模型名称',
  })
  modelName!: string;

  /** 是否启用 */
  @Column({
    name: 'enabled',
    type: 'tinyint',
    default: 1,
    comment: '是否启用：1=启用 0=停用',
  })
  enabled!: number;

  /** 排序 */
  @Column({
    name: 'sort_order',
    type: 'int',
    default: 0,
    comment: '排序',
  })
  sortOrder!: number;

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
