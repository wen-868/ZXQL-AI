/**
 * AI 待审工单 Entity
 *
 * 对应表: t_ai_review_task（迁移 157）
 * 人工确认闸（P0-4）：高危工具/图节点命中审核点时生成待审工单，
 * 对接现有审核流程，审批通过后 Orchestrator 续跑。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('t_ai_review_task')
export class AiReviewTaskEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  @Index('idx_review_tenant_status')
  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'session_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '图会话ID',
  })
  sessionId!: string | null;

  @Column({
    name: 'graph_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '图ID',
  })
  graphId!: string | null;

  @Column({
    name: 'node_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '触发审核的图节点ID',
  })
  nodeId!: string | null;

  @Column({
    name: 'tool_name',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '触发审核的工具名',
  })
  toolName!: string | null;

  @Column({
    name: 'payload',
    type: 'json',
    nullable: true,
    comment: '审核载荷',
  })
  payload!: Record<string, unknown> | null;

  @Column({
    name: 'status',
    type: 'varchar',
    length: 20,
    default: 'pending',
    comment: 'pending/approved/rejected',
  })
  status!: string;

  @Column({
    name: 'reject_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '驳回原因',
  })
  rejectReason!: string | null;

  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '创建人',
  })
  createdBy!: string | null;

  @Column({
    name: 'reviewed_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '审核人',
  })
  reviewedBy!: string | null;

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

  @Column({
    name: 'reviewed_at',
    type: 'datetime',
    nullable: true,
    comment: '审核时间',
  })
  reviewedAt!: Date | null;
}
