/**
 * aiNoticeMarkRead — 标记通知已读（**写工具**；R101-AI-40）
 *
 * **原子判定**：`UPDATE ... WHERE tenant_id=? AND id=? AND read_at IS NULL`
 * ⇒ `affected=0` 再读：已读 ⇒ **回放**（"已读"**无歧义终态**，对照规范 §2.1 可回放）；不存在 ⇒ 明确失败
 *
 * 权限：接收人（receiver 边界匹配）/ 角色匹配 / 平台 / ACL write
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
export class AiNoticeMarkReadTool implements ITool {
  private readonly logger = new Logger(AiNoticeMarkReadTool.name);

  readonly name = 'aiNoticeMarkRead';
  readonly description =
    '标记通知已读（**写操作**，需确认）：把一条未读通知置为已读。重复标记不会重复改（回放）。' +
    '示例参数：{"noticeId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'low' as const;
  /** 状态迁移型幂等键：同一通知重复标记 = 同一操作 ⇒ 回放 */
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
          suggestion: '仅接收人（或被授予 write/admin 权限者）可标记已读',
        };
      }

      // 已读 ⇒ 回放（无歧义终态）
      if (notice.readAt !== null) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            noticeId: notice.id,
            read: true,
            duplicate: true,
            message: `通知 #${notice.id} 已是已读状态，未重复修改`,
          },
        };
      }

      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '标记通知已读',
            summary: `将把通知「${notice.title}」标记为已读`,
            details: {
              noticeId,
              title: notice.title,
              currentRead: false,
              nextRead: true,
            },
          },
        };
      }

      // ── 原子标记：条件带 read_at IS NULL ──
      const res = await this.noticeRepo.update(
        { id: noticeId, tenantId: notice.tenantId, readAt: IsNull() },
        { readAt: new Date(), updatedAt: new Date() },
      );

      if (res.affected === 0) {
        const after = await this.noticeRepo.findOne({
          where: { id: noticeId, tenantId: notice.tenantId },
        });
        if (after && after.readAt !== null) {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              noticeId: after.id,
              read: true,
              duplicate: true,
              message: `通知 #${after.id} 已是已读（并发同操作），未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: `标记未生效：通知 ${noticeId} 不存在或状态异常`,
          suggestion: '请用 aiNoticeList 刷新后重试',
        };
      }

      return {
        success: true,
        data: { noticeId, read: true, message: `通知 #${noticeId} 已标记已读` },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`标记已读失败：${message}`);
      return {
        success: false,
        error: `标记已读失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
