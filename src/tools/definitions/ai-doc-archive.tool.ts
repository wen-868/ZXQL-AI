/**
 * aiDocArchive — 文档中心 · 归档文档（**写工具**；R101-AI-35 S2）
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）；`risk='medium'`。
 *
 * 语义（与 S2b 一致）：
 * - **仅 `canAdmin` 可归档**（owner / 平台 / ACL admin）；无权 ⇒ 明确拒绝且不落库
 * - **归档后 `canWrite` 恒 false**（S2b 语义：归档不可逆写；只读）
 *
 * 幂等（与 `aiDocUpdate` 的区别）：
 * - `aiDocUpdate` 保护"内容变更" ⇒ 用 `expectedVersion` **乐观锁**
 * - `aiDocArchive` 保护"重复操作" ⇒ 用**幂等键 `docId`**（同一文档重复归档 = 同一操作）
 *   ⇒ 已是 `archived` 时**回放**既有结果（`idempotent_replay:true`），不重复改状态
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { DocAclService } from '../../rag/doc-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiDocArchiveTool implements ITool {
  private readonly logger = new Logger(AiDocArchiveTool.name);

  readonly name = 'aiDocArchive';
  readonly description =
    '文档中心-归档文档（**写操作**，需确认）：将文档置为已归档（只读，不再参与后续修改）。' +
    '仅文档 owner 或具备 admin 权限者可操作；**重复归档不会重复操作**（直接回放既有结果）。' +
    '示例参数：{"docId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 幂等业务键（AI-25）：同一文档重复归档 = 同一操作 ⇒ 回放 */
  readonly idempotencyKeyFields = ['docId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      docId: { type: 'string', description: '文档 ID（必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiDocEntity)
    private readonly docRepo: Repository<AiDocEntity>,
    private readonly docAcl: DocAclService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const docId =
      typeof args.docId === 'string' && args.docId.trim().length > 0
        ? args.docId.trim()
        : '';
    if (docId.length === 0) {
      return {
        success: false,
        error: 'docId 不能为空',
        suggestion: '请提供要归档的文档 ID（可由 aiDocList 获取）',
      };
    }
    const confirm = args.confirm === true;

    try {
      const doc = await this.docRepo.findOne({ where: { id: docId } });
      if (!doc) {
        return {
          success: false,
          error: `文档不存在：${docId}`,
          suggestion: '请用 aiDocList 查看你有权访问的文档',
        };
      }

      // 权限：仅 canAdmin（owner / 平台 / ACL admin）
      const allowed = await this.docAcl.canAdmin(doc, {
        tenantId: context.tenantId,
        principal: principalOf(context),
      });
      if (!allowed) {
        return {
          success: false,
          error: `无权归档该文档：${docId}`,
          suggestion: '归档需文档 owner 或 admin 权限；请联系文档所有者授权',
        };
      }

      // ── 幂等：已归档 ⇒ 回放（不重复改状态）──
      if (doc.status === 'archived') {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            docId: doc.id,
            status: doc.status,
            duplicate: true,
            message: `文档 ${docId} 已是归档状态，未重复操作`,
          },
        };
      }

      // ── 预览阶段：绝不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '归档文档',
            summary: `将归档文档「${doc.title}」`,
            details: {
              docId,
              currentStatus: doc.status,
              nextStatus: 'archived',
              consequence: '归档后文档变为只读：不可再修改（可查阅）',
            },
          },
        };
      }

      doc.status = 'archived';
      doc.updatedAt = new Date();
      const saved = await this.docRepo.save(doc);

      return {
        success: true,
        data: {
          docId: saved.id,
          status: saved.status,
          message: `文档 ${docId} 已归档（只读）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`归档文档失败：${message}`);
      return {
        success: false,
        error: `归档文档失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
