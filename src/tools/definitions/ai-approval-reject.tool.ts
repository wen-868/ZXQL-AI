/**
 * aiApprovalReject — 驳回审批（**写工具**；R101-AI-38）
 *
 * 逻辑全部在 `ApprovalDecisionBase`（与 Approve 共用一份状态机，不复制）。
 * 本类只声明：目标状态 `rejected`、动作名"驳回"、**理由必填**。
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
export class AiApprovalRejectTool extends ApprovalDecisionBase {
  readonly name = 'aiApprovalReject';
  readonly description =
    '驳回审批（**写操作**，需确认）：把处于 pending 的审批实例置为 rejected（终态），**必须填写理由**。' +
    '仅**指定审批人**（或平台管理员）可操作；重复处理会明确失败并告知当前状态。' +
    '⚠️ 边界：AI 底座原生轻量审批，**不替代 MS 审批系统**。' +
    '示例参数：{"approvalId":"12","reason":"金额超预算，请补充说明","confirm":false}';
  protected readonly targetStatus: ApprovalStatus = 'rejected';
  protected readonly decisionName = '驳回';
  protected readonly reasonRequired = true;

  constructor(
    @InjectRepository(AiApprovalEntity)
    approvalRepo: Repository<AiApprovalEntity>,
    officeAcl: OfficeAclService,
  ) {
    super(approvalRepo, officeAcl);
  }
}
