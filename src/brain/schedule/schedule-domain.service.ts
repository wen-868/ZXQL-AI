/**
 * ScheduleDomainService —— 日程**唯一领域服务**（AI-P2-2 §四.2/§五.7）
 *
 * 为什么必须唯一：卡面 §五.7「AI 工具与人工入口共用同一 DTO、权限、租户过滤、审计和
 * 领域服务，**禁止平行实现**」。改造前 5 个工具各自注入 Repository、各自写权限判定
 * （`schedule-state.base.ts` 的 `canOperate`、list 的 LIKE 条件、update 的 ACL 调用）
 * ⇒ 人工入口若再写一份，就是三份口径。本服务把**读/写/预览/展开/作用域**全部收口。
 *
 * ── 权限矩阵（卡面 §五.1，三档 + 租户硬边界）──────────────────────────
 * | 主体                        | read | write/complete/cancel | admin(改共享范围) |
 * | owner（`user:{id}` 自己）   | ✓    | ✓                     | ✓                 |
 * | platform                    | ✓    | ✓                     | ✓                 |
 * | manager_user_ids 命中       | ✓    | ✓                     | ✗                 |
 * | participants 命中（021 语义）| ✓   | ✗                     | ✗                 |
 * | viewer_roles ∪ viewer_user_ids 命中 | ✓ | ✗              | ✗                 |
 * | 其他                        | ✗    | ✗                     | ✗                 |
 * ⇒ **viewer 绝不可写**（反测 2：把 viewer 当 manager ⇒ 点名红）
 * ⇒ 任何判定**先比租户**，跨租户一律 none（反测：跨租户访问拒绝）
 *
 * ── 共享范围并集（卡面 §五.1）──────────────────────────────────────────
 * `viewer_roles`（角色 id 列表）命中 `principal.roles` ⇒ 只读；
 * `viewer_user_ids` 命中 `principal.id` ⇒ 只读；**两者取并集**（任一命中即可见）。
 * `manager_user_ids` 独立于 viewer（不因 viewer 命中而获得写权）。
 *
 * ── 三作用域（卡面 §四.6/§五.5）─────────────────────────────────────────
 * `single`：只改/取消**该 occurrence**（写 `exception`，不动规则）
 * `following`：从该 occurrence 起拆分系列（老系列 `until` 截断 + 新系列承接）
 * `all`：改/取消**整系列**（取消 ⇒ 全系列 cancelled）
 * ⇒ **不把整系列修改伪装成单次**（反测 5）
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-28
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiScheduleEntity,
  ScheduleStatus,
} from '../../database/entities/ai-schedule.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import {
  expandForPersist,
  parseRecurrenceRule,
  previewNext,
  RecurrenceRule,
} from './recurrence';

/** 访问级别（与卡面三档一致） */
export type ScheduleAccess = 'admin' | 'write' | 'read' | 'none';

/** 作用域（卡面 §四.6） */
export type ScheduleScope = 'single' | 'following' | 'all';

/** 共享范围输入（DTO：人工入口与 AI 工具**共用**） */
export interface ScheduleShareInput {
  viewerRoles?: string[] | null;
  viewerUserIds?: string[] | null;
  managerUserIds?: string[] | null;
}

/** 新建/更新输入（DTO：人工入口与 AI 工具**共用**） */
export interface ScheduleWriteInput {
  title: string;
  startAt: string | Date;
  endAt?: string | Date | null;
  remindAt?: string | Date | null;
  participants?: string | null;
  /** 重复规则：AI 工具入参/HTTP 均为 Partial（由 parseRecurrenceRule 校验+补默认） */
  recurrenceRule?: string | Partial<RecurrenceRule> | null;
  share?: ScheduleShareInput | null;
}

/** 预览结果（人工与 AI 同源 ⇒ 硬验收 6） */
export interface SchedulePreview {
  /** 未来 5 次（ISO 字符串）；单次日程为 [startAt] */
  occurrences: string[];
  /** 是否重复日程 */
  recurring: boolean;
  /** 规范化规则（重复时非空） */
  rule: RecurrenceRule | null;
}

/** 调用者上下文（由工具 ToolContext / HTTP 请求统一构造） */
export interface ScheduleActor {
  tenantId: string;
  principal: OfficePrincipal;
}

