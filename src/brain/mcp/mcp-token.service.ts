/**
 * McpTokenService — MCP 对接 Token 管理（P0-3）
 *
 * 依据：权威文档 14.3/14.4——总台配置「MCP 对接 Token」，
 * 每个 Token 绑定一个租户，第三方客户端携带 Token 调用 MCP 接口，
 * 底座验证 Token 后注入 tenantId 到 TenantContext。
 *
 * 职责：
 * 1. 生成 Token（mcp_ 前缀，32 字节随机，唯一）
 * 2. 列表（总台全量 / 按租户）
 * 3. 启停 / 删除
 * 4. 校验：enabled=1 且未过期（expires_at 为 NULL 表示永不过期）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { McpTokenEntity } from '../../database/entities/mcp-token.entity';

/** 创建 Token 输入 */
export interface CreateMcpTokenInput {
  /** 绑定的租户 ID */
  tenantId: string;
  /** 标识名称（如"WorkBuddy对接"） */
  name?: string;
  /** 过期时间（不传=永不过期） */
  expiresAt?: Date;
}

@Injectable()
export class McpTokenService {
  private readonly logger = new Logger(McpTokenService.name);

  constructor(
    @InjectRepository(McpTokenEntity)
    private readonly repo: Repository<McpTokenEntity>,
  ) {}

  /**
   * 生成 MCP Token（mcp_ + 32 字节随机 hex，共 66 字符）
   *
   * @param input 创建输入
   * @returns 新建的 Token 实体（token 明文仅本次返回，供交付第三方）
   */
  async create(input: CreateMcpTokenInput): Promise<McpTokenEntity> {
    const token = `mcp_${randomBytes(32).toString('hex')}`;
    const entity = this.repo.create({
      tenantId: input.tenantId,
      token,
      name: input.name ?? null,
      enabled: 1,
      expiresAt: input.expiresAt ?? null,
    });
    const saved = await this.repo.save(entity);
    this.logger.log(
      `MCP Token 已生成：id=${saved.id} tenant=${input.tenantId} name=${input.name ?? '未命名'}`,
    );
    return saved;
  }

  /**
   * 列表（总台全量，可过滤租户）
   *
   * @param tenantId 可选租户过滤
   */
  async list(tenantId?: string): Promise<McpTokenEntity[]> {
    const qb = this.repo.createQueryBuilder('t').orderBy('t.id', 'DESC');
    if (tenantId) {
      qb.where('t.tenant_id = :tenantId', { tenantId });
    }
    return qb.getMany();
  }

  /**
   * 启停 Token
   *
   * @param id      Token ID
   * @param enabled 1=启用 0=停用
   * @returns 是否更新成功
   */
  async setEnabled(id: number, enabled: boolean): Promise<boolean> {
    const result = await this.repo.update(id, { enabled: enabled ? 1 : 0 });
    if (result.affected && result.affected > 0) {
      this.logger.log(`MCP Token 已${enabled ? '启用' : '停用'}：id=${id}`);
      return true;
    }
    return false;
  }

  /**
   * 删除 Token
   *
   * @param id Token ID
   * @returns 是否删除成功
   */
  async remove(id: number): Promise<boolean> {
    const result = await this.repo.delete(id);
    if (result.affected && result.affected > 0) {
      this.logger.warn(`MCP Token 已删除：id=${id}`);
      return true;
    }
    return false;
  }

  /**
   * 校验 Token：存在 + enabled=1 + 未过期
   *
   * @param token MCP Token 明文
   * @returns 有效返回 Token 实体；无效返回 null
   */
  async validate(token: string): Promise<McpTokenEntity | null> {
    const trimmed = token?.trim();
    if (!trimmed) {
      return null;
    }
    const entity = await this.repo.findOne({ where: { token: trimmed } });
    if (!entity) {
      return null;
    }
    if (entity.enabled !== 1) {
      return null;
    }
    if (entity.expiresAt && entity.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return entity;
  }
}
