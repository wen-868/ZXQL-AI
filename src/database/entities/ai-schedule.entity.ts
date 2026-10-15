/**
 * 办公批次 4 · 日程（t_ai_schedule）—— R101-AI-39 步骤 1
 *
 * 边界（本批不做）：**重复日程（recurrence）**、日程共享/代管、外部日历同步
 * 权限：复用 `OfficeAclService`（`resourceType='schedule'`）；参与者亦为 ACL 主体
 *
 * 幂等键设计（对照规范 §2.2「唯一键含可空列 ⇒ 业务层承重」）：
 * - 唯一键刻意选 **全部 NOT NULL** 的四列：`(tenant_id, title, owner, start_at)`
 *   ⇒ **DB 层对本表是有效防线**（不像 `due_at`/`related_biz` 那样因 NULL 不判重）
 * - 仍保留业务层前置检查（同键 + 未终态 ⇒ 回放）作**双层**：DB 挡并发、业务层挡"日常重复提交"
 * - ⚠️ `end_at` / `remind_at` **可空且不参与唯一键**，故它们的空值不影响判重
 *
 * 提醒（S0 结论）：复用既有 `ProactivePushService.push` + `ProactiveService` 的 `@Cron` 框架，
 * **不新建调度/推送通道**；到期扫描需要 **`reminded_at` 标记列**做幂等（避免重复提醒）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 日程状态（planned → done | cancelled，均为终态） */
export type ScheduleStatus = 'planned' | 'done' | 'cancelled';
/** 来源 */
export type ScheduleSource = 'user' | 'ai' | 'employee';

@Entity('t_ai_schedule')
@Index('idx_ai_schedule_start_at', ['tenantId', 'startAt'])
@Index('idx_ai_schedule_owner_status', ['tenantId', 'owner', 'status'])
@Index('idx_ai_schedule_remind', ['tenantId', 'status', 'remindAt'])
@Index('luk_ai_schedule_dedupe', ['tenantId', 'title', 'owner', 'startAt'], {
  unique: true,
})
export class AiScheduleEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '日程标题' })
  title!: string;

  @Column({
    name: 'start_at',
    type: 'datetime',
    precision: 3,
    comment: '开始时间（毫秒；唯一键组成部分）',
  })
  startAt!: Date;

  @Column({
    name: 'end_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '结束时间（可空；不参与唯一键）',
  })
  endAt!: Date | null;

  @Column({
    name: 'owner',
    type: 'varchar',
    length: 128,
    comment: '归属人（principal：user:{id}/employee:{id}）—— 也是 ACL owner',
  })
  owner!: string;

  @Column({
    name: 'participants',
    type: dialectColumnType('varchar', 'text'),
    length: 1000,
    nullable: true,
    comment:
      '参与者（逗号分隔 principal：user:/role:/employee:）—— 亦为 ACL 主体',
  })
  participants!: string | null;

  @Column({
    name: 'status',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['planned', 'done', 'cancelled'],
    default: 'planned',
    comment: '状态：planned（可改/可完成/可取消）→ done | cancelled（终态）',
  })
  status!: ScheduleStatus;

  @Column({
    name: 'remind_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '提醒时间（可空；到期由定时扫描推送）',
  })
  remindAt!: Date | null;

  @Column({
    name: 'reminded_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '已提醒时间（幂等标记：非空即不再重复提醒）',
  })
  remindedAt!: Date | null;

  @Column({
    name: 'source',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['user', 'ai', 'employee'],
    default: 'ai',
    comment: '来源：user/ai/employee',
  })
  source!: ScheduleSource;

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
