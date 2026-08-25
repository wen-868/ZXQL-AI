/**
 * 自主任务计划 Entity（批次2，文档 22.7）
 *
 * 对应表: ai_execution_plan（业务库侧，总平台）
 * 用途：Agent 自主执行内核的长任务持久化——目标、步骤（JSON PlanStep[]）、
 * 计划级状态（pending/running/success/failed/suspended/skipped 六态），
 * 支持断点续跑（进程重启恢复 pending/running）、人工介入（suspended 审批恢复）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** 计划/步骤六态（文档 22.4 统一口径） */
export type PlanState =
  'pending' | 'running' | 'success' | 'failed' | 'suspended' | 'skipped';

@Entity('ai_execution_plan')
export class AiExecutionPlanEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '主键ID' })
  id!: number;

  /** 租户 ID */
  @Index('idx_tenant')
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 32,
    comment: '租户ID',
  })
  tenantId!: string;

  /** 任务目标（复合目标描述） */
  @Column({
    name: 'goal',
    type: 'text',
    nullable: true,
    comment: '任务目标',
  })
  goal!: string | null;

  /** 步骤（JSON: PlanStep[]，每步含六态 status） */
  @Column({
    name: 'steps',
    type: 'text',
    nullable: true,
    comment: '步骤 JSON（PlanStep[]）',
  })
  steps!: string | null;

  /** 计划级状态（与步骤级六态一致，见 22.4） */
  @Column({
    name: 'state',
    type: 'enum',
    enum: ['pending', 'running', 'success', 'failed', 'suspended', 'skipped'],
    default: 'pending',
    comment: '计划状态：pending/running/success/failed/suspended/skipped',
  })
  state!: PlanState;

  /** 创建人 */
  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '创建人',
  })
  createdBy!: string | null;

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
