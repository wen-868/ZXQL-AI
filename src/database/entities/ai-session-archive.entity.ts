/**
 * AI 会话冷备归档 Entity（A4，文档 12.5）
 *
 * 对应表: t_ai_session_archive
 * L2 冷存储：Redis 热记忆（1h TTL）之外的完整对话历史归档，
 * 供审计回溯与用户查看历史（保留 90 天后归档清理）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('t_ai_session_archive')
export class AiSessionArchiveEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 会话 ID */
  @Index('idx_archive_session')
  @Column({
    name: 'session_id',
    type: 'varchar',
    length: 64,
    comment: '会话 ID',
  })
  sessionId!: string;

  /** 租户 ID */
  @Index('idx_archive_tenant_user')
  @Column({ name: 'tenant_id', type: 'varchar', length: 32, comment: '租户ID' })
  tenantId!: string;

  /** 用户 ID */
  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '用户 ID',
  })
  userId!: string | null;

  /** 完整对话消息（JSON 数组） */
  @Column({
    name: 'messages_json',
    type: 'json',
    nullable: true,
    comment: '完整对话消息',
  })
  messagesJson!: Array<Record<string, unknown>> | null;

  /** 消息条数 */
  @Column({
    name: 'message_count',
    type: 'int',
    default: 0,
    comment: '消息条数',
  })
  messageCount!: number;

  /** 会话开始时间 */
  @Column({
    name: 'started_at',
    type: 'datetime',
    nullable: true,
    comment: '会话开始时间',
  })
  startedAt!: Date | null;

  /** 最后活跃时间 */
  @Column({
    name: 'ended_at',
    type: 'datetime',
    nullable: true,
    comment: '最后活跃时间',
  })
  endedAt!: Date | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
