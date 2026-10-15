/**
 * aiNoticeUnreadCount — 未读通知数（**读工具**；R101-AI-40）
 *
 * 用途：前端**角标**（红点数字）。库层条件与 `aiNoticeList` 同源（**库层隔离**）：
 * `tenant AND (id IN(granted) OR receiver LIKE '%,me,%' …) AND read_at IS NULL AND archived_at IS NULL`
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
import { participantsLike } from './schedule-participants.util';

@Injectable()
export class AiNoticeUnreadCountTool implements ITool {
  private readonly logger = new Logger(AiNoticeUnreadCountTool.name);

  readonly name = 'aiNoticeUnreadCount';
  readonly description =
    '未读通知数（只读）：返回当前用户的未读且未归档通知数量（供前端角标/红点使用）。' +
    '示例参数：{}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = { type: 'object' as const, properties: {} };

  constructor(
    @InjectRepository(AiNoticeEntity)
    private readonly noticeRepo: Repository<AiNoticeEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  async execute(
    _args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const principal: OfficePrincipal = principalOf(context);
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    const rolePrincipals = (principal.roles ?? []).map((r) => `role:${r}`);

    try {
      const grantedIds = principal.isPlatform
        ? []
        : await this.officeAcl.aclGrantedIds('notice', {
            tenantId: context.tenantId,
            principal,
          });

      const base: Record<string, unknown> = {
        readAt: IsNull(),
        archivedAt: IsNull(),
      };
      if (!principal.isPlatform) base.tenantId = context.tenantId;

      const where = principal.isPlatform
        ? [base]
        : [
            { ...base, id: In(grantedIds.length > 0 ? grantedIds : ['-1']) },
            ...[me, ...rolePrincipals].map((p) => ({
              ...base,
              receiver: participantsLike(p),
            })),
          ];

      const count = await this.noticeRepo.count({ where });

      return {
        success: true,
        data: {
          unread: count,
          principalBranches: principal.isPlatform
            ? 1
            : 1 + 1 + rolePrincipals.length,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`未读数查询失败：${message}`);
      // 角标用途：失败时不抛，返回 0 更利于前端稳健（并给出 error 说明）
      return {
        success: true,
        data: { unread: 0, degraded: true, error: message },
      };
    }
  }
}
