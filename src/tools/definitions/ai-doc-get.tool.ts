/**
 * aiDocGet — 文档中心 · 取单篇（**读工具**；R101-AI-35 S2）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动（不进写审核门、不耗幂等键）。
 *
 * 权限与"不泄露存在性"：
 * - **只依赖 `DocAclService`**（结构上拿不到仓储 ⇒ 无法绕过 ACL ⇒ 反测"直查 bypass"无从实现）
 * - `getVisible` 对无权文档返回 `doc=null` ⇒ 本工具统一按"**文档不存在**"口径回复，
 *   **不区分**"不存在"与"存在但无权"（防信息泄漏；S4 反测：改成"存在但无权"⇒ 红）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { DocAclService } from '../../rag/doc-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiDocGetTool implements ITool {
  private readonly logger = new Logger(AiDocGetTool.name);

  readonly name = 'aiDocGet';
  readonly description =
    '文档中心-查看文档详情（只读）：按文档 ID 返回元数据与访问级别（read/write/admin）。' +
    '**无权限时统一返回"文档不存在"**（不透露"存在但无权"）。' +
    '适合"打开那份合同""文档 12 是什么"等场景。示例参数：{"docId":"12"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      docId: { type: 'string', description: '文档 ID（必填）' },
    },
  };

  constructor(private readonly docAcl: DocAclService) {}

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
        suggestion: '请提供文档 ID（可由 aiDocList 获取）',
      };
    }

    try {
      const { doc, access } = await this.docAcl.getVisible(docId, {
        tenantId: context.tenantId,
        principal: principalOf(context),
      });

      // 无权与不存在**同一口径**（防存在性泄漏）
      if (!doc) {
        return {
          success: false,
          error: `文档不存在：${docId}`,
          suggestion: '请用 aiDocList 查看你有权访问的文档',
        };
      }

      return {
        success: true,
        data: {
          docId: doc.id,
          title: doc.title,
          category: doc.category,
          owner: doc.owner,
          sourceType: doc.sourceType,
          status: doc.status,
          version: doc.version,
          contentHash: doc.contentHash,
          // R101-AI-35 tags 补齐
          tags: doc.tags ?? null,
          storagePath: doc.storagePath,
          createdAt: new Date(doc.createdAt).toISOString(),
          updatedAt: new Date(doc.updatedAt).toISOString(),
          access: access,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`取文档详情失败：${message}`);
      return {
        success: false,
        error: `取文档详情失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
