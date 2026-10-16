/**
 * aiApprovalDraftDiscard — 丢弃审批草稿（**写工具**；R101-AI-41 S2）
 *
 * 背景：批次 3 的 `aiApprovalUpdate` 仅 draft 可改 ⇒ **草稿想丢只能留着**（AI-38 自查缺口）。本工具补齐。
 *
 * 🔴 语义（采纳凌舟"软删"倾向，并给出更优解的说明）：
 * - **软删**：置 `deleted_at`（**保留记录**，可回溯"谁写过又丢了什么草稿"）；❌ 不做物理 DELETE
 * - **为什么用 `deleted_at` 列而不是扩展 `status` 枚举**（我采纳的"更优解"）：
 *   ① `draft/pending/approved/...` 是**工作流状态**，"被丢弃"是**生命周期标记**，语义层级不同
 *   ② 扩展 MySQL ENUM 需**四处同步**（TS 联合 + 实体 enum + MySQL ENUM + sqlite）—— AI-40 刚踩过
 *   ③ 与既有家族一致（通知 `archived_at`、日程 `reminded_at`）同为"时间戳标记"范式
 * - 约束：**仅 draft 可弃**（pending 及以后 ⇒ 明确拒绝 + 指引用 `aiApprovalCancel`）
 * - 幂等：已弃（`deleted_at` 非空）⇒ **回放**（丢弃是无歧义终态）—— 原子条件 `deleted_at IS NULL`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiApprovalDraftDiscardTool implements ITool {
  private readonly logger = new Logger(AiApprovalDraftDiscardTool.name);

  readonly name = 'aiApprovalDraftDiscard';
  readonly description =
    '丢弃审批草稿（**写操作**，需确认）：把**草稿（draft）**标记为已弃（软删，记录仍保留可回溯）。' +
    '**已提交（pending 及以后）的实例不可丢弃**（会明确拒绝并指向 aiApprovalCancel 撤回）。' +
    '重复丢弃不会重复改（回放）。' +
    '⚠️ 边界：AI 底座原生轻量审批；不替代 MS 审批。' +
    '示例参数：{"approvalId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 生命周期标记型幂等键：同一草稿重复丢弃 = 同一操作 ⇒ 回放 */
  readonly idempotencyKeyFields = ['approvalId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      approvalId: { type: 'string', description: '审批实例 ID（必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiApprovalEntity)
    private readonly approvalRepo: Repository<AiApprovalEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const approvalId =
      typeof args.approvalId === 'string' && args.approvalId.trim().length > 0
        ? args.approvalId.trim()
        : '';
    if (approvalId.length === 0) {
      return {
        success: false,
        error: 'approvalId 不能为空',
        suggestion: '请用 aiApprovalList 获取实例 ID',
      };
    }
    const confirm = args.confirm === true;

    try {
      const approval = await this.approvalRepo.findOne({
        where: { id: approvalId },
      });
      if (!approval) {
        return {
          success: false,
          error: `审批实例不存在：${approvalId}`,
          suggestion: '请用 aiApprovalList 获取实例 ID',
        };
      }

      const allowed = await this.officeAcl.canWriteResource(
        {
          resourceType: 'approval',
          resourceId: approval.id,
          tenantId: approval.tenantId,
          owner: approval.applicant,
        },
        { tenantId: context.tenantId, principal: principalOf(context) },
      );
      if (!allowed) {
        return {
          success: false,
          error: `无权丢弃该草稿：${approvalId}`,
          suggestion: '仅申请人本人（或被授予 write/admin 权限者）可丢弃草稿',
        };
      }

      // 幂等：已弃 ⇒ 回放（无歧义）
      if (approval.deletedAt !== null) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            approvalId: approval.id,
            discarded: true,
            duplicate: true,
            message: `草稿 #${approval.id} 已被丢弃，未重复操作`,
          },
        };
      }
      // 🔴 仅 draft 可弃（pending 及以后须走撤回）
      if (approval.status !== 'draft') {
        return {
          success: false,
          error: `实例状态为 ${approval.status}，仅草稿（draft）可丢弃`,
          suggestion: '已提交的申请如需终止请用 aiApprovalCancel 撤回',
        };
      }

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '丢弃审批草稿',
            summary: `将丢弃草稿「${approval.title}」`,
            details: {
              approvalId,
              title: approval.title,
              currentStatus: approval.status,
              softDelete: true,
              note: '软删：记录保留可回溯（不做物理删除）',
            },
          },
        };
      }

      // ── 原子软删：条件 = draft 且尚未弃 ──
      const res = await this.approvalRepo.update(
        {
          id: approvalId,
          tenantId: approval.tenantId,
          status: 'draft',
          deletedAt: IsNull(),
        },
        { deletedAt: new Date(), updatedAt: new Date() },
      );

      if (res.affected === 0) {
        const after = await this.approvalRepo.findOne({
          where: { id: approvalId, tenantId: approval.tenantId },
        });
        if (after && after.deletedAt !== null) {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              approvalId: after.id,
              discarded: true,
              duplicate: true,
              message: `草稿 #${after.id} 已被丢弃（并发同操作），未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: after
            ? `丢弃未生效：当前状态 ${after.status}（仅 draft 可弃）`
            : `审批实例已不存在：${approvalId}`,
          suggestion: '请用 aiApprovalList 刷新后重试',
        };
      }

      return {
        success: true,
        data: {
          approvalId,
          discarded: true,
          message: `草稿「${approval.title}」已丢弃（软删，可回溯）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`丢弃审批草稿失败：${message}`);
      return {
        success: false,
        error: `丢弃审批草稿失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
