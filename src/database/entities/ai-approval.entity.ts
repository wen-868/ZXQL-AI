/**
 * 办公批次 3 · 审批实例（t_ai_approval）—— R101-AI-38 步骤 1
 *
 * 边界（**重要**，凌舟 R101-AI-38 裁定）：
 * - 本表是 **AI 底座原生轻量审批**（AI 辅助填单 + 人审批，standalone 可用）
 * - **不替代、不重复造 MS 审批**（MS 侧已有 `api_query_approval_*`）；本批**不做**与 MS 审批打通
 *   （跨线议题，独立立项）
 * - **单级审批**（一个审批人）；多级/会签**本批不做**（需业主确认，已登记缺口）
 *
 * 状态机（本批核心）：
 *   draft ──提交──> pending ──审批──> approved | rejected（**终态，一次实例只产生一次结果**）
 *                        └──撤回──> cancelled（仅 pending 可撤）
 * 🔴 状态迁移一律**原子**：`UPDATE ... WHERE status='pending'` ⇒ affected=0 ⇒ 明确失败/回放（不先读后写）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 审批状态 */
export type ApprovalStatus =
  'draft' | 'pending' | 'approved' | 'rejected' | 'cancelled';

@Entity('t_ai_approval')
@Index('idx_ai_approval_status', ['tenantId', 'status'])
@Index('idx_ai_approval_applicant', ['tenantId', 'applicant'])
@Index('idx_ai_approval_approver', ['tenantId', 'approver', 'status'])
@Index(
  'uk_ai_approval_dedupe',
  ['tenantId', 'applicant', 'type', 'relatedBiz'],
  {
    unique: true,
  },
)
export class AiApprovalEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '审批标题' })
  title!: string;

  @Column({
    name: 'type',
    type: 'varchar',
    length: 64,
    comment: '审批类型：expense/leave/purchase/other（自由文本，便于扩展）',
  })
  type!: string;

  @Column({
    name: 'applicant',
    type: 'varchar',
    length: 128,
    comment:
      '申请人（principal：user:{id} 或 employee:{id}）—— 也是 ACL 的 owner',
  })
  applicant!: string;

  @Column({
    name: 'approver',
    type: 'varchar',
    length: 128,
    comment:
      '审批人（principal：user:{id} / role:{id} / employee:{id}）—— 单级',
  })
  approver!: string;

  @Column({
    name: 'status',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['draft', 'pending', 'approved', 'rejected', 'cancelled'],
    default: 'draft',
    comment:
      '状态：draft/pending/approved/rejected/cancelled（后三者为终态之二，cancelled 仅 pending 可入）',
  })
  status!: ApprovalStatus;

  @Column({
    name: 'payload',
    type: dialectColumnType('mediumtext', 'text'),
    nullable: true,
    comment: '申请内容（JSON 文本，AI 辅助填单）',
  })
  payload!: string | null;

  @Column({
    name: 'decision_reason',
    type: 'varchar',
    length: 500,
    nullable: true,
    comment: '审批意见（通过/驳回理由）',
  })
  decisionReason!: string | null;

  @Column({
    name: 'related_biz',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '关联业务单据（幂等键组成部分：申请人+类型+关联单据）',
  })
  relatedBiz!: string | null;

  @Column({
    name: 'deleted_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment:
      '软删时间（**仅草稿可弃**；NULL=未弃；R101-AI-41 迁移 023 / sqlite 增量 006）',
  })
  deletedAt!: Date | null;

  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '创建者',
  })
  createdBy!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间（毫秒）',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '更新时间（毫秒）',
  })
  updatedAt!: Date;
}
