/**
 * 办公域通用 ACL 判定服务（OfficeAclService）—— R101-AI-37 步骤 2
 *
 * 判定顺序（**完全不变**，S2b 起就定下的口径）：
 *   1. **租户优先**：`resource.tenantId !== ctx.tenantId` ⇒ 一律 none（平台身份例外）
 *   2. **owner / 平台** ⇒ admin（owner 为 null 时不生效）
 *   3. **ACL**：按 `(resource_type, resource_id, tenant_id)` 取行，匹配 user/role/employee 主体，取**最高** perm
 *   4. **无 ACL 行 ⇒ 默认拒绝**（不做"无行即公开"）
 *
 * 🔴 **逻辑一份，绝不复制**：待办/审批/日程与文档**共用本类**；差异只在"域包装"
 *   （如文档域 `canWrite` 额外排除 `archived`），域包装里**没有**任何主体/权限判定逻辑。
 *
 * 契约演进（R101-AI-37 步骤 2 收尾）：旧壳 `doc-acl.service.ts` / 旧类名 `DocAclService` 等
 *   **已全部删除**，6 个文档工具与其 spec 已显式迁移到本文件/本类 ⇒ "共用一套 ACL" 在 import 层可见。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15（步骤 2 泛化 2026-10-16）
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AclPrincipalType,
  AclResourceType,
  AiAclEntity,
} from '../database/entities/ai-acl.entity';
import { AiDocEntity } from '../database/entities/ai-doc.entity';

/** 调用方身份（来自 JWT/租户上下文） */
export interface OfficePrincipal {
  type: AclPrincipalType;
  id: string;
  /** 该主体的角色列表（user 才带；用于 role 维度授权命中） */
  roles?: string[];
  /** 平台身份：可跨租户（除平台外一律受租户限制） */
  isPlatform?: boolean;
}

/** 判定上下文 */
export interface OfficeAclContext {
  tenantId: string;
  principal: OfficePrincipal;
}

/** 通用资源引用（判定只需这四要素） */
export interface OfficeResource {
  resourceType: AclResourceType;
  resourceId: string;
  tenantId: string;
  owner: string | null;
}

/** 权限结果 */
export type OfficeAccess = 'read' | 'write' | 'admin' | 'none';

const PERM_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

@Injectable()
export class OfficeAclService {
  private readonly logger = new Logger(OfficeAclService.name);

  constructor(
    @InjectRepository(AiAclEntity)
    private readonly aclRepo: Repository<AiAclEntity>,
    // 仅"文档域便捷包装"使用（listVisible/getVisible）；判定逻辑不使用它
    @InjectRepository(AiDocEntity)
    private readonly docRepo: Repository<AiDocEntity>,
  ) {}

