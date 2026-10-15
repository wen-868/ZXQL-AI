/**
 * aiScheduleList — 日程列表（**读工具**；R101-AI-39）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动。
 *
 * 权限（**库层隔离**，同批次 2/3）：
 * `tenant_id=? AND (id IN(:granted) OR owner=:me OR participants LIKE '%,me,%')`
 * ⇒ **绝不"先查全量再内存过滤"**；之后逐行 `resolveResource` 确认（纵深防御）
 *
 * ⚠️ participants 匹配的**双方言一致性**（凌舟点名）：
 * - 存储归一化为**首尾带逗号**（`,user:u1,user:u12,`），匹配用 `LIKE '%,user:u1,%'`
 *   ⇒ 杜绝 `%u1%` 误命中 `u12` 的**子串误配**
 * - MySQL LIKE 默认大小写不敏感 / sqlite 默认区分 ⇒ principal 由 `principalOf()` 生成且**全小写**
 *   ⇒ 实际取值域内无歧义（注释留痕；若将来允许大写 id 需显式统一大小写）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import {
  matchesParticipant,
  participantsLike,
} from './schedule-participants.util';

@Injectable()
export class AiScheduleListTool implements ITool {
  private readonly logger = new Logger(AiScheduleListTool.name);

  readonly name = 'aiScheduleList';
  readonly description =
    '日程清单（只读）：列出当前用户**有权查看**的日程（我创建的 / 我参与的 / 被 ACL 授权的），' +
    '可按时间范围（from/to）、状态（planned|done|cancelled）筛选。' +
    '示例参数：{"from":"2026-10-16","status":"planned"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      from: { type: 'string', description: '开始时间下限（可选，ISO 日期）' },
      to: { type: 'string', description: '开始时间上限（可选，ISO 日期）' },
      status: {
        type: 'string',
        enum: ['planned', 'done', 'cancelled'],
        description: '状态筛选（可选；非法值忽略）',
      },
    },
  };

  constructor(
    @InjectRepository(AiScheduleEntity)
    private readonly scheduleRepo: Repository<AiScheduleEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const principal: OfficePrincipal = principalOf(context);
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    const status =
      args.status === 'planned' ||
      args.status === 'done' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const from =
      typeof args.from === 'string' && args.from.trim().length > 0
        ? new Date(args.from)
        : undefined;
    const to =
      typeof args.to === 'string' && args.to.trim().length > 0
        ? new Date(args.to)
        : undefined;

    try {
      // ① ACL 可见集（库层隔离输入）
      const grantedIds = principal.isPlatform
        ? []
        : await this.officeAcl.aclGrantedIds('schedule', {
            tenantId: context.tenantId,
            principal,
          });

      const base: Record<string, unknown> = {};
      if (!principal.isPlatform) base.tenantId = context.tenantId;
      if (status !== undefined) base.status = status;
      if (from !== undefined && !Number.isNaN(from.getTime())) {
        base.startAt = MoreThanOrEqual(from);
      }
      if (to !== undefined && !Number.isNaN(to.getTime())) {
        base.startAt = LessThanOrEqual(to); // 同时给 from/to 时以 to 为准（简单策略，注释留痕）
      }

      // ② 库层条件：租户 + (ACL 授予 OR 我是 owner OR 我在 participants)
      const visibility = principal.isPlatform
        ? [base]
        : [
            { ...base, id: In(grantedIds.length > 0 ? grantedIds : ['-1']) },
            { ...base, owner: me },
            { ...base, participants: participantsLike(me) },
          ];

      const rows = await this.scheduleRepo.find({ where: visibility });

      // ③ 纵深防御：逐行确认
      const visible: Array<Record<string, unknown>> = [];
      for (const s of rows) {
        const access = await this.officeAcl.resolveResource(
          {
            resourceType: 'schedule',
            resourceId: s.id,
            tenantId: s.tenantId,
            owner: s.owner,
          },
          { tenantId: context.tenantId, principal },
        );
        const isOwner = s.owner === me;
        const isParticipant =
          matchesParticipant(s.participants, me) ||
          (principal.roles ?? []).some((r) =>
            matchesParticipant(s.participants, `role:${r}`),
          );
        if (access !== 'none' || isOwner || isParticipant) {
          visible.push({
            scheduleId: s.id,
            title: s.title,
            startAt: new Date(s.startAt).toISOString(),
            endAt: s.endAt ? new Date(s.endAt).toISOString() : null,
            owner: s.owner,
            participants: s.participants,
            status: s.status,
            remindAt: s.remindAt ? new Date(s.remindAt).toISOString() : null,
          });
        }
      }

      return {
        success: true,
        data: {
          total: visible.length,
          list: visible,
          aclBucket: {
            resourceType: 'schedule',
            grantedCount: grantedIds.length,
            scope: principal.isPlatform
              ? 'platform(跨租户)'
              : 'tenant+owner+participants',
          },
          ...(visible.length === 0
            ? { note: '当前没有你有权查看的日程（或筛选条件下无匹配）' }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`日程清单查询失败：${message}`);
      return {
        success: false,
        error: `日程清单查询失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
