/**
 * 文档 ACL 判定服务（Office O1 · R101-AI-35 S2）
 *
 * 设计目标（R101-AI-35）：把权限判定**从工具里抽出来** ⇒ ① 6 个工具共用同一口径
 * ② S4 可直接单测并做 mutation（去掉过滤 ⇒ 红），不必起 HTTP/LLM
 *
 * 判定顺序（**不可颠倒**）：
 *   1. **租户优先**：`doc.tenantId !== ctx.tenantId` ⇒ 一律拒绝（跨租户任何 ACL 都不放行）
 *   2. **owner / 平台**：`doc.owner === principal.id` 或 `ctx.isPlatform` ⇒ admin（全权）
 *   3. **ACL**：查 `t_ai_doc_acl`，匹配 user / role / employee 任一主体，取**最高** perm
 *   4. **无 ACL 行** ⇒ 拒绝（**默认拒绝**，不做"无行即公开"的宽松解释）
 *
 * 数字员工（employee）与角色（role）与用户（user）**同为 principal** ⇒ 10 人 + 10 数字员工共享的基础。
 *
 * 构造依赖只有仓储（无 HTTP / 无 LLM），故可在单测里用轻量桩直接构造。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AiDocAclEntity,
  DocPerm,
  DocPrincipalType,
} from '../database/entities/ai-doc-acl.entity';
import { AiDocEntity } from '../database/entities/ai-doc.entity';

/** 调用方身份（来自 JWT/租户上下文；工具层负责填充） */
export interface DocPrincipal {
  /** 主体类型：user / role / employee */
  type: DocPrincipalType;
  /** 主体 ID */
  id: string;
  /** 该主体所属的**角色**列表（user 才能带；用于 role 维度授权命中） */
  roles?: string[];
  /** 平台身份（跨租户运维）：可读全部租户（除平台外一律受租户限制） */
  isPlatform?: boolean;
}

/** 判定上下文 */
export interface DocAclContext {
  tenantId: string;
  principal: DocPrincipal;
}

/** 权限强弱（用于取最高） */
const PERM_RANK: Record<DocPerm, number> = { read: 1, write: 2, admin: 3 };

/** 权限判定结果 */
export type DocAccess = 'read' | 'write' | 'admin' | 'none';

@Injectable()
export class DocAclService {
  private readonly logger = new Logger(DocAclService.name);

  constructor(
    @InjectRepository(AiDocEntity)
    private readonly docRepo: Repository<AiDocEntity>,
    @InjectRepository(AiDocAclEntity)
    private readonly aclRepo: Repository<AiDocAclEntity>,
  ) {}

  /**
   * 判定某文档对某主体的权限
   *
   * 顺序：租户 → owner/平台 → ACL（取最高）→ 默认拒绝
   */
  async resolve(doc: AiDocEntity, ctx: DocAclContext): Promise<DocAccess> {
    // ① 租户优先：跨租户一律拒绝（平台身份例外，见 ②）
    if (!ctx.principal.isPlatform && doc.tenantId !== ctx.tenantId) {
      return 'none';
    }
    // ② owner / 平台兜底 ⇒ admin
    if (ctx.principal.isPlatform) {
      return 'admin';
    }
    if (doc.owner !== null && doc.owner === ctx.principal.id) {
      return 'admin';
    }

    // ③ ACL：匹配 user / employee（直接主体）+ 该用户的角色
    const principalIds = [
      { type: ctx.principal.type, id: ctx.principal.id },
      ...(ctx.principal.roles ?? []).map((roleId) => ({
        type: 'role',
        id: roleId,
      })),
    ];
    const rows = await this.aclRepo.find({
      where: {
        docId: doc.id,
        tenantId: doc.tenantId,
        principalId: In(principalIds.map((p) => p.id)),
      },
    });
    let best = 0;
    let bestPerm: DocAccess = 'none';
    for (const row of rows) {
      // 主体类型也要匹配（防止 user id 与 role id 同名误命中）
      const matched = principalIds.some(
        (p) => p.type === row.principalType && p.id === row.principalId,
      );
      if (!matched) continue;
      const rank = PERM_RANK[row.perm] ?? 0;
      if (rank > best) {
        best = rank;
        bestPerm = row.perm;
      }
    }
    // ④ 无有效 ACL 行 ⇒ 默认拒绝
    return bestPerm;
  }

  /** 是否可读（含 archived 的只读判定：归档文档仍可读，但不可写） */
  async canRead(doc: AiDocEntity, ctx: DocAclContext): Promise<boolean> {
    return (await this.resolve(doc, ctx)) !== 'none';
  }

  /** 是否可写（write/admin；archived 文档一律不可写） */
  async canWrite(doc: AiDocEntity, ctx: DocAclContext): Promise<boolean> {
    if (doc.status === 'archived') return false;
    const access = await this.resolve(doc, ctx);
    return access === 'write' || access === 'admin';
  }

  /** 是否可管理（改 ACL / 归档等） */
  async canAdmin(doc: AiDocEntity, ctx: DocAclContext): Promise<boolean> {
    return (await this.resolve(doc, ctx)) === 'admin';
  }

  /**
   * 列出该主体**可见的文档**（读工具 `aiDoc.list/get/search` 的统一过滤入口）
   *
   * 实现要点：先按 tenant_id 过滤（**租户优先**），再逐条判 ACL（owner/平台/ACL 命中）。
   * ⇒ 去掉租户条件或 ACL 过滤，反测必红。
   */
  async listVisible(
    ctx: DocAclContext,
    filter: { category?: string; status?: 'active' | 'archived' } = {},
  ): Promise<AiDocEntity[]> {
    const where: Record<string, unknown> = {};
    // 平台身份可跨租户；其余**强制**本租户
    if (!ctx.principal.isPlatform) {
      where.tenantId = ctx.tenantId;
    }
    if (filter.category !== undefined) where.category = filter.category;
    if (filter.status !== undefined) where.status = filter.status;

    const docs = await this.docRepo.find({ where });
    const visible: AiDocEntity[] = [];
    for (const doc of docs) {
      if ((await this.resolve(doc, ctx)) !== 'none') {
        visible.push(doc);
      }
    }
    return visible;
  }

  /** 取单篇并判权（读工具 `aiDoc.get`） */
  async getVisible(
    docId: string,
    ctx: DocAclContext,
  ): Promise<{ doc: AiDocEntity | null; access: DocAccess }> {
    const doc = await this.docRepo.findOne({ where: { id: docId } });
    if (!doc) return { doc: null, access: 'none' };
    const access = await this.resolve(doc, ctx);
    if (access === 'none') {
      // 不泄露"存在但无权"与"不存在"的差别（统一由调用方给同一提示）
      this.logger.warn(
        `文档无权访问：doc=${docId} tenant=${ctx.tenantId} principal=${ctx.principal.type}:${ctx.principal.id}`,
      );
      return { doc: null, access: 'none' };
    }
    return { doc, access };
  }
}
