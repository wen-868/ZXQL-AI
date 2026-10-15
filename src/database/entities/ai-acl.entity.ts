/**
 * 通用 ACL（t_ai_acl）—— R101-AI-37 步骤 2（ACL 泛化）
 *
 * 由来：文档中心建表时为 `t_ai_doc_acl`（列 `doc_id`）；待办/审批/日程都需要**同一套权限判定**
 * ⇒ 019 迁移改名/加列：`t_ai_acl` + `resource_id` + `resource_type`（默认 'doc' ⇒ 既有语义不变）。
 * 依据：改名时该表**尚无数据**（0 行）⇒ 零迁移风险（凌舟裁定方案①）。
 *
 * 唯一键 `(resource_type, resource_id, principal_type, principal_id)`
 * —— ⚠️ 旧的 `(doc_id, principal…)` 维度**过窄**：会让 `todo#5` 与 `doc#5` 误判冲突
 *    （019 已换；sqlite applier 亦 DROP 旧索引后重建）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

/** 授权主体类型（user / role / employee —— 数字员工同为 principal） */
export type AclPrincipalType = 'user' | 'role' | 'employee';
/** 权限级别 */
export type AclPerm = 'read' | 'write' | 'admin';
/** 资源类型（办公域通用） */
export type AclResourceType = 'doc' | 'todo' | 'approval' | 'schedule';

@Entity('t_ai_acl')
@Index('idx_ai_acl_resource', ['tenantId', 'resourceType', 'resourceId'])
@Index(
  'uk_ai_acl_principal',
  ['resourceType', 'resourceId', 'principalType', 'principalId'],
  {
    unique: true,
  },
)
export class AiAclEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 36,
    comment: '租户ID（先租户后 ACL 过滤）',
  })
  tenantId!: string;

  @Column({
    name: 'resource_type',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['doc', 'todo', 'approval', 'schedule'],
    default: 'doc',
    comment: '资源类型：doc/todo/approval/schedule',
  })
  resourceType!: AclResourceType;

  @Column({
    name: 'resource_id',
    type: 'bigint',
    comment: '资源ID（对应资源表主键；旧列名 doc_id，019 已改名）',
  })
  resourceId!: string;

  @Column({
    name: 'principal_type',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['user', 'role', 'employee'],
    comment: '主体类型：user=用户、role=角色、employee=数字员工',
  })
  principalType!: AclPrincipalType;

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
    comment: '权限：read=只读、write=可改、admin=可管理',
  })
  perm!: AclPerm;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '授权时间（毫秒）',
  })
  createdAt!: Date;
}