  /** ══════ 通用核心：任意资源 × 任意主体 ══════ */
  async resolveResource(
    resource: OfficeResource,
    ctx: OfficeAclContext,
  ): Promise<OfficeAccess> {
    const principal = ctx.principal;
    // ① 租户优先（**必须与调用方租户比较**；曾误写成 resource 自比 ⇒ 恒真等于无守卫，已修）
    if (!principal.isPlatform && resource.tenantId !== ctx.tenantId) {
      return 'none';
    }
    // ② owner / 平台
    if (principal.isPlatform) return 'admin';
    if (resource.owner !== null && resource.owner === principal.id) {
      return 'admin';
    }

    // ③ ACL（按资源类型 + 资源 ID + 租户）
    const principalIds = [
      { type: principal.type, id: principal.id },
      ...(principal.roles ?? []).map((roleId) => ({
        type: 'role',
        id: roleId,
      })),
    ];
    const rows = await this.aclRepo.find({
      where: {
        tenantId: resource.tenantId,
        resourceType: resource.resourceType,
        resourceId: resource.resourceId,
        principalId: In(principalIds.map((p) => p.id)),
      },
    });
    let best = 0;
    let bestPerm: OfficeAccess = 'none';
    for (const row of rows) {
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
    // ④ 默认拒绝
    return bestPerm;
  }

  async canReadResource(
    resource: OfficeResource,
    ctx: OfficeAclContext,
  ): Promise<boolean> {
    return (await this.resolveResource(resource, ctx)) !== 'none';
  }

  async canWriteResource(
    resource: OfficeResource,
    ctx: OfficeAclContext,
  ): Promise<boolean> {
    const access = await this.resolveResource(resource, ctx);
    return access === 'write' || access === 'admin';
  }

  async canAdminResource(
    resource: OfficeResource,
    ctx: OfficeAclContext,
  ): Promise<boolean> {
    return (await this.resolveResource(resource, ctx)) === 'admin';
  }

  /**
   * 该主体在指定资源类型下**被 ACL 授予**的资源 ID 集合（库层隔离用）
   *
   * 用途（凌舟 R101-AI-37 裁定 ①）：待办列表**必须把 ACL 可见集作为库查询条件**
   * （WHERE tenant_id=? AND (id IN (:...granted) OR creator=me OR assignee=me)），
   * 而不是"先查全量再内存过滤" —— 前者即使过滤被绕过，泄漏面也被库条件限制。
   *
   * ⚠️ 平台身份不适用（调用方跳过 IN 收窄）；owner/creator 短路规则不在本方法内（需资源实体，属域适配）
   */
  async aclGrantedIds(
    resourceType: AclResourceType,
    ctx: OfficeAclContext,
  ): Promise<string[]> {
    const principalIds = [
      { type: ctx.principal.type, id: ctx.principal.id },
      ...(ctx.principal.roles ?? []).map((roleId) => ({
        type: 'role',
        id: roleId,
      })),
    ];
    const rows = await this.aclRepo.find({
      where: {
        tenantId: ctx.tenantId,
        resourceType,
        principalId: In(principalIds.map((p) => p.id)),
      },
    });
    const ids: string[] = [];
    for (const row of rows) {
      const matched = principalIds.some(
        (p) => p.type === row.principalType && p.id === row.principalId,
      );
      if (matched && PERM_RANK[row.perm] >= 1) {
        ids.push(String(row.resourceId));
      }
    }
    return ids;
  }

  /**
   * 过滤出主体可见的资源（通用）；资源由调用方加载 ⇒ 本服务**不碰域仓储**
   * （工具侧仍须调用本方法 ⇒ "结构上不可架空"由工具只依赖 ACL 服务保证）
   */
  async filterVisible<T>(
    resources: T[],
    toResource: (item: T) => OfficeResource,
    ctx: OfficeAclContext,
  ): Promise<T[]> {
    const out: T[] = [];
    for (const item of resources) {
      const resource = toResource(item);
      if ((await this.resolveResource(resource, ctx)) !== 'none') {
        out.push(item);
      }
    }
    return out;
  }

  /** ══════ 文档域便捷包装（薄适配：仅把 doc 映射成通用资源；无判定逻辑） ══════ */

  private docToResource(doc: AiDocEntity): OfficeResource {
    return {
      resourceType: 'doc',
      resourceId: doc.id,
      tenantId: doc.tenantId,
      owner: doc.owner,
    };
  }

  async resolve(
    doc: AiDocEntity,
    ctx: OfficeAclContext,
  ): Promise<OfficeAccess> {
    return this.resolveResource(this.docToResource(doc), ctx);
  }

  async canRead(doc: AiDocEntity, ctx: OfficeAclContext): Promise<boolean> {
    return (await this.resolve(doc, ctx)) !== 'none';
  }

  /** 文档域附加规则：archived ⇒ 不可写（域规则，不是 ACL 判定） */
  async canWrite(doc: AiDocEntity, ctx: OfficeAclContext): Promise<boolean> {
    if (doc.status === 'archived') return false;
    const access = await this.resolve(doc, ctx);
    return access === 'write' || access === 'admin';
  }

  async canAdmin(doc: AiDocEntity, ctx: OfficeAclContext): Promise<boolean> {
    return (await this.resolve(doc, ctx)) === 'admin';
  }

  /** 文档可见列表（先租户、再逐条判权） */
  async listVisible(
    ctx: OfficeAclContext,
    filter: { category?: string; status?: 'active' | 'archived' } = {},
  ): Promise<AiDocEntity[]> {
    const where: Record<string, unknown> = {};
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

  /** 取单篇并判权（无权 ⇒ 返回 null 文档，不泄露"存在但无权"） */
  async getVisible(
    docId: string,
    ctx: OfficeAclContext,
  ): Promise<{ doc: AiDocEntity | null; access: OfficeAccess }> {
    const doc = await this.docRepo.findOne({ where: { id: docId } });
    if (!doc) return { doc: null, access: 'none' };
    const access = await this.resolve(doc, ctx);
    if (access === 'none') {
      this.logger.warn(
        `资源无权访问：doc=${docId} tenant=${ctx.tenantId} principal=${ctx.principal.type}:${ctx.principal.id}`,
      );
      return { doc: null, access: 'none' };
    }
    return { doc, access };
  }
}
