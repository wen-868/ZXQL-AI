/**
 * aiApprovalCreate — 提交审批申请（**写工具**；R101-AI-38）
 *
 * 幂等**双层**（凌舟裁定，同批次 2 做法）：
 * 1. **业务层（承重）**：同 `(tenant, applicant, type, relatedBiz)` 且**未终态**已存在 ⇒ 回放
 *    —— 因为唯一键含**可空** `related_biz`，而 MySQL/sqlite 对含 NULL 的唯一键**不判重**
 *    （多行 NULL 允许）⇒ 无关联单据时 DB 层**挡不住**重复，业务层是真正承重点
 * 2. **DB 层**：`uk_ai_approval_dedupe(tenant, applicant, type, related_biz)`；并发竞态 ⇒ 再读回放
 *
 * `submit`（默认 true）：true ⇒ 直接进入 `pending`（可被审批）；false ⇒ 存为 `draft`（供 aiApprovalUpdate 改）。
 * 边界：**AI 底座原生轻量审批**，不替代 MS 审批；单级审批（多级/会签不做）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { AiApprovalEntity } from '../../database/entities/ai-approval.entity';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiApprovalCreateTool implements ITool {
  private readonly logger = new Logger(AiApprovalCreateTool.name);

  readonly name = 'aiApprovalCreate';
  readonly description =
    '提交审批申请（**写操作**，需确认）：创建审批实例并（默认）提交为待审批状态。' +
    '需指定审批人（user:{id} / role:{id} / employee:{id}）。同申请人、同类型、同关联单据的未终态申请' +
    '不会重复创建（自动回放既有实例）。可传 submit=false 存为草稿（草稿可用 aiApprovalUpdate 修改）。' +
    '⚠️ 边界：本工具是 **AI 底座原生轻量审批**（AI 辅助填单 + 人审批，单级），**不替代 MS 审批系统**。' +
    '示例参数：{"title":"差旅报销 3200 元","type":"expense","approver":"user:u-1","relatedBiz":"BILL-2026-001","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'high' as const;
  /** 业务幂等键（承重：related_biz 可空 ⇒ DB 唯一键挡不住 NULL） */
  readonly idempotencyKeyFields = ['applicant', 'type', 'relatedBiz'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '审批标题（必填）' },
      type: {
        type: 'string',
        description: '审批类型（必填，如 expense/leave/purchase/other）',
      },
      approver: {
        type: 'string',
        description:
          '审批人（必填，单级）：user:{id} / role:{id} / employee:{id}',
      },
      payload: { type: 'string', description: '申请内容（可选，JSON 文本）' },
      relatedBiz: {
        type: 'string',
        description: '关联业务单据（可选，幂等键组成；如 BILL-2026-001）',
      },
      submit: {
        type: 'boolean',
        description: '是否直接提交（缺省 true ⇒ pending；false ⇒ 草稿 draft）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiApprovalEntity)
    private readonly approvalRepo: Repository<AiApprovalEntity>,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const type = typeof args.type === 'string' ? args.type.trim() : '';
    const approver =
      typeof args.approver === 'string' ? args.approver.trim() : '';
    if (title.length === 0 || type.length === 0 || approver.length === 0) {
      return {
        success: false,
        error: 'title / type / approver 均为必填',
        suggestion:
          '请提供标题、类型与审批人（user:{id}/role:{id}/employee:{id}）',
      };
    }
    if (!/^(user|role|employee):[A-Za-z0-9_-]+$/.test(approver)) {
      return {
        success: false,
        error: `approver 格式非法：${approver}`,
        suggestion: '审批人须形如 user:{id} / role:{id} / employee:{id}',
      };
    }
    const principal = principalOf(context);
    const applicant = `${principal.type}:${principal.id}`;
    const payload =
      typeof args.payload === 'string' && args.payload.length > 0
        ? args.payload
        : null;
    const relatedBiz =
      typeof args.relatedBiz === 'string' && args.relatedBiz.trim().length > 0
        ? args.relatedBiz.trim()
        : null;
    const submit = args.submit !== false;
    const nextStatus = submit ? 'pending' : 'draft';
    const confirm = args.confirm === true;

    // ── 预览：零副作用（不查库、不落库）──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '提交审批申请',
          summary: `将创建审批「${title}」（${type}），审批人 ${approver}，提交后状态 ${nextStatus}`,
          details: {
            title,
            type,
            applicant,
            approver,
            relatedBiz,
            nextStatus,
            boundary:
              'AI 底座原生轻量审批（单级）；不替代 MS 审批系统；不做多级/会签',
            idempotency:
              '同申请人+类型+关联单据的未终态申请 ⇒ 回放（related_biz 为空时由业务层承重：NULL 不判重）',
          },
        },
      };
    }

    try {
      // ── 幂等第 1 层（业务，承重）：未终态同键 ⇒ 回放 ──
      const existing = await this.approvalRepo.findOne({
        where: {
          tenantId: context.tenantId,
          applicant,
          type,
          relatedBiz: relatedBiz ?? IsNull(),
          status: Not(In(['approved', 'rejected', 'cancelled'])),
        },
      });
      if (existing) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            approvalId: existing.id,
            status: existing.status,
            duplicate: true,
            message: `同键审批已存在（#${existing.id}，状态 ${existing.status}），已直接复用`,
          },
        };
      }

      // ── 幂等第 2 层（DB 唯一键挡并发；related_biz 为空时不判重，故业务层承重）──
      let saved: AiApprovalEntity;
      try {
        saved = await this.approvalRepo.save(
          this.approvalRepo.create({
            tenantId: context.tenantId,
            title,
            type,
            applicant,
            approver,
            status: nextStatus,
            payload,
            decisionReason: null,
            relatedBiz,
            createdBy: context.userId,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/UNIQUE|Duplicate|constraint/i.test(message)) {
          const raced = await this.approvalRepo.findOne({
            where: {
              tenantId: context.tenantId,
              applicant,
              type,
              relatedBiz: relatedBiz ?? IsNull(),
            },
          });
          if (raced) {
            return {
              success: true,
              idempotent_replay: true,
              data: {
                approvalId: raced.id,
                status: raced.status,
                duplicate: true,
                message: `并发提交：同键审批已存在（#${raced.id}），已复用`,
              },
            };
          }
        }
        throw err;
      }

      return {
        success: true,
        data: {
          approvalId: saved.id,
          status: saved.status,
          applicant,
          approver,
          message:
            saved.status === 'pending'
              ? `审批「${title}」已提交（#${saved.id}），等待 ${approver} 审批`
              : `审批「${title}」已存为草稿（#${saved.id}）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`创建审批失败：${message}`);
      return {
        success: false,
        error: `创建审批失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
