/**
 * AI 进化版本 Entity（ai_db 独立库，P1-1）
 *
 * 对应表: ai_evolution_version（文档 26.4）
 * Schema/模板/话术版本化指针：DB 只记录 artifact 的 from/to 版本号与变更摘要，
 * 内容本体存于代码常量（write-schema-registry 等），回滚按版本号定位代码常量还原，
 * 避免与代码漂移。status：staged → active / rolled_back（人工确认，不静默改红线）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_evolution_version')
export class AiEvolutionVersionEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true, comment: '主键ID' })
  id!: number;

  /** 制品（如 write_schema.customer_create / attr_template.margin） */
  @Index('idx_evv_artifact')
  @Column({
    name: 'artifact',
    type: 'varchar',
    length: 64,
    comment: '制品标识',
  })
  artifact!: string;

  /** 变更前版本 */
  @Column({
    name: 'from_version',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '变更前版本',
  })
  fromVersion!: string | null;

  /** 变更后版本 */
  @Column({
    name: 'to_version',
    type: 'varchar',
    length: 32,
    comment: '变更后版本',
  })
  toVersion!: string;

  /** 变更摘要（"为什么改、改了什么"） */
  @Column({
    name: 'change_summary',
    type: 'text',
    nullable: true,
    comment: '变更摘要',
  })
  changeSummary!: string | null;

  /** 触发方式：auto_learn=自动学习 / manual=人工 */
  @Column({
    name: 'trigger',
    type: 'varchar',
    length: 16,
    default: 'auto_learn',
    comment: '触发方式：auto_learn/manual',
  })
  trigger!: string;

  /** 状态：staged → active / rolled_back */
  @Index('idx_evv_status')
  @Column({
    name: 'status',
    type: 'varchar',
    length: 16,
    default: 'staged',
    comment: '状态：staged/active/rolled_back',
  })
  status!: string;

  /** 审批人 */
  @Column({
    name: 'approved_by',
    type: 'varchar',
    length: 32,
    nullable: true,
    comment: '审批人',
  })
  approvedBy!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间',
  })
  createdAt!: Date;
}
