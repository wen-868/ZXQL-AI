/**
 * 办公批次 5 · 站内通知（t_ai_notice）—— R101-AI-40 步骤 1
 *
 * 为什么**不复用 `t_push_log`**（S0 侦察结论，凌舟裁定 ①）：
 * - `t_push_log` **不在本仓**（`012` 仅 ALTER 补 `tenant_id`）⇒ 由既有系统拥有，属**跨线表**，本单不应把它改成业务表
 * - 它是 **append-only 投递审计日志**（含 `status`/`error_msg`）⇒ 加"已读/归档/聚合"会破坏审计语义
 *
 * 定位：通知中心 = **持久化 + 已读/未读 + 归档**，用于补 **"错过推送即丢"**
 * （WebSocket broadcast 尽力而为，用户离线即收不到 ⇒ 站内通知是持久化事实）
 *
 * `dedupe_key` 语义（对照规范 §2.2）：**可空**，而 MySQL/sqlite 对含 NULL 的唯一键**不判重**
 * ⇒ **业务幂等（未读同键 ⇒ 不重复插）承重**；DB 唯一键只作并发兜底。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 通知来源 */
export type NoticeSource = 'biz' | 'schedule' | 'system';

@Entity('t_ai_notice')
@Index('idx_ai_notice_receiver', ['tenantId', 'receiver'])
@Index('idx_ai_notice_unread', ['tenantId', 'readAt'])
@Index('idx_ai_notice_created', ['tenantId', 'createdAt'])
@Index('luk_ai_notice_dedupe', ['tenantId', 'dedupeKey'], { unique: true })
export class AiNoticeEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({
    name: 'receiver',
    type: dialectColumnType('varchar', 'text'),
    length: 1000,
    comment:
      '接收人（**首尾逗号**归一化的 principal 串，如 ",user:u1,role:fin,"；库层 LIKE 边界匹配）',
  })
  receiver!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '通知标题' })
  title!: string;

  @Column({
    name: 'content',
    type: dialectColumnType('mediumtext', 'text'),
    nullable: true,
    comment: '通知正文',
  })
  content!: string | null;

  @Column({
    name: 'type',
    type: 'varchar',
    length: 32,
    comment: '通知类型（复用推送口径：system/order/inventory/marketing…）',
  })
  type!: string;

  @Column({
    name: 'priority',
    type: 'varchar',
    length: 16,
    comment: '优先级（复用推送口径：urgent/important/reminder/suggestion）',
  })
  priority!: string;

  @Column({
    name: 'read_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '已读时间（NULL=未读；标记已读为原子迁移）',
  })
  readAt!: Date | null;

  @Column({
    name: 'archived_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '归档时间（NULL=未归档；归档为原子迁移）',
  })
  archivedAt!: Date | null;

  @Column({
    name: 'source',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['biz', 'schedule', 'system'],
    default: 'system',
    comment: '来源：biz=业务/巡检、schedule=日程提醒、system=系统',
  })
  source!: NoticeSource;

  @Column({
    name: 'ref_id',
    type: 'varchar',
    length: 128,
    nullable: true,
    comment: '关联对象 ID（如日程 ID / 单据号）',
  })
  refId!: string | null;

  @Column({
    name: 'dedupe_key',
    type: 'varchar',
    length: 191,
    nullable: true,
    comment: '去重键（可空 ⇒ 业务幂等承重；DB 唯一键仅并发兜底）',
  })
  dedupeKey!: string | null;

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
