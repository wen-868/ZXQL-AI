/**
 * 文档中心 · 文档 ACL（t_ai_doc_acl）—— R101-AI-35 S1
 *
 * 本批重点：**10 人共享文档的基础权限**（user / role / employee × read / write / admin）。
 *
 * 语义（S2 工具层落实）：
 * - 无 ACL 行 ⇒ 仅 owner 与平台管理员可读（**默认拒绝**，不做"无行即可见"的宽松解释）
 * - 有 `read` ⇒ 可读；`write` ⇒ 可改；`admin` ⇒ 可改 ACL / 归档
 * - 租户隔离优先级**高于** ACL：先按 tenant_id 过滤，再判 ACL（S4 反测覆盖）
 *
 * 唯一键 `(doc_id, principal_type, principal_id)` ⇒ 同一主体对同一文档只有一条授权（可复跑 upsert）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 授权主体类型 */
export type DocPrincipalType = 'user' | 'role' | 'employee';
/** 权限级别 */
export type DocPerm = 'read' | 'write' | 'admin';

@Entity('t_ai_doc_acl')
@Index('idx_ai_doc_acl_doc', ['docId'])
@Index('idx_ai_doc_acl_principal', ['tenantId', 'principalType', 'principalId'])
@Index('uk_ai_doc_acl_principal', ['docId', 'principalType', 'principalId'], {
  unique: true,
})
export class AiDocAclEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 36,
    comment: '租户ID（与文档一致；冗余在此便于"先租户后 ACL"的单表过滤）',
  })
  tenantId!: string;

  @Column({ name: 'doc_id', type: 'bigint', comment: '文档ID（t_ai_doc.id）' })
  docId!: string;

  @Column({
    name: 'principal_type',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['user', 'role', 'employee'],
    comment: '主体类型：user=用户、role=角色、employee=数字员工',
  })
  principalType!: DocPrincipalType;

  @Column({
    name: 'principal_id',
    type: 'varchar',
    length: 64,
    comment: '主体ID（用户/角色/员工的标识）',
  })
  principalId!: string;

  @Column({
    name: 'perm',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['read', 'write', 'admin'],
    default: 'read',
    comment: '权限：read=只读、write=可改、admin=可管理（含改 ACL/归档）',
  })
  perm!: DocPerm;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '授权时间（保留毫秒）',
  })
  createdAt!: Date;
}
