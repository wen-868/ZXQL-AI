/**
 * 办公批次 2 · 待办（t_ai_todo）—— R101-AI-37 步骤 1
 *
 * 归属：办公第五业务域（standalone 即可用）。权限走**通用 ACL**（`t_ai_acl`，resource_type='todo'）。
 *
 * 防重语义（与文档中心同族，但按语义选）：
 * - **重复建单**：唯一键 `(tenant_id, title, assignee, due_at)`（DB 层）+ 业务幂等
 *   `(tenant_id, title, assignee)` 且 `status NOT IN ('done','cancelled')`（应用层，兜住 NULL 语义差异）
 * - **重复完成**：`UPDATE ... WHERE status <> 'done'` **原子判定**（不先读后写），影响行数 0 ⇒ 回放
 * - **不做版本乐观锁**（协作清单：多人各自改标题/截止是正常操作，强锁会变用户障碍）；
 *   且 `aiTodoUpdate` **不接受 status** ⇒ 状态变更只能走 complete/cancel（堵住绕过幂等）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 待办状态 */
export type TodoStatus = 'pending' | 'in_progress' | 'done' | 'cancelled';
/** 优先级 */
export type TodoPriority = 'low' | 'normal' | 'high';
/** 来源 */
export type TodoSource = 'user' | 'ai' | 'employee';

@Entity('t_ai_todo')
@Index('idx_ai_todo_assignee_status', ['tenantId', 'assignee', 'status'])
@Index('idx_ai_todo_due_at', ['tenantId', 'dueAt'])
@Index('uk_ai_todo_dedupe', ['tenantId', 'title', 'assignee', 'dueAt'], {
  unique: true,
})
export class AiTodoEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '待办标题' })
  title!: string;

  @Column({
    name: 'description',
    type: dialectColumnType('mediumtext', 'text'),
    nullable: true,
    comment: '详细说明（可空）',
  })
  description!: string | null;

  @Column({
    name: 'assignee',
    type: 'varchar',
    length: 128,
    comment: '负责人（principal：user:{id} 或 employee:{id}）',
  })
  assignee!: string;

  @Column({
    name: 'status',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['pending', 'in_progress', 'done', 'cancelled'],
    default: 'pending',
    comment: '状态：pending/in_progress/done/cancelled',
  })
  status!: TodoStatus;

  @Column({
    name: 'priority',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['low', 'normal', 'high'],
    default: 'normal',
    comment: '优先级',
  })
  priority!: TodoPriority;

  @Column({
    name: 'due_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '截止时间（可空；参与建单幂等键）',
  })
  dueAt!: Date | null;

  @Column({
    name: 'source',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['user', 'ai', 'employee'],
    default: 'user',
    comment: '来源：user=用户、ai=AI 拆解/生成、employee=数字员工',
  })
  source!: TodoSource;

  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '创建者（用户/数字员工标识）',
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
