/**
 * 平台级AI全局配置 Entity
 *
 * 对应表: t_platform_ai_config
 * 全平台仅1条记录，存储AI服务商/模型/API Key等默认配置
 * 字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';

@Entity('t_platform_ai_config')
export class PlatformAiConfigEntity {
  /** 主键ID */
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 默认AI服务商: deepseek/qwen/zhipu/ollama */
  @Column({
    name: 'default_provider',
    type: 'varchar',
    length: 32,
    default: 'deepseek',
    comment: '默认AI服务商: deepseek/qwen/zhipu/ollama',
  })
  defaultProvider!: string;

  /** 默认模型名称 */
  @Column({
    name: 'default_model',
    type: 'varchar',
    length: 64,
    default: 'deepseek-chat',
    comment: '默认模型名称',
  })
  defaultModel!: string;

  /** 默认API Key（AES-256-GCM加密存储） */
  @Column({
    name: 'default_api_key',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: '默认API Key（AES-256-GCM加密存储）',
  })
  defaultApiKey!: string | null;

  /** 默认自定义Endpoint（留空则用服务商默认地址） */
  @Column({
    name: 'default_endpoint',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '默认自定义Endpoint（留空则用服务商默认地址）',
  })
  defaultEndpoint!: string | null;

  /** 默认温度参数 0.0-2.0 */
  @Column({
    name: 'default_temperature',
    type: 'decimal',
    precision: 2,
    scale: 1,
    default: 0.3,
    comment: '默认温度参数 0.0-2.0',
  })
  defaultTemperature!: number;

  /** 默认最大Token数 */
  @Column({
    name: 'default_max_tokens',
    type: 'int',
    default: 2048,
    comment: '默认最大Token数',
  })
  defaultMaxTokens!: number;

  /** 默认系统提示词 */
  @Column({
    name: 'default_system_prompt',
    type: 'text',
    nullable: true,
    comment: '默认系统提示词',
  })
  defaultSystemPrompt!: string | null;

  /** 本地 Ollama 兜底开关（P1-3：云端不可用时自动降级本地，默认开启） */
  @Column({
    name: 'ollama_fallback_enabled',
    type: 'tinyint',
    default: 1,
    comment: '本地 Ollama 兜底开关：1=开启 0=关闭',
  })
  ollamaFallbackEnabled!: number;

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
