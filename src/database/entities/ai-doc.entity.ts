/**
 * 文档中心 · 文档主表（t_ai_doc）—— R101-AI-35 S1
 *
 * 办公能力第五业务域（standalone 即可用，不依赖 MS/OPS）：给既有 RAG 能力补**管理面**。
 * 本实体是文档的"目录/元数据/归属/状态"真相源；分块与向量仍由 RAG 既有链路负责
 * （`t_ai_knowledge_chunks`，见 migrations/018 与 vector-store.service.ts）。
 *
 * 关键约定：
 * - 双形态类型适配（R101-AI-30）：`dialectColumnType(...)` + `primaryGeneratedColumn(...)`
 *   ⇒ connected(MySQL) 与 standalone(sqlite) 都能建表
 * - `(tenant_id, content_hash)` **唯一** ⇒ 同租户同内容不重复入库（写幂等的 DB 层兜底）
 * - 状态/来源用 enum（sqlite 侧自动降级 varchar，见 dialect.ts F8）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Column, Entity, Index } from 'typeorm';
import { dialectColumnType, primaryGeneratedColumn } from '../dialect';

@Entity('t_ai_doc')
@Index('idx_ai_doc_tenant_category', ['tenantId', 'category'])
@Index('idx_ai_doc_tenant_status', ['tenantId', 'status'])
@Index('uk_ai_doc_tenant_hash', ['tenantId', 'contentHash'], { unique: true })
export class AiDocEntity {
  @primaryGeneratedColumn('bigint', { comment: '主键ID' })
  id!: string;

  @Column({ name: 'tenant_id', type: 'varchar', length: 36, comment: '租户ID' })
  tenantId!: string;

  @Column({ name: 'title', type: 'varchar', length: 255, comment: '文档标题' })
  title!: string;

  @Column({
    name: 'category',
    type: 'varchar',
    length: 64,
    default: 'default',
    comment: '目录（分类）：如 contract/policy/manual',
  })
  category!: string;

  @Column({
    name: 'owner',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '文档所有者（用户标识）',
  })
  owner!: string | null;

  @Column({
    name: 'source_type',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['upload', 'generated'],
    default: 'upload',
    comment: '来源：upload=上传文件、generated=AI 生成内容',
  })
  sourceType!: 'upload' | 'generated';

  @Column({
    name: 'content_hash',
    type: 'varchar',
    length: 64,
    comment: '内容哈希（sha256；与 tenant_id 组成唯一键，幂等依据）',
  })
  contentHash!: string;

  @Column({
    name: 'storage_path',
    type: 'varchar',
    length: 512,
    nullable: true,
    comment: '原始文件路径（source_type=upload 时）',
  })
  storagePath!: string | null;

  @Column({
    name: 'status',
    type: dialectColumnType('enum', 'varchar'),
    enum: ['active', 'archived'],
    default: 'active',
    comment: '状态：active=可检索、archived=已归档（不参与检索）',
  })
  status!: 'active' | 'archived';

  @Column({
    name: 'version',
    type: 'int',
    default: 1,
    comment: '版本号（内容更新时递增）',
  })
  version!: number;

  @Column({
    name: 'created_by',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '创建者（用户标识）',
  })
  createdBy!: string | null;

  @Column({
    name: 'created_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '创建时间（保留毫秒）',
  })
  createdAt!: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP',
    comment: '更新时间（保留毫秒）',
  })
  updatedAt!: Date;
}
