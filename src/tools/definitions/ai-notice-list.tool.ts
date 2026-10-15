/**
 * aiNoticeList — 站内通知列表（**读工具**；R101-AI-40）
 *
 * 权限（**库层隔离**，同日程/待办模式）：
 * `tenant_id=? AND ( id IN(:granted) OR receiver LIKE '%,me,%' OR receiver LIKE '%,role:x,%' … )`
 * ⇒ **绝不"先查全量再内存过滤"**；之后逐行确认（纵深防御）
 *
 * receiver 匹配复用 `schedule-participants.util`（**零复制**）：首尾逗号归一化 ⇒ `LIKE '%,me,%'`
 * 边界匹配，杜绝 `u1` 误命中 `u12`；双方言一致（详见该 util 注释）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AiNoticeEntity } from '../../database/entities/ai-notice.entity';
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
export class AiNoticeListTool implements ITool {
  private readonly logger = new Logger(AiNoticeListTool.name);

  readonly name = 'aiNoticeList';
  readonly description =
    '站内通知列表（只读）：列出**发给当前用户**的通知（含被 ACL 授权的），可按未读/未归档筛选。' +
    '用于补"错过实时推送"的场景（离线也能看到）。' +
    '示例参数：{"unreadOnly":true,"limit":20}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      unreadOnly: {
        type: 'boolean',
        description: '只看未读（可选，默认 false）',
      },
      includeArchived: {
        type: 'boolean',
        description: '包含已归档（可选，默认 false）',
      },
      limit: {
        type: 'integer',
        description: '返回条数上限（可选，默认 20，最大 100）',
      },
    },
  };

  constructor(
    @InjectRepository(AiNoticeEntity)
    private readonly noticeRepo: Repository<AiNoticeEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const principal: OfficePrincipal = principalOf(context);
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    const rolePrincipals = (principal.roles ?? []).map((r) => `role:${r}`);
    const unreadOnly = args.unreadOnly === true;
    const includeArchived = args.includeArchived === true;
    const limit = Math.min(
      100,
      Math.max(1, Number.isInteger(args.limit) ? Number(args.limit) : 20),
    );

    try {
      const grantedIds = principal.isPlatform
        ? []
        : await this.officeAcl.aclGrantedIds('notice', {
            tenantId: context.tenantId,
            principal,
          });

      const base: Record<string, unknown> = {};
      if (!principal.isPlatform) base.tenantId = context.tenantId;
      if (unreadOnly) base.readAt = IsNull();
      if (!includeArchived) base.archivedAt = IsNull();

      // 库层条件：ACL 授予 + 每个"我的 principal"一支 receiver LIKE（含角色）
      const visibility = principal.isPlatform
        ? [base]
        : [
            { ...base, id: In(grantedIds.length > 0 ? grantedIds : ['-1']) },
            ...[me, ...rolePrincipals].map((p) => ({
              ...base,
              receiver: participantsLike(p),
            })),
          ];

      const rows = await this.noticeRepo.find({
        where: visibility,
        take: limit,
      });

      // 纵深防御：逐行确认（receiver 命中 或 ACL 可见）
      const visible: Array<Record<string, unknown>> = [];
      for (const n of rows) {
        const hitReceiver =
          matchesParticipant(n.receiver, me) ||
          rolePrincipals.some((r) => matchesParticipant(n.receiver, r));
        let access = 'none';
        if (!hitReceiver) {
          access = await this.officeAcl.resolveResource(
            {
              resourceType: 'notice',
              resourceId: n.id,
              tenantId: n.tenantId,
              owner: null,
            },
            { tenantId: context.tenantId, principal },
          );
        }
        if (hitReceiver || access !== 'none') {
          visible.push({
            noticeId: n.id,
            title: n.title,
            content: n.content,
            type: n.type,
            priority: n.priority,
            source: n.source,
            refId: n.refId,
            read: n.readAt !== null,
            archived: n.archivedAt !== null,
            createdAt: new Date(n.createdAt).toISOString(),
          });
        }
      }

      return {
        success: true,
        data: {
          total: visible.length,
          list: visible,
          aclBucket: {
            resourceType: 'notice',
            grantedCount: grantedIds.length,
            principalBranches: 1 + 1 + rolePrincipals.length,
          },
          ...(visible.length === 0 ? { note: '没有符合条件的通知' } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`通知列表查询失败：${message}`);
      return {
        success: false,
        error: `通知列表查询失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
