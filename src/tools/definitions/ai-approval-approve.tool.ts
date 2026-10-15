/**
 * aiApprovalApprove — 通过审批（**写工具**；R101-AI-38）
 *
 * 逻辑全部在 `ApprovalDecisionBase`（状态机、原子迁移、权限、错误口径只写一份）。
 * 本类只声明：目标状态 `approved`、动作名"通过"、意见**可选**。
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
import { OfficeAclService } from '../../rag/office-acl.service';
import { ApprovalDecisionBase } from './approval-decision.base';

@Injectable()
export class AiApprovalApproveTool extends ApprovalDecisionBase {
  readonly name = 'aiApprovalApprove';
  readonly description =
    '通过审批（**写操作**，需确认）：把处于 pending 的审批实例置为 approved（终态）。' +
    '仅**指定审批人**（或平台管理员）可操作；重复处理或已被他人处理会**明确失败并告知当前状态**（不回放成功）。' +
    '⚠️ 边界：本工具是 **AI 底座原生轻量审批**（AI 辅助填单 + 人审批），**不替代 MS 审批系统**。' +
    '示例参数：{"approvalId":"12","reason":"同意","confirm":false}';
  protected readonly targetStatus: ApprovalStatus = 'approved';
  protected readonly decisionName = '通过';
  protected readonly reasonRequired = false;

  constructor(
    @InjectRepository(AiApprovalEntity)
    approvalRepo: Repository<AiApprovalEntity>,
    officeAcl: OfficeAclService,
  ) {
    super(approvalRepo, officeAcl);
  }
}