/** principal ⇒ `user:{id}` 形态（用于和 owner/viewer 列比对；employee 保持 employee:） */
function principalKey(p: OfficePrincipal): string {
  return `${p.type === 'employee' ? 'employee' : 'user'}:${p.id}`;
}

/** 逗号清单 ⇒ 数组（去空、trim） */
function splitList(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 数组 ⇒ 归一化逗号串（首尾逗号；空 ⇒ null） */
export function normalizeList(list?: string[] | null): string | null {
  if (!list || list.length === 0) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const v = String(item).trim();
    if (v.length === 0 || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length === 0 ? null : `,${out.join(',')},`;
}

@Injectable()
export class ScheduleDomainService {
  private readonly logger = new Logger(ScheduleDomainService.name);

  constructor(
    @InjectRepository(AiScheduleEntity)
    private readonly scheduleRepo: Repository<AiScheduleEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  // ══════════════════ 权限（唯一判定，全部带租户边界）══════════════════

  /**
   * 判定某主体对某日程的访问级别。
   *
   * 顺序即优先级（**先租户、再 admin、再 write、最后 read**）：
   * 1. 租户不等（非平台）⇒ none（跨租户一律拒绝）
   * 2. platform ⇒ admin
   * 3. owner 命中 ⇒ admin（owner 是 ACL owner，可改共享范围）
   * 4. manager_user_ids 命中 ⇒ write（**独立于 viewer**）
   * 5. participants 命中（021 语义：参与人可读）∪ viewer_roles ∪ viewer_user_ids ⇒ read
   * 6. ACL 兜底（既有 OfficeAclService 的 grant，可能有 write/admin）
   * 7. 其余 none
   */
  async resolveAccess(
    schedule: Pick<
      AiScheduleEntity,
      | 'id'
      | 'tenantId'
      | 'owner'
      | 'participants'
      | 'viewerRoles'
      | 'viewerUserIds'
      | 'managerUserIds'
    >,
    actor: ScheduleActor,
  ): Promise<ScheduleAccess> {
    const { principal } = actor;
    // ① 租户边界（先于一切；平台例外）
    if (!principal.isPlatform && schedule.tenantId !== actor.tenantId) {
      return 'none';
    }
    if (principal.isPlatform) return 'admin';

    const me = principalKey(principal);
    // ② owner
    if (schedule.owner === me) return 'admin';

    // ③ 代管（写权）—— 只认 user 形态（manager_user_ids 存的是 user id）
    if (principal.type !== 'employee') {
      const managers = splitList(schedule.managerUserIds);
      if (managers.includes(String(principal.id))) return 'write';
    }

    // ④ 只读面：participants（含角色形态）/ viewer 角色 ∪ 指定人员
    if (this.isReadableBy(schedule, principal, me)) return 'read';

    // ⑤ ACL 兜底（既有授权表；不复制其判定逻辑，只调用）
    const aclAccess = await this.officeAcl.resolveResource(
      {
        resourceType: 'schedule',
        resourceId: schedule.id,
        tenantId: schedule.tenantId,
        owner: schedule.owner,
      },
      { tenantId: actor.tenantId, principal },
    );
    if (aclAccess === 'admin') return 'admin';
    if (aclAccess === 'write') return 'write';
    if (aclAccess === 'read') return 'read';
    return 'none';
  }

  /** 只读面判定（participants ∪ viewer_roles ∪ viewer_user_ids，**并集**） */
  private isReadableBy(
    schedule: Pick<
      AiScheduleEntity,
      'participants' | 'viewerRoles' | 'viewerUserIds'
    >,
    principal: OfficePrincipal,
    me: string,
  ): boolean {
    // participants（021 已交付语义：首尾逗号归一化 ⇒ 边界匹配，无子串误配）
    const parts = splitList(schedule.participants);
    if (parts.includes(me)) return true;
    for (const role of principal.roles ?? []) {
      if (parts.includes(`role:${role}`)) return true;
    }
    // viewer 指定人员
    const viewers = splitList(schedule.viewerUserIds);
    if (
      principal.type !== 'employee' &&
      viewers.includes(String(principal.id))
    ) {
      return true;
    }
    // viewer 角色（并集：与上面任一命中即真）
    const viewerRoles = splitList(schedule.viewerRoles);
    for (const role of principal.roles ?? []) {
      if (viewerRoles.includes(String(role))) return true;
    }
    return false;
  }

  /** 读权断言（不可读 ⇒ 抛错，供上层统一转 404/403） */
  async assertCanRead(
    schedule: AiScheduleEntity,
    actor: ScheduleActor,
  ): Promise<ScheduleAccess> {
    const access = await this.resolveAccess(schedule, actor);
    if (access === 'none') {
      // 统一话术：不泄漏"该日程是否存在"（跨租户/跨人员同一条）
      throw new ScheduleAccessError('无权访问该日程（或不存在）');
    }
    return access;
  }

  /** 写权断言（完成/取消/编辑）；viewer 一律拒绝 */
  async assertCanWrite(
    schedule: AiScheduleEntity,
    actor: ScheduleActor,
  ): Promise<void> {
    const access = await this.assertCanRead(schedule, actor);
    if (access !== 'write' && access !== 'admin') {
      throw new ScheduleAccessError('仅只读权限，不能修改该日程');
    }
  }

  /** admin 断言（改共享范围/整系列删除） */
  async assertCanAdmin(
    schedule: AiScheduleEntity,
    actor: ScheduleActor,
  ): Promise<void> {
    const access = await this.assertCanRead(schedule, actor);
    if (access !== 'admin') {
      throw new ScheduleAccessError('仅归属人可修改共享范围');
    }
  }

  // ══════════════════ 读（库层租户 + 可见性收窄）══════════════════

  /**
   * 列出可见日程——**库层隔离**（不"先查全量再内存过滤"）
   *
   * WHERE tenant_id=? AND (
   *   owner=:me OR manager_user_ids LIKE :mgr OR participants LIKE :me
   *   OR viewer_user_ids LIKE :vid OR viewer_roles LIKE :role...
   *   OR id IN (:aclGranted)
   * )
   */
  async listVisible(
    actor: ScheduleActor,
    opts: {
      from?: Date | null;
      to?: Date | null;
      status?: ScheduleStatus | null;
      limit?: number;
    } = {},
  ): Promise<AiScheduleEntity[]> {
    const { principal } = actor;
    const me = principalKey(principal);
    const where: string[] = ['s.tenant_id = ?'];
    const params: unknown[] = [actor.tenantId];

    if (!principal.isPlatform) {
      const ors: string[] = ['s.owner = ?'];
      params.push(me);
      if (principal.type !== 'employee') {
        ors.push(`s.manager_user_ids LIKE ?`);
        params.push(`%,${principal.id},%`);
        ors.push(`s.viewer_user_ids LIKE ?`);
        params.push(`%,${principal.id},%`);
      }
      ors.push('s.participants LIKE ?');
      params.push(`%,${me},%`);
      for (const role of principal.roles ?? []) {
        ors.push('s.participants LIKE ?');
        params.push(`%,role:${role},%`);
        ors.push('s.viewer_roles LIKE ?');
        params.push(`%,${role},%`);
      }
      // ACL 授权资源（既有机制，库层 IN 收窄）
      const granted = await this.officeAcl.aclGrantedIds('schedule', {
        tenantId: actor.tenantId,
        principal,
      });
      // 角色文本形态与 role id 形态都查（viewer_roles 存 role id）
      if (granted.length > 0) {
        ors.push(`s.id IN (${granted.map(() => '?').join(',')})`);
        params.push(...granted);
      }
      where.push(`(${ors.join(' OR ')})`);
    }

    if (opts.from) {
      where.push('s.start_at >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('s.start_at <= ?');
      params.push(opts.to);
    }
    if (opts.status) {
      where.push('s.status = ?');
      params.push(opts.status);
    }

    const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
    const sql =
      `SELECT s.* FROM t_ai_schedule s WHERE ${where.join(' AND ')} ` +
      `ORDER BY s.start_at ASC, s.id ASC LIMIT ${limit}`;
    const rows: AiScheduleEntity[] = await this.scheduleRepo.query(sql, params);
    return rows.map((r) => this.hydrate(r));
  }

  /** 单条读取（带租户；**不存在/跨租户统一按无权限处理**） */
  async getById(id: string, actor: ScheduleActor): Promise<AiScheduleEntity> {
    const row = await this.scheduleRepo.findOne({
      where: { id: String(id), tenantId: actor.tenantId },
    });
    if (!row) throw new ScheduleAccessError('无权访问该日程（或不存在）');
    await this.assertCanRead(row, actor);
    return row;
  }

  /** raw 行 ⇒ 实体形态（Repository.query 返回的是 plain object） */
  private hydrate(raw: unknown): AiScheduleEntity {
    const r = raw as Record<string, unknown>;
    const e = new AiScheduleEntity();
    Object.assign(e, {
      id: String(r.id),
      tenantId: r.tenant_id,
      title: r.title,
      startAt:
        r.start_at instanceof Date ? r.start_at : new Date(String(r.start_at)),
      endAt: r.end_at ? new Date(String(r.end_at as string | null)) : null,
      owner: r.owner,
      participants: (r.participants as string) ?? null,
      status: r.status,
      remindAt: r.remind_at
        ? new Date(String(r.remind_at as string | null))
        : null,
      remindedAt: r.reminded_at
        ? new Date(String(r.reminded_at as string | null))
        : null,
      source: r.source,
      createdBy: (r.created_by as string) ?? null,
      createdAt: r.created_at
        ? new Date(String(r.created_at as string | null))
        : new Date(),
      updatedAt: r.updated_at
        ? new Date(String(r.updated_at as string | null))
        : new Date(),
      viewerRoles: (r.viewer_roles as string) ?? null,
      viewerUserIds: (r.viewer_user_ids as string) ?? null,
      managerUserIds: (r.manager_user_ids as string) ?? null,
      seriesId: r.series_id ? String(r.series_id as string | null) : null,
      recurrenceRule: (r.recurrence_rule as string) ?? null,
      occurrenceAt: r.occurrence_at
        ? new Date(String(r.occurrence_at as string | null))
        : null,
      exception: (r.exception as string) ?? null,
    });
    return e;
  }

  // ══════════════════ 预览（未来 5 次，AI 与人工同源）══════════════════

  /** 保存前预览（卡面 §五.6：**恰为未来 5 次**） */
  buildPreview(input: ScheduleWriteInput): SchedulePreview {
    const startMs = new Date(input.startAt).getTime();
    if (!Number.isFinite(startMs)) {
      throw new ScheduleAccessError('startAt 不是合法时间');
    }
    if (
      input.recurrenceRule === null ||
      input.recurrenceRule === undefined ||
      input.recurrenceRule === ''
    ) {
      return {
        occurrences: [new Date(startMs).toISOString()],
        recurring: false,
        rule: null,
      };
    }
    const rule = parseRecurrenceRule(input.recurrenceRule);
    const list = previewNext(startMs, rule, 5);
    return {
      occurrences: list.map((ms) => new Date(ms).toISOString()),
      recurring: true,
      rule,
    };
  }

  // ══════════════════ 写（新建/更新/状态迁移，三作用域）══════════════════

  /**
   * 新建日程（含重复系列展开落库）
   *
   * 单次：落 1 行（seriesId=NULL，行为与 021 一致）
   * 重复：落 N 行，**同一 seriesId**，每行 occurrenceAt=该次基准时刻
   *      ⇒ 提示链按"每行一次提醒"工作，天然与 P2-3 兼容（§五.8）
   */
  async create(
    actor: ScheduleActor,
    input: ScheduleWriteInput,
    opts: {
      source?: 'user' | 'ai' | 'employee';
      createdBy?: string | null;
    } = {},
  ): Promise<{ created: AiScheduleEntity[]; preview: SchedulePreview }> {
    const preview = this.buildPreview(input);
    const startMs = new Date(input.startAt).getTime();
    const ownerKey = principalKey(actor.principal);
    const share = this.normalizeShare(input.share);

    if (!preview.recurring) {
      const row = this.scheduleRepo.create({
        tenantId: actor.tenantId,
        title: input.title,
        startAt: new Date(startMs),
        endAt: input.endAt ? new Date(input.endAt) : null,
        owner: ownerKey,
        participants: input.participants ?? null,
        status: 'planned',
        remindAt: input.remindAt ? new Date(input.remindAt) : null,
        source: opts.source ?? 'user',
        createdBy: opts.createdBy ?? ownerKey,
        ...share,
        seriesId: null,
        recurrenceRule: null,
        occurrenceAt: new Date(startMs),
        exception: null,
      });
      const saved = await this.scheduleRepo.save(row);
      await this.auditShare(actor, saved.id, null, share);
      return { created: [saved], preview };
    }

    // 重复：先落首行取 seriesId，再落其余（同系列唯一键 (tenant,series,occurrence) 防重）
    const rule = preview.rule as RecurrenceRule;
    const occurrences = expandForPersist(startMs, rule);
    const created: AiScheduleEntity[] = [];
    let seriesId: string | null = null;
    for (const ms of occurrences) {
      const row: AiScheduleEntity = this.scheduleRepo.create({
        tenantId: actor.tenantId,
        title: input.title,
        startAt: new Date(ms),
        endAt: input.endAt ? new Date(input.endAt) : null,
        owner: ownerKey,
        participants: input.participants ?? null,
        status: 'planned',
        // 提醒时间按"相对开始的偏移"平移，保证每个 occurrence 都能被提醒链扫到
        remindAt: input.remindAt
          ? new Date(new Date(input.remindAt).getTime() + (ms - startMs))
          : null,
        source: opts.source ?? 'user',
        createdBy: opts.createdBy ?? ownerKey,
        ...share,
        seriesId,
        recurrenceRule: JSON.stringify(rule),
        occurrenceAt: new Date(ms),
        exception: null,
      } as Partial<AiScheduleEntity>);
      const saved: AiScheduleEntity = await this.scheduleRepo.save(row);
      if (seriesId === null) {
        seriesId = String(saved.id);
        saved.seriesId = seriesId;
        await this.scheduleRepo.update({ id: saved.id }, { seriesId });
      }
      created.push(saved);
    }
    await this.auditShare(actor, created[0].id, null, share);
    return { created, preview };
  }

  /**
   * 更新（三作用域，卡面 §四.6/§五.5）
   *
   * - `single`：只改该 occurrence ⇒ 写 `exception`（不动规则/不动其他行）
   * - `following`：把该 occurrence 起的部分**拆成新系列**（老系列 UNTIL 截断）
   * - `all`：整系列所有行一起改
   * ⇒ 整系列修改**不会**被伪装成单次（反测 5：单次作用域若写成整系列 ⇒ 用例红）
   */
  async update(
    actor: ScheduleActor,
    id: string,
    patch: Partial<ScheduleWriteInput>,
    scope: ScheduleScope = 'single',
  ): Promise<{ updated: number; preview?: SchedulePreview }> {
    const target = await this.getById(id, actor);
    // 改共享范围需 admin；改内容需 write
    const touchesShare = patch.share !== undefined && patch.share !== null;
    if (touchesShare) {
      await this.assertCanAdmin(target, actor);
    } else {
      await this.assertCanWrite(target, actor);
    }

    const patchShare = touchesShare ? this.normalizeShare(patch.share) : null;

    // 无重复 ⇒ 等价于单次（不制造 series 语义）
    if (!target.recurrenceRule || !target.seriesId) {
      const before = this.shareSnapshot(target);
      await this.scheduleRepo.update(
        { id: target.id, tenantId: actor.tenantId },
        {
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.startAt !== undefined
            ? { startAt: new Date(patch.startAt) }
            : {}),
          ...(patch.endAt !== undefined
            ? { endAt: patch.endAt ? new Date(patch.endAt) : null }
            : {}),
          ...(patch.remindAt !== undefined
            ? { remindAt: patch.remindAt ? new Date(patch.remindAt) : null }
            : {}),
          ...(patch.participants !== undefined
            ? { participants: patch.participants }
            : {}),
          ...(patchShare ?? {}),
          updatedAt: new Date(),
        },
      );
      if (patchShare) {
        await this.auditShare(actor, target.id, before, patchShare);
      }
      return { updated: 1 };
    }

    const seriesRows = await this.seriesRows(target, actor);
    if (scope === 'all') {
      const before = this.shareSnapshot(target);
      const cnt = await this.applyPatchToRows(
        actor,
        seriesRows,
        patch,
        patchShare,
      );
      if (patchShare) {
        await this.auditShare(actor, target.id, before, patchShare);
      }
      return {
        updated: cnt,
        preview: patch.recurrenceRule
          ? this.buildPreview({
              ...this.toWriteInput(target),
              ...patch,
              recurrenceRule: patch.recurrenceRule,
            })
          : undefined,
      };
    }

    if (scope === 'following') {
      // 拆分：老系列在 target.occurrenceAt 之前截断；新系列从 target 起按 patch **重新展开**
      const cut = (target.occurrenceAt ?? target.startAt).getTime();
      const newerRows = seriesRows.filter(
        (r) => (r.occurrenceAt ?? r.startAt).getTime() >= cut,
      );
      const olderRows = seriesRows.filter(
        (r) => (r.occurrenceAt ?? r.startAt).getTime() < cut,
      );
      // 老系列：规则 UNTIL 截断到 cut-1ms（仅当老系列还有行；无老行则整系列即新段）
      if (olderRows.length > 0 && target.recurrenceRule) {
        const oldRule = parseRecurrenceRule(target.recurrenceRule);
        const truncated = JSON.stringify({
          ...oldRule,
          count: undefined,
          until: cut - 1,
        });
        await this.scheduleRepo.update(
          { tenantId: actor.tenantId, seriesId: target.seriesId },
          { recurrenceRule: truncated, updatedAt: new Date() },
        );
      }
      // 新系列：以 patch（或原）规则从新起点**完整展开**，行数由展开结果决定
      const newStartMs = patch.startAt
        ? new Date(patch.startAt).getTime()
        : cut;
      const ruleRaw = patch.recurrenceRule ?? target.recurrenceRule;
      const rule = parseRecurrenceRule(ruleRaw ?? undefined);
      const occurrences = expandForPersist(newStartMs, rule);
      const newSeriesId = String(target.id);
      const offset = target.remindAt
        ? new Date(target.remindAt).getTime() -
          new Date(target.startAt).getTime()
        : null;
      let cnt = 0;
      for (let i = 0; i < occurrences.length; i += 1) {
        const occ = occurrences[i];
        const src = newerRows[i];
        if (src) {
          // 复用既有行：重挂新系列 + 平移 occurrence + 应用 patch 字段
          const set: Partial<AiScheduleEntity> = {
            seriesId: newSeriesId,
            startAt: new Date(occ),
            occurrenceAt: new Date(occ),
            recurrenceRule: JSON.stringify(rule),
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.endAt !== undefined
              ? { endAt: patch.endAt ? new Date(patch.endAt) : null }
              : {}),
            ...(patch.participants !== undefined
              ? { participants: patch.participants }
              : {}),
            ...(patchShare ?? {}),
            remindAt: offset !== null ? new Date(occ + offset) : null,
            updatedAt: new Date(),
          };
          const res = await this.scheduleRepo.update(
            { id: src.id, tenantId: actor.tenantId },
            set,
          );
          cnt += res.affected ?? 0;
        } else {
          // 新规则展开更多 ⇒ 补插新行
          const baseEnd =
            patch.endAt !== undefined
              ? patch.endAt
                ? new Date(patch.endAt)
                : null
              : target.endAt
                ? new Date(
                    new Date(target.endAt).getTime() + (occ - newStartMs),
                  )
                : null;
          const row = this.scheduleRepo.create({
            tenantId: actor.tenantId,
            title: patch.title ?? target.title,
            startAt: new Date(occ),
            endAt: baseEnd,
            owner: target.owner,
            participants:
              patch.participants !== undefined
                ? patch.participants
                : target.participants,
            status: 'planned' as const,
            remindAt: offset !== null ? new Date(occ + offset) : null,
            source: target.source,
            createdBy: target.createdBy,
            ...(patchShare ?? this.shareFieldsOf(target)),
            seriesId: newSeriesId,
            recurrenceRule: JSON.stringify(rule),
            occurrenceAt: new Date(occ),
            exception: null,
          } as Partial<AiScheduleEntity>);
          await this.scheduleRepo.save(row);
          cnt += 1;
        }
      }
      // 新规则展开更少 ⇒ 多出的旧尾行置 cancelled（不再出现；保留可审计）
      for (let i = occurrences.length; i < newerRows.length; i += 1) {
        const extra = newerRows[i];
        const res = await this.scheduleRepo.update(
          { id: extra.id, tenantId: actor.tenantId, status: 'planned' },
          {
            status: 'cancelled',
            seriesId: null,
            updatedAt: new Date(),
          },
        );
        void res;
      }
      if (patchShare) {
        await this.auditShare(
          actor,
          target.id,
          this.shareSnapshot(target),
          patchShare,
        );
      }
      return { updated: cnt };
    }

    // single：只改这一行，并把改动**记为 exception**（不触碰规则与其他行）
    const before = this.shareSnapshot(target);
    const exception = JSON.stringify({
      at: new Date().toISOString(),
      actor: principalKey(actor.principal),
      patch: {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.startAt !== undefined
          ? { startAt: String(patch.startAt) }
          : {}),
        ...(patch.endAt !== undefined
          ? { endAt: patch.endAt ? String(patch.endAt) : null }
          : {}),
        ...(patch.remindAt !== undefined
          ? { remindAt: patch.remindAt ? String(patch.remindAt) : null }
          : {}),
        ...(patch.participants !== undefined
          ? { participants: patch.participants }
          : {}),
      },
    });
    await this.scheduleRepo.update(
      { id: target.id, tenantId: actor.tenantId },
      {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.startAt !== undefined
          ? { startAt: new Date(patch.startAt) }
          : {}),
        ...(patch.endAt !== undefined
          ? { endAt: patch.endAt ? new Date(patch.endAt) : null }
          : {}),
        ...(patch.remindAt !== undefined
          ? { remindAt: patch.remindAt ? new Date(patch.remindAt) : null }
          : {}),
        ...(patch.participants !== undefined
          ? { participants: patch.participants }
          : {}),
        ...(patchShare ?? {}),
        exception,
        updatedAt: new Date(),
      },
    );
    if (patchShare) {
      await this.auditShare(actor, target.id, before, patchShare);
    }
    return { updated: 1 };
  }

  /**
   * 状态迁移（完成/取消）三作用域
   *
   * - `single`：只该行
   * - `following`：该 occurrence 及其后所有行
   * - `all`：整系列
   * 原子迁移：`UPDATE ... WHERE status='planned'`（不先读后写）
   */
  async changeStatus(
    actor: ScheduleActor,
    id: string,
    next: Extract<ScheduleStatus, 'done' | 'cancelled'>,
    scope: ScheduleScope = 'single',
  ): Promise<{ updated: number; rows: string[] }> {
    const target = await this.getById(id, actor);
    await this.assertCanWrite(target, actor);

    const ids =
      !target.seriesId || scope === 'single'
        ? [target.id]
        : scope === 'all'
          ? (await this.seriesRows(target, actor)).map((r) => r.id)
          : (await this.seriesRows(target, actor))
              .filter(
                (r) =>
                  (r.occurrenceAt ?? r.startAt).getTime() >=
                  (target.occurrenceAt ?? target.startAt).getTime(),
              )
              .map((r) => r.id);

    const rows: string[] = [];
    for (const rowId of ids) {
      const res = await this.scheduleRepo.update(
        { id: rowId, tenantId: actor.tenantId, status: 'planned' },
        { status: next, updatedAt: new Date() },
      );
      if ((res.affected ?? 0) > 0) rows.push(rowId);
    }
    return { updated: rows.length, rows };
  }

  /** 整系列所有行（含 cancelled；按 occurrence 升序） */
  private async seriesRows(
    target: AiScheduleEntity,
    actor: ScheduleActor,
  ): Promise<AiScheduleEntity[]> {
    if (!target.seriesId) return [target];
    const rows = await this.scheduleRepo.find({
      where: { tenantId: actor.tenantId, seriesId: target.seriesId },
      order: { occurrenceAt: 'ASC' },
    });
    return rows;
  }

  /** 把 patch 应用到一组行（all/following 共用；避免复制） */
  private async applyPatchToRows(
    actor: ScheduleActor,
    rows: AiScheduleEntity[],
    patch: Partial<ScheduleWriteInput>,
    patchShare: Partial<AiScheduleEntity> | null,
    rebase?: { newSeriesId: string; occurrences: number[]; newStartMs: number },
  ): Promise<number> {
    let cnt = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const occ = rebase ? rebase.occurrences[i] : undefined;
      const set: Partial<AiScheduleEntity> = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.endAt !== undefined
          ? { endAt: patch.endAt ? new Date(patch.endAt) : null }
          : {}),
        ...(patch.participants !== undefined
          ? { participants: patch.participants }
          : {}),
        ...(patchShare ?? {}),
        updatedAt: new Date(),
      };
      if (rebase && occ !== undefined) {
        set.startAt = new Date(occ);
        set.occurrenceAt = new Date(occ);
        set.seriesId = rebase.newSeriesId;
        // 提醒相对偏移随新 occurrence 平移
        const base = new Date(patch.startAt ?? row.startAt).getTime();
        const offset = row.remindAt
          ? new Date(row.remindAt).getTime() - new Date(row.startAt).getTime()
          : null;
        set.remindAt = offset !== null ? new Date(occ + offset) : null;
        void base;
      } else if (patch.startAt !== undefined) {
        const shifted = new Date(patch.startAt).getTime();
        const oldStart = new Date(row.startAt).getTime();
        const offset = row.remindAt
          ? new Date(row.remindAt).getTime() - oldStart
          : null;
        set.startAt = new Date(
          shifted + (oldStart - new Date(rows[0].startAt).getTime()),
        );
        set.remindAt =
          offset !== null
            ? new Date(new Date(set.startAt).getTime() + offset)
            : null;
      }
      const res = await this.scheduleRepo.update(
        { id: row.id, tenantId: actor.tenantId },
        set,
      );
      cnt += res.affected ?? 0;
    }
    return cnt;
  }

  // ══════════════════ 共享范围（审计）══════════════════

  private normalizeShare(
    share?: ScheduleShareInput | null,
  ): Partial<AiScheduleEntity> {
    if (!share) return {};
    return {
      ...(share.viewerRoles !== undefined
        ? { viewerRoles: normalizeList(share.viewerRoles) }
        : {}),
      ...(share.viewerUserIds !== undefined
        ? { viewerUserIds: normalizeList(share.viewerUserIds) }
        : {}),
      ...(share.managerUserIds !== undefined
        ? { managerUserIds: normalizeList(share.managerUserIds) }
        : {}),
    };
  }

  private shareSnapshot(row: AiScheduleEntity): {
    viewerRoles: string | null;
    viewerUserIds: string | null;
    managerUserIds: string | null;
  } {
    return {
      viewerRoles: row.viewerRoles ?? null,
      viewerUserIds: row.viewerUserIds ?? null,
      managerUserIds: row.managerUserIds ?? null,
    };
  }

  /** 行的共享三列（补插新 occurrence 行时**原样继承**，保证系列内可见性一致） */
  private shareFieldsOf(row: AiScheduleEntity): Partial<AiScheduleEntity> {
    return {
      viewerRoles: row.viewerRoles ?? null,
      viewerUserIds: row.viewerUserIds ?? null,
      managerUserIds: row.managerUserIds ?? null,
    };
  }

  /** 共享范围变更审计（§五.3：可核） */
  private async auditShare(
    actor: ScheduleActor,
    scheduleId: string,
    before: {
      viewerRoles: string | null;
      viewerUserIds: string | null;
      managerUserIds: string | null;
    } | null,
    after: Partial<AiScheduleEntity>,
  ): Promise<void> {
    // 无实际变化 ⇒ 不写审计（避免噪声）
    const changed =
      (after.viewerRoles !== undefined &&
        after.viewerRoles !== (before?.viewerRoles ?? null)) ||
      (after.viewerUserIds !== undefined &&
        after.viewerUserIds !== (before?.viewerUserIds ?? null)) ||
      (after.managerUserIds !== undefined &&
        after.managerUserIds !== (before?.managerUserIds ?? null));
    if (!changed) return;
    try {
      await this.scheduleRepo.query(
        `INSERT INTO t_ai_schedule_share_audit
           (tenant_id, schedule_id, actor, before_viewer_roles, after_viewer_roles,
            before_viewer_users, after_viewer_users, before_manager_users, after_manager_users, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
        [
          actor.tenantId,
          String(scheduleId),
          principalKey(actor.principal),
          before?.viewerRoles ?? null,
          after.viewerRoles ?? null,
          before?.viewerUserIds ?? null,
          after.viewerUserIds ?? null,
          before?.managerUserIds ?? null,
          after.managerUserIds ?? null,
        ],
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`共享范围审计写入失败（不掩盖主流程）：${message}`);
    }
  }

  /** 实体 ⇒ DTO（预览/回显共用，保证 AI 与人工同结构） */
  toWriteInput(row: AiScheduleEntity): ScheduleWriteInput {
    return {
      title: row.title,
      startAt: row.startAt,
      endAt: row.endAt,
      remindAt: row.remindAt,
      participants: row.participants,
      recurrenceRule: row.recurrenceRule,
      share: {
        viewerRoles: splitList(row.viewerRoles),
        viewerUserIds: splitList(row.viewerUserIds),
        managerUserIds: splitList(row.managerUserIds),
      },
    };
  }
}

/** 权限/输入错误（上层统一转 403/400，不泄漏资源是否存在） */
export class ScheduleAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleAccessError';
  }
}
