/**
 * MCP 对接 Token Entity（P0-3）
 *
 * 对应表: t_mcp_token（对齐权威文档 14.4）
 * 用途：第三方 AI 客户端（WorkBuddy 等）通过 MCP 调用 AI 底座工具时的认证凭证。
 * 每个 Token 绑定一个租户，请求时注入 tenantId 到 TenantContext。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('t_mcp_token')
export class McpTokenEntity {
  @PrimaryGeneratedColumn({ type: 'int', comment: '主键ID' })
  id!: number;

  /** 绑定的租户 ID */
  @Index('idx_mcp_tenant')
  @Column({
    name: 'tenant_id',
    type: 'varchar',
    length: 32,
    comment: '绑定的租户 ID',
  })
  tenantId!: string;

  /** MCP Token（唯一） */
  @Index('uk_mcp_token', { unique: true })
  @Column({
    name: 'token',
    type: 'varchar',
    length: 128,
    comment: 'MCP Token',
  })
  token!: string;

  /** 标识名称（如"WorkBuddy对接"） */
  @Column({
    name: 'name',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '标识名称',
  })
  name!: string | null;

  /** 是否启用：1=启用 0=停用 */
  @Column({
    name: 'enabled',
    type: 'tinyint',
    default: 1,
    comment: '是否启用：1=启用 0=停用',
  })
  enabled!: number;

  /** 过期时间（NULL=永不过期） */
  @Column({
    name: 'expires_at',
    type: 'datetime',
    nullable: true,
    comment: '过期时间（NULL=永不过期）',
  })
  expiresAt!: Date | null;

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
