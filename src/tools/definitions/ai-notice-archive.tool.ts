/**
 * aiNoticeArchive — 归档通知（**写工具**；R101-AI-40）
 *
 * **原子判定**：`UPDATE ... WHERE tenant_id=? AND id=? AND archived_at IS NULL`
 * ⇒ `affected=0` 再读：已归档 ⇒ **回放**（归档无歧义）；不存在 ⇒ 明确失败
 *
 * 语义：归档 ≠ 删除（保留可查，`aiNoticeList` 默认不返回已归档）；**不可逆**（本批不做"取消归档"，
 * 与日程/待办的终态口径一致；如需恢复归档应新增显式工具）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AiNoticeEntity } from '../../database/entities/ai-notice.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import { matchesParticipant } from './schedule-participants.util';

@Injectable()
export class AiNoticeArchiveTool implements ITool {
  private readonly logger = new Logger(AiNoticeArchiveTool.name);

  readonly name = 'aiNoticeArchive';
  readonly description =
    '归档通知（**写操作**，需确认）：把通知移出默认列表（仍可查，非删除）。重复归档不会重复改（回放）；' +
    '本批**不支持取消归档**。示例参数：{"noticeId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'low' as const;
  readonly idempotencyKeyFields = ['noticeId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      noticeId: { type: 'string', description: '通知 ID（必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览）',
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
    const noticeId =
      typeof args.noticeId === 'string' && args.noticeId.trim().length > 0
        ? args.noticeId.trim()
        : '';
    if (noticeId.length === 0) {
      return {
        success: false,
        error: 'noticeId 不能为空',
        suggestion: '请用 aiNoticeList 获取通知 ID',
      };
    }
    const confirm = args.confirm === true;

    try {
      const notice = await this.noticeRepo.findOne({ where: { id: noticeId } });
      if (!notice) {
        return {
          success: false,
          error: `通知不存在：${noticeId}`,
          suggestion: '请用 aiNoticeList 获取通知 ID',
        };
      }

      const principal = principalOf(context);
      const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
      const isReceiver =
        matchesParticipant(notice.receiver, me) ||
        (principal.roles ?? []).some((r) =>
          matchesParticipant(notice.receiver, `role:${r}`),
        );
      const allowed =
        principal.isPlatform ||
        isReceiver ||
        (await this.officeAcl.canWriteResource(
          {
            resourceType: 'notice',
            resourceId: notice.id,
            tenantId: notice.tenantId,
            owner: null,
          },
          { tenantId: context.tenantId, principal },
        ));
      if (!allowed) {
        return {
          success: false,
          error: `无权操作该通知：${noticeId}`,
          suggestion: '仅接收人（或被授予 write/admin 权限者）可归档',
        };
      }

      if (notice.archivedAt !== null) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            noticeId: notice.id,
            archived: true,
            duplicate: true,
            message: `通知 #${notice.id} 已归档，未重复操作`,
          },
        };
      }

      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '归档通知',
            summary: `将归档通知「${notice.title}」`,
            details: {
              noticeId,
              title: notice.title,
              note: '归档后默认列表不再显示（非删除，本批不可逆）',
            },
          },
        };
      }

      const res = await this.noticeRepo.update(
        { id: noticeId, tenantId: notice.tenantId, archivedAt: IsNull() },
        { archivedAt: new Date(), updatedAt: new Date() },
      );

      if (res.affected === 0) {
        const after = await this.noticeRepo.findOne({
          where: { id: noticeId, tenantId: notice.tenantId },
        });
        if (after && after.archivedAt !== null) {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              noticeId: after.id,
              archived: true,
              duplicate: true,
              message: `通知 #${after.id} 已归档（并发同操作），未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: `归档未生效：通知 ${noticeId} 不存在或状态异常`,
          suggestion: '请用 aiNoticeList 刷新后重试',
        };
      }

      return {
        success: true,
        data: { noticeId, archived: true, message: `通知 #${noticeId} 已归档` },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`归档通知失败：${message}`);
      return {
        success: false,
        error: `归档通知失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
