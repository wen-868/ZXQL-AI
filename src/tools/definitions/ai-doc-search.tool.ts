/**
 * aiDocSearch — 文档中心 · 结构化检索（**读工具**；R101-AI-35 S2 收官）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动（不进写审核门、不耗幂等键、限流走读宽桶）。
 *
 * 范围（**只做结构化**，向量检索归 S3）：
 * - 在 **ACL 可见集合**内按 `keyword` 匹配**标题 / 目录**（大小写不敏感）
 * - ⚠️ **标签（tags）暂不参与检索**：`t_ai_doc` 目前**没有 tags 列**（S1 迁移未含）⇒
 *   标签检索需先加列（增量脚本），**不在本步假装支持**
 *
 * ⚠️ 红线：**必经 `DocAclService.listVisible`** —— 工具只依赖 ACL 服务（结构上拿不到仓储），
 *    从根上无法绕过 ACL（反测："绕过 ACL 直查" ⇒ 红）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { DocAclService } from '../../rag/doc-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

/** 命中项（含命中位置，便于用户理解为什么匹配） */
interface DocHit {
  docId: string;
  title: string;
  category: string;
  status: string;
  version: number;
  matchedIn: Array<'title' | 'category' | 'tags'>;
}

@Injectable()
export class AiDocSearchTool implements ITool {
  private readonly logger = new Logger(AiDocSearchTool.name);

  readonly name = 'aiDocSearch';
  readonly description =
    '文档中心-检索文档（只读，**结构化检索**）：在你有权查看的文档中，按关键词匹配**标题/目录/标签**' +
    '（大小写不敏感；标签按单个标签匹配）。注意：本工具不做语义/向量检索（归知识库检索）。' +
    '适合"有没有关于采购的文档""合同目录里有哪些""带【酒】标签的文档"等场景。' +
    '示例参数：{"keyword":"采购","category":"contract"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      keyword: { type: 'string', description: '关键词（必填，匹配标题/目录）' },
      category: { type: 'string', description: '目录筛选（可选）' },
      status: {
        type: 'string',
        enum: ['active', 'archived'],
        description: '状态筛选（可选；非法值忽略）',
      },
    },
  };

  constructor(private readonly docAcl: DocAclService) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const keyword = typeof args.keyword === 'string' ? args.keyword.trim() : '';
    if (keyword.length === 0) {
      return {
        success: false,
        error: 'keyword 不能为空',
        suggestion: '请提供要检索的关键词（匹配标题/目录）',
      };
    }
    const category =
      typeof args.category === 'string' && args.category.trim().length > 0
        ? args.category.trim()
        : undefined;
    const status =
      args.status === 'active' || args.status === 'archived'
        ? args.status
        : undefined;

    try {
      // ⚠️ 必经 ACL：先在**可见集合**内检索（直查仓储会架空 ACL ⇒ 反测必红）
      const docs: AiDocEntity[] = await this.docAcl.listVisible(
        { tenantId: context.tenantId, principal: principalOf(context) },
        { category, status },
      );

      const kw = keyword.toLowerCase();
      const hits: DocHit[] = [];
      for (const doc of docs) {
        const matchedIn: Array<'title' | 'category' | 'tags'> = [];
        if (doc.title.toLowerCase().includes(kw)) matchedIn.push('title');
        if (doc.category.toLowerCase().includes(kw)) matchedIn.push('category');
        // R101-AI-35 tags 补齐：**按单个标签**匹配（逗号拆开，非整串模糊）
        const tagList = (doc.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (tagList.some((t) => t.toLowerCase().includes(kw))) {
          matchedIn.push('tags');
        }
        if (matchedIn.length > 0) {
          hits.push({
            docId: doc.id,
            title: doc.title,
            category: doc.category,
            status: doc.status,
            version: doc.version,
            matchedIn,
          });
        }
      }

      return {
        success: true,
        data: {
          keyword,
          total: hits.length,
          hits,
          ...(hits.length === 0
            ? {
                note: '未命中：本工具按标题/目录/标签做结构化匹配；若需语义检索请使用知识库检索（S3 贯通后可用）',
              }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`检索文档失败：${message}`);
      return {
        success: false,
        error: `检索文档失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
