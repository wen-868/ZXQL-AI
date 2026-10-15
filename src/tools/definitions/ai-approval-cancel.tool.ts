/**
 * aiApprovalCancel — 撤回审批申请（**写工具**；R101-AI-38）
 *
 * **复用 `ApprovalDecisionBase` 的整套状态机与原子迁移**（逻辑一份，不复制）：
 * - 目标状态 `cancelled`；仅 `pending` 可撤 ⇒ `UPDATE ... WHERE status='pending'`
 * - `affected=0` ⇒ 再读 ⇒ **明确失败并如实告知当前状态**（若已被 approved/rejected ⇒ 不可撤，符合业务）
 * - 与 Approve/Reject 唯一差别：**权限口径**（撤回由**申请人**发起）⇒ 覆写 `canDecide`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable } from '@nestjs/common';
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
import { ITool, ToolContext } from '../tool.interface';
import { ApprovalDecisionBase } from './approval-decision.base';

@Injectable()
export class AiApprovalCancelTool extends ApprovalDecisionBase {
  readonly name = 'aiApprovalCancel';
  readonly description =
    '撤回审批申请（**写操作**，需确认）：把**自己提交且仍待审批（pending）**的实例置为 cancelled。' +
    '**已通过/已驳回的实例不可撤回**（会明确失败并告知当前状态）。' +
    '⚠️ 边界：AI 底座原生轻量审批；不替代 MS 审批。' +
    '示例参数：{"approvalId":"12","reason":"金额填错，重新提交","confirm":false}';
  protected readonly targetStatus: ApprovalStatus = 'cancelled';
  protected readonly decisionName = '撤回';
  protected readonly reasonRequired = false;

  constructor(
    @InjectRepository(AiApprovalEntity)
    approvalRepo: Repository<AiApprovalEntity>,
    officeAcl: OfficeAclService,
  ) {
    super(approvalRepo, officeAcl);
  }

  /** 撤回权限：**申请人本人** / 平台 / ACL 授予 write（与审批人视角不同，故覆写） */
  protected async canDecide(
    approval: AiApprovalEntity,
    context: ToolContext,
    principal: OfficePrincipal,
  ): Promise<boolean> {
    if (principal.isPlatform) return true;
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    if (approval.applicant === me) return true;
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

/** 显式引用 ITool 以满足 lint（基类已实现接口） */
export type { ITool };
