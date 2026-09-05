/**
 * McpTokenService — MCP 对接 Token 管理（P0-3）
 *
 * 依据：权威文档 14.3/14.4——总台配置「MCP 对接 Token」，
 * 每个 Token 绑定一个租户，第三方客户端携带 Token 调用 MCP 接口，
 * 底座验证 Token 后注入 tenantId 到 TenantContext。
 *
 * 职责：
 * 1. 生成 Token（mcp_ 前缀，32 字节随机，唯一；库中只存 SHA-256 哈希，明文仅创建时返回一次）
 * 2. 列表（总台全量 / 按租户；返回前脱敏）
 * 3. 启停 / 删除
 * 4. 校验：enabled=1 且未过期（expires_at 为 NULL 表示永不过期）
 *
 * 安全（2026-09-05 全面审查 H2 修复）：
 * - 存储改为 SHA-256 哈希（此前明文入库，DB 泄露即得全部租户凭证）
 * - 校验先按哈希查找；历史明文 token 命中后惰性升级为哈希（无需停机迁移）
 * - 列表返回脱敏 token（防总台页面/日志二次泄露）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-09-05 哈希存储+脱敏
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
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

/** 创建 Token 结果：entity 已存哈希；plaintext 明文仅本次返回，交付第三方后不可再取 */
export interface CreateMcpTokenResult {
  entity: McpTokenEntity;
  plaintext: string;
}

/** 列表/对外展示用脱敏：保留首 4 位 + 尾 4 位 */
export function maskToken(token: string): string {
  if (token.length <= 8) {
    return '****';
  }
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

@Injectable()
export class McpTokenService {
  private readonly logger = new Logger(McpTokenService.name);

  constructor(
    @InjectRepository(McpTokenEntity)
    private readonly repo: Repository<McpTokenEntity>,
  ) {}

  /** SHA-256 哈希（库中只存哈希，不存明文） */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * 生成 MCP Token（mcp_ + 32 字节随机 hex，共 66 字符）
   *
   * @param input 创建输入
   * @returns entity（token 列已是哈希）+ plaintext 明文（仅本次返回，供交付第三方）
   */
  async create(input: CreateMcpTokenInput): Promise<CreateMcpTokenResult> {
    const plaintext = `mcp_${randomBytes(32).toString('hex')}`;
    const entity = await this.repo.save(
      this.repo.create({
        tenantId: input.tenantId,
        token: this.hashToken(plaintext),
        name: input.name ?? null,
        enabled: 1,
        expiresAt: input.expiresAt ?? null,
      }),
    );
    this.logger.log(
      `MCP Token 已生成：id=${entity.id} tenant=${input.tenantId} name=${input.name ?? '未命名'}（库中存哈希）`,
    );
    return { entity, plaintext };
  }

  /**
   * 列表（总台全量，可过滤租户；token 脱敏后返回）
   *
   * @param tenantId 可选租户过滤
   */
  async list(tenantId?: string): Promise<McpTokenEntity[]> {
    const qb = this.repo.createQueryBuilder('t').orderBy('t.id', 'DESC');
    if (tenantId) {
      qb.where('t.tenant_id = :tenantId', { tenantId });
    }
    const items = await qb.getMany();
    // 脱敏：列表不返回完整哈希/明文，防总台页面与日志二次泄露
    return items.map((item) => ({ ...item, token: maskToken(item.token) }));
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
   * 查找顺序：SHA-256 哈希 → 历史明文（哈希化前创建的存量 token，
   * 命中即惰性升级为哈希存储，无需停机迁移）。
   *
   * @param token MCP Token 明文
   * @returns 有效返回 Token 实体（token 列为哈希）；无效返回 null
   */
  async validate(token: string): Promise<McpTokenEntity | null> {
    const trimmed = token?.trim();
    if (!trimmed) {
      return null;
    }

    const hashed = this.hashToken(trimmed);
    let entity = await this.repo.findOne({ where: { token: hashed } });

    if (!entity) {
      const legacy = await this.repo.findOne({ where: { token: trimmed } });
      if (legacy) {
        await this.repo.update(legacy.id, { token: hashed });
        this.logger.log(
          `MCP Token 命中历史明文，已惰性升级为哈希存储：id=${legacy.id}`,
        );
        entity = { ...legacy, token: hashed };
      }
    }

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
