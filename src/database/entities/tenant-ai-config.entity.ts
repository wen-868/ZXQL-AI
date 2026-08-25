/**
 * 租户级AI配置 Entity
 *
 * 对应表: t_tenant_ai_config
 * 每租户1条记录，存储该租户的AI服务商/模型/API Key等配置（覆盖平台默认）
 * 字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_tenant_ai_config')
@Index('idx_tenant_id', ['tenantId'])
@Index('idx_created_at', ['createdAt'])
@Index('idx_tenant_created', ['tenantId', 'createdAt'])
export class TenantAiConfigEntity {
  /** 主键ID */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 租户ID（关联 t_tenant.id，唯一约束） */
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 36,
    unique: true,
    comment: '租户ID（关联 t_tenant.id）',
  })
  tenantId!: string;

  /** 是否启用AI功能: 1=启用 0=禁用 */
  @Column({
    name: 'enabled',
    type: 'tinyint',
    default: 1,
    comment: '是否启用AI功能: 1=启用 0=禁用',
  })
  enabled!: number;

  /** AI服务商: deepseek/qwen/zhipu/ollama */
  @Column({
    name: 'provider',
    type: 'varchar',
    length: 32,
    default: 'glm',
    comment: 'AI服务商: deepseek/qwen/zhipu/ollama',
  })
  provider!: string;

  /** API Key（AES-256-GCM加密存储） */
  @Column({
    name: 'api_key',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: 'API Key（AES-256-GCM加密存储）',
  })
  apiKey!: string | null;

  /** 自定义Endpoint（留空则用服务商默认地址） */
  @Column({
    name: 'api_endpoint',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '自定义Endpoint（留空则用服务商默认地址）',
  })
  apiEndpoint!: string | null;

  /** 模型名称 */
  @Column({
    name: 'model',
    type: 'varchar',
    length: 64,
    default: 'glm-4-flash',
    comment: '模型名称',
  })
  model!: string;

  /** 温度参数 0.0-2.0 */
  @Column({
    name: 'temperature',
    type: 'decimal',
    precision: 2,
    scale: 1,
    default: 0.3,
    comment: '温度参数 0.0-2.0',
  })
  temperature!: number;

  /** 最大Token数 */
  @Column({
    name: 'max_tokens',
    type: 'int',
    default: 2048,
    comment: '最大Token数',
  })
  maxTokens!: number;

  /** 自定义系统提示词（覆盖平台默认） */
  @Column({
    name: 'system_prompt',
    type: 'text',
    nullable: true,
    comment: '自定义系统提示词（覆盖平台默认）',
  })
  systemPrompt!: string | null;

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
