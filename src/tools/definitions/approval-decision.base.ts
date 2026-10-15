/**
 * 审批决策基类（Approve / Reject 共用一份逻辑）—— R101-AI-38
 *
 * 为什么用基类：通过与驳回**只差目标状态与文案**，若各写一份就会出现两份状态机判断
 * （本单红线"逻辑一份不复制"）。故：**判定、原子迁移、错误口径全部在此**，
 * 子类只声明 `targetStatus` 与 `decisionName`。
 *
 * 🔴 状态机核心（本批最重要的不变量）：
 * - 仅 `pending` 可被决策；`draft` 未提交、`approved/rejected/cancelled` 为终态
 * - 迁移**原子**：`UPDATE ... WHERE status='pending'`；`affected=0` ⇒ 再读并以**明确失败**回复
 *   （注意：与 `aiTodoComplete` 不同，这里**不做 replay 成功** —— 因为并发的另一个人可能做了
 *    **相反**的决定（approved vs rejected），把"重复审批"回放成成功会误导用户；必须如实告知当前结果）
 * - `execute` 禁抛
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiApprovalEntity,
  ApprovalStatus,
} from '../../database/entities/ai-approval.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

export abstract class ApprovalDecisionBase implements ITool {
  protected readonly logger: Logger;
  /** 目标终态（子类声明） */
  protected abstract readonly targetStatus: ApprovalStatus;
  /** 动作名（子类声明，用于文案） */
  protected abstract readonly decisionName: string;
  /** 意见是否必填（驳回建议必填、通过可选） */
  protected abstract readonly reasonRequired: boolean;

  /** 工具基本属性（子类可覆盖 name/description） */
  abstract readonly name: string;
  abstract readonly description: string;
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  /** 状态迁移型幂等键：同一实例重复决策 = 同一操作 */
  readonly idempotencyKeyFields = ['approvalId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      approvalId: { type: 'string', description: '审批实例 ID（必填）' },
      reason: { type: 'string', description: '审批意见（驳回建议必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiApprovalEntity)
    protected readonly approvalRepo: Repository<AiApprovalEntity>,
    protected readonly officeAcl: OfficeAclService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

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
        suggestion: '请用 aiApprovalList 获取审批实例 ID',
      };
    }
    const reason =
      typeof args.reason === 'string' && args.reason.trim().length > 0
        ? args.reason.trim()
        : undefined;
    if (this.reasonRequired && reason === undefined) {
      return {
        success: false,
        error: `${this.decisionName}必须填写理由（reason）`,
        suggestion: '请说明驳回原因，便于申请人修改后重新提交',
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

      // 权限：指定审批人 / 平台 / 被 ACL 授予 write 者
      const principal = principalOf(context);
      const allowed = await this.canDecide(approval, context, principal);
      if (!allowed) {
        return {
          success: false,
          error: `无权审批该实例：${approvalId}`,
          suggestion: `本实例指定审批人为 ${approval.approver}；请由该审批人（或平台管理员）操作`,
        };
      }

      // 状态机：仅 pending 可决策（draft/终态均明确拒绝）
      if (approval.status !== 'pending') {
        return {
          success: false,
          error: `实例当前状态为 ${approval.status}，不可${this.decisionName}`,
          suggestion:
            approval.status === 'draft'
              ? '草稿需先提交（aiApprovalCreate 提交后进入 pending）'
              : `该实例已产生审批结果（${approval.status}），不可重复决策`,
        };
      }

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: this.decisionName,
            summary: `将对「${approval.title}」(${approvalId}) 执行${this.decisionName}`,
            details: {
              approvalId,
              title: approval.title,
              type: approval.type,
              applicant: approval.applicant,
              currentStatus: approval.status,
              nextStatus: this.targetStatus,
              reason: reason ?? null,
            },
          },
        };
      }

      // ── 原子状态迁移：条件里带 status='pending' ⇒ 并发下只有一个请求生效 ──
      const res = await this.approvalRepo.update(
        { id: approvalId, tenantId: approval.tenantId, status: 'pending' },
        {
          status: this.targetStatus,
          decisionReason: reason ?? null,
          updatedAt: new Date(),
        },
      );

      if (res.affected === 0) {
        // 竞态：已被他人决策（可能是**相反**的决定）⇒ 明确失败并如实告知，不回放成功
        const after = await this.approvalRepo.findOne({
          where: { id: approvalId, tenantId: approval.tenantId },
        });
        return {
          success: false,
          error: after
            ? `审批已被处理：当前状态 ${after.status}${
                after.decisionReason ? `（意见：${after.decisionReason}）` : ''
              }`
            : `审批实例已不存在：${approvalId}`,
          suggestion: '请刷新后查看最新审批结果；如需重新申请请新建实例',
        };
      }

      return {
        success: true,
        data: {
          approvalId,
          status: this.targetStatus,
          reason: reason ?? null,
          message: `「${approval.title}」已${this.decisionName}${reason ? `（${reason}）` : ''}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`审批${this.decisionName}失败：${message}`);
      return {
        success: false,
        error: `审批${this.decisionName}失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  /**
   * 是否可操作（域规则 + ACL，**不含主体/权限判定的重复实现**）
   *
   * 默认：平台 ⇒ 指定审批人（按 principal 类型与 roles 匹配）⇒ ACL 授予 write/admin
   * 子类可覆写（如撤回：**申请人**或平台可撤回）—— 状态机与原子迁移仍共用本类，逻辑不复制
   */
  protected async canDecide(
    approval: AiApprovalEntity,
    context: ToolContext,
    principal: OfficePrincipal,
  ): Promise<boolean> {
    if (principal.isPlatform) return true;
    if (matchesPrincipal(approval.approver, principal)) return true;
    return this.officeAcl.canWriteResource(
      {
        resourceType: 'approval',
        resourceId: approval.id,
        tenantId: approval.tenantId,
        owner: approval.applicant,
      },
      { tenantId: context.tenantId, principal },
    );
  }
}

/** 审批人标识（user:{id}/role:{id}/employee:{id}）与主体是否匹配 */
export function matchesPrincipal(
  approver: string,
  principal: OfficePrincipal,
): boolean {
  const [kind, ...rest] = approver.split(':');
  const id = rest.join(':');
  if (!kind || id.length === 0) return false;
  if (kind === principal.type && id === principal.id) return true;
  if (kind === 'role') return (principal.roles ?? []).includes(id);
  return false;
}
