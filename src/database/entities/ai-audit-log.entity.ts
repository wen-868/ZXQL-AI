/**
 * AI调用审计日志 Entity
 *
 * 对应表: t_ai_audit_log
 * 每次AI调用1条明细，高频写入表，支撑租户+时间范围查询与审计回溯
 * 字段定义依据《智享AI底座-架构设计文档》v3.2 第7.1节
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_audit_log')
@Index('idx_tenant_id', ['tenantId'])
@Index('idx_created_at', ['createdAt'])
@Index('idx_tenant_created', ['tenantId', 'createdAt'])
@Index('idx_session', ['sessionId'])
export class AiAuditLogEntity {
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

  /** 用户ID */
  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 36,
    nullable: true,
    comment: '用户ID',
  })
  userId!: string | null;

  /** 会话ID */
  @Column({
    name: 'session_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '会话ID',
  })
  sessionId!: string | null;

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

  /** 意图标签 */
  @Column({
    name: 'intent',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '意图标签',
  })
  intent!: string | null;

  /** 用户消息原文 */
  @Column({
    name: 'user_message',
    type: 'text',
    nullable: true,
    comment: '用户消息原文',
  })
  userMessage!: string | null;

  /** 工具调用记录（JSON数组） */
  @Column({
    name: 'tool_calls',
    type: 'json',
    nullable: true,
    comment: '工具调用记录（JSON数组）',
  })
  toolCalls!: Record<string, unknown>[] | null;

  /** 提示Token数 */
  @Column({
    name: 'prompt_tokens',
    type: 'int',
    default: 0,
    comment: '提示Token数',
  })
  promptTokens!: number;

  /** 完成Token数 */
  @Column({
    name: 'completion_tokens',
    type: 'int',
    default: 0,
    comment: '完成Token数',
  })
  completionTokens!: number;

  /** 本次调用延迟毫秒 */
  @Column({
    name: 'latency_ms',
    type: 'int',
    nullable: true,
    comment: '本次调用延迟毫秒',
  })
  latencyMs!: number | null;

  /** 是否成功: 1=成功 0=失败 */
  @Column({
    name: 'success',
    type: 'tinyint',
    default: 1,
    comment: '是否成功: 1=成功 0=失败',
  })
  success!: number;

  /** 错误信息（失败时记录） */
  @Column({
    name: 'error_message',
    type: 'text',
    nullable: true,
    comment: '错误信息（失败时记录）',
  })
  errorMessage!: string | null;

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
