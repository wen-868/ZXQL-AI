/**
 * aiApprovalList — 审批列表（**读工具**；R101-AI-38）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动。
 *
 * 权限实现（同批次 2 的 `aiTodoList`，**库层隔离**）：
 * - 注入 `approvalRepo` 是因需按 status/applicant/approver 查询 ⇒ 结构防线弱于"只依赖 ACL 服务"
 * - 因此**把 ACL 可见集作为库查询条件**：
 *   `tenant_id=? AND (id IN(:granted) OR applicant=:me OR approver=:myPrincipals)`
 *   **绝不"先查全量再内存过滤"**
 * - 之后再逐行 `resolveResource` 确认（纵深防御）
 *
 * 两类视图（凌舟裁定）：
 * - `view='to_approve'`：待我审批（approver 命中我的 principal 且 status=pending）
 * - `view='mine'`：我申请的（applicant=me）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiApprovalListTool implements ITool {
  private readonly logger = new Logger(AiApprovalListTool.name);

  readonly name = 'aiApprovalList';
  readonly description =
    '审批列表（只读）：列出当前用户**有权查看**的审批实例（我提交的 / 待我审批的 / 被 ACL 授权的）。' +
    '可按 view（to_approve|mine）、status、applicant、approver 筛选。' +
    '⚠️ 边界：AI 底座原生轻量审批；不替代 MS 审批。' +
    '示例参数：{"view":"to_approve","status":"pending"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      view: {
        type: 'string',
        enum: ['to_approve', 'mine'],
        description: '视图：to_approve=待我审批；mine=我申请的（可选）',
      },
      status: {
        type: 'string',
        enum: ['draft', 'pending', 'approved', 'rejected', 'cancelled'],
        description: '状态筛选（可选；非法值忽略）',
      },
      applicant: {
        type: 'string',
        description: '申请人筛选（可选，user:{id}）',
      },
      approver: { type: 'string', description: '审批人筛选（可选）' },
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
    const principal: OfficePrincipal = principalOf(context);
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    const myPrincipals = [
      me,
      ...(principal.roles ?? []).map((r) => `role:${r}`),
    ];

    const view =
      args.view === 'to_approve' || args.view === 'mine'
        ? args.view
        : undefined;
    const status =
      args.status === 'draft' ||
      args.status === 'pending' ||
      args.status === 'approved' ||
      args.status === 'rejected' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const applicant =
      typeof args.applicant === 'string' && args.applicant.trim().length > 0
        ? args.applicant.trim()
        : undefined;
    const approver =
      typeof args.approver === 'string' && args.approver.trim().length > 0
        ? args.approver.trim()
        : undefined;

    try {
      // ① ACL 可见集（库层隔离输入）
      const grantedIds = principal.isPlatform
        ? []
        : await this.officeAcl.aclGrantedIds('approval', {
            tenantId: context.tenantId,
            principal,
          });

      const base: Record<string, unknown> = {};
      // R101-AI-41：已弃草稿（软删）默认不出现在列表（生命周期标记，非工作流状态）
      base.deletedAt = IsNull();
      if (!principal.isPlatform) base.tenantId = context.tenantId;
      if (status !== undefined) base.status = status;
      if (view === 'to_approve' && status === undefined)
        base.status = 'pending';
      if (applicant !== undefined) base.applicant = applicant;
      if (approver !== undefined) base.approver = approver;

      // ② 库层条件：租户 + (ACL 授予 OR 我申请的 OR 待我审批)
      const visibility = principal.isPlatform
        ? [base]
        : view === 'to_approve'
          ? [{ ...base, approver: In(myPrincipals) }]
          : view === 'mine'
            ? [{ ...base, applicant: me }]
            : [
                {
                  ...base,
                  id: In(grantedIds.length > 0 ? grantedIds : ['-1']),
                },
                { ...base, applicant: me },
                { ...base, approver: In(myPrincipals) },
              ];

      const rows = await this.approvalRepo.find({ where: visibility });

      // ③ 纵深防御：逐行确认
      const visible: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const access = await this.officeAcl.resolveResource(
          {
            resourceType: 'approval',
            resourceId: row.id,
            tenantId: row.tenantId,
            owner: row.applicant,
          },
          { tenantId: context.tenantId, principal },
        );
        const isApplicant = row.applicant === me;
        const isApprover = myPrincipals.includes(row.approver);
        if (access !== 'none' || isApplicant || isApprover) {
          visible.push({
            approvalId: row.id,
            title: row.title,
            type: row.type,
            applicant: row.applicant,
            approver: row.approver,
            status: row.status,
            relatedBiz: row.relatedBiz,
            decisionReason: row.decisionReason,
            updatedAt: new Date(row.updatedAt).toISOString(),
          });
        }
      }

      return {
        success: true,
        data: {
          total: visible.length,
          list: visible,
          aclBucket: {
            resourceType: 'approval',
            grantedCount: grantedIds.length,
            view: view ?? 'all',
            scope: principal.isPlatform
              ? 'platform(跨租户)'
              : 'tenant+applicant+approver',
          },
          ...(visible.length === 0
            ? { note: '当前没有你有权查看的审批（或筛选条件下无匹配）' }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`审批列表查询失败：${message}`);
      return {
        success: false,
        error: `审批列表查询失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
