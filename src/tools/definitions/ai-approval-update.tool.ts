/**
 * aiApprovalUpdate — 修改审批草稿（**写工具**；R101-AI-38）
 *
 * 🔴 两条硬约束：
 * 1. **不接受 `status`**（状态迁移一律走 approve/reject/cancel）—— 传即**明确拒绝**
 * 2. **仅 `draft` 可改**：已提交（pending）后内容不可改（避免"审批人看到的"与"实际内容"不一致，
 *    也避免用改内容绕过审批结论）⇒ 非 draft 一律明确拒绝
 *
 * 权限：申请人本人（owner ⇒ ACL admin）/ 平台 / ACL 授予 write。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiApprovalUpdateTool implements ITool {
  private readonly logger = new Logger(AiApprovalUpdateTool.name);

  readonly name = 'aiApprovalUpdate';
  readonly description =
    '修改审批草稿（**写操作**，需确认）：仅**草稿（draft）**可改标题/类型/申请内容/审批人/关联单据。' +
    '**不接受状态修改**（请用 aiApprovalApprove/aiApprovalReject/aiApprovalCancel）；已提交的实例不可改内容。' +
    '⚠️ 边界：AI 底座原生轻量审批；不替代 MS 审批。' +
    '示例参数：{"approvalId":"12","title":"差旅报销 3500 元","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      approvalId: { type: 'string', description: '审批实例 ID（必填）' },
      title: { type: 'string', description: '新标题（可选）' },
      type: { type: 'string', description: '新类型（可选）' },
      payload: { type: 'string', description: '新申请内容（可选，JSON 文本）' },
      approver: { type: 'string', description: '新审批人（可选）' },
      relatedBiz: { type: 'string', description: '新关联单据（可选）' },
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
    // 🔴 状态变更必须走专用工具：先于一切拒绝
    if (args.status !== undefined) {
      return {
        success: false,
        error: '本工具不接受 status 修改（避免绕过审批状态机的原子迁移）',
        suggestion:
          '通过/驳回用 aiApprovalApprove/Reject；撤回用 aiApprovalCancel',
      };
    }

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

      const principal = principalOf(context);
      const allowed = await this.officeAcl.canWriteResource(
        {
          resourceType: 'approval',
          resourceId: approval.id,
          tenantId: approval.tenantId,
          owner: approval.applicant,
        },
        { tenantId: context.tenantId, principal },
      );
      if (!allowed) {
        return {
          success: false,
          error: `无权修改该审批：${approvalId}`,
          suggestion: '仅申请人本人或被授予 write/admin 权限者可修改草稿',
        };
      }

      // 🔴 仅 draft 可改
      if (approval.status !== 'draft') {
        return {
          success: false,
          error: `实例状态为 ${approval.status}，仅草稿（draft）可修改`,
          suggestion:
            '已提交的审批不可改内容（避免与审批人看到的不一致）；如需变更请撤回后重新提交或新建',
        };
      }

      const nextApprover =
        typeof args.approver === 'string' && args.approver.trim().length > 0
          ? args.approver.trim()
          : undefined;
      if (
        nextApprover !== undefined &&
        !/^(user|role|employee):[A-Za-z0-9_-]+$/.test(nextApprover)
      ) {
        return {
          success: false,
          error: `approver 格式非法：${nextApprover}`,
          suggestion: '审批人须形如 user:{id} / role:{id} / employee:{id}',
        };
      }

      const changes = {
        ...(typeof args.title === 'string' && args.title.trim().length > 0
          ? { title: args.title.trim() }
          : {}),
        ...(typeof args.type === 'string' && args.type.trim().length > 0
          ? { type: args.type.trim() }
          : {}),
        ...(typeof args.payload === 'string' ? { payload: args.payload } : {}),
        ...(nextApprover !== undefined ? { approver: nextApprover } : {}),
        ...(typeof args.relatedBiz === 'string' &&
        args.relatedBiz.trim().length > 0
          ? { relatedBiz: args.relatedBiz.trim() }
          : {}),
      };

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '修改审批草稿',
            summary: `将修改草稿「${approval.title}」(${approvalId}) 的 ${Object.keys(changes).join('、') || '（无字段变化）'}`,
            details: {
              approvalId,
              currentStatus: approval.status,
              changes,
              statusNote: '状态不在可改字段内（请用 approve/reject/cancel）',
            },
          },
        };
      }

      approval.title = changes.title ?? approval.title;
      approval.type = changes.type ?? approval.type;
      approval.payload =
        changes.payload !== undefined ? changes.payload : approval.payload;
      approval.approver = changes.approver ?? approval.approver;
      approval.relatedBiz =
        changes.relatedBiz !== undefined
          ? changes.relatedBiz
          : approval.relatedBiz;
      approval.updatedAt = new Date();
      const saved = await this.approvalRepo.save(approval);

      return {
        success: true,
        data: {
          approvalId: saved.id,
          status: saved.status,
          changed: Object.keys(changes),
          message: `草稿 #${saved.id} 已更新（仍为 draft，可继续修改或提交）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`修改审批草稿失败：${message}`);
      return {
        success: false,
        error: `修改审批草稿失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
