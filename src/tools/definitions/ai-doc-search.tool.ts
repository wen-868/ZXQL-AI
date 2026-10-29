/**
 * aiDocSearch — 文档中心 · 结构化 + 向量检索（**读工具**；R101-AI-35 S2 + AI-P1-2）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动（不进写审核门、不耗幂等键、限流走读宽桶）。
 *
 * 检索策略（两路合并，对用户透明）：
 * - 结构化：在 ACL 可见集合内按 keyword 匹配标题/目录/标签（大小写不敏感）
 * - 向量：RetrieverService 旁路检索语义相关分块，**必须先经 ACL 可见集合过滤**
 *   （docName === visibleDoc.id），未授权文档的标题/片段/docId 均不得进入结果
 *
 * 权限永远优先于相关性：ACL 过滤在向量过滤之前执行。
 * embedding/retriever 故障只降级增强能力，不阻断原结构化检索。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15（AI-P1-2 向量分支 2026-10-23）
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { RetrieverService } from '../../rag/retriever.service';
import { RetrievalResult } from '../../rag/vector-store.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

/** 命中项（含命中位置，便于用户理解为什么匹配） */
interface DocHit {
  docId: string;
  title: string;
  category: string;
  status: string;
  version: number;
  matchedIn: Array<'title' | 'category' | 'tags' | 'vector'>;
  snippet?: string;
  score?: number;
}

@Injectable()
export class AiDocSearchTool implements ITool {
  private readonly logger = new Logger(AiDocSearchTool.name);

  readonly name = 'aiDocSearch';
  readonly description =
    '文档中心-检索文档（只读）：在你有权查看的文档中，按关键词匹配**标题/目录/标签**' +
    '（大小写不敏感），并自动进行语义向量检索增强。' +
    '适合"有没有关于采购的文档""合同目录里有哪些""采购合同关键条款""带【酒】标签的文档"等场景。' +
    '示例参数：{"keyword":"采购","category":"contract"}';
  readonly category = 'office' as const;
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

  constructor(
    private readonly docAcl: OfficeAclService,
    @Optional() private readonly retriever?: RetrieverService,
  ) {}

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

      // ACL 可见文档 id 集合（权限永远优先于相关性）
      const visibleIds = new Set(docs.map((d) => d.id));
      const docById = new Map(docs.map((d) => [d.id, d]));

      // ── 结构化检索 ──
      const kw = keyword.toLowerCase();
      const hitMap = new Map<string, DocHit>();

      for (const doc of docs) {
        const matchedIn: Array<'title' | 'category' | 'tags'> = [];
        if (doc.title.toLowerCase().includes(kw)) matchedIn.push('title');
        if (doc.category.toLowerCase().includes(kw)) matchedIn.push('category');
        const tagList = (doc.tags ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
        if (tagList.some((t) => t.toLowerCase().includes(kw))) {
          matchedIn.push('tags');
        }
        if (matchedIn.length > 0) {
          hitMap.set(doc.id, {
            docId: doc.id,
            title: doc.title,
            category: doc.category,
            status: doc.status,
            version: doc.version,
            matchedIn,
          });
        }
      }

      // ── 向量检索（旁路增强，失败不阻断） ──
      if (this.retriever) {
        try {
          const vectorResults: RetrievalResult[] = await this.retriever.search(
            keyword,
            context.tenantId,
            10,
          );
          for (const vr of vectorResults) {
            // ACL 过滤：docName === visibleDoc.id（权限永远优先于相关性）
            if (!visibleIds.has(vr.docName)) continue;
            const doc = docById.get(vr.docName);
            if (!doc) continue;

            const existing = hitMap.get(vr.docName);
            if (existing) {
              if (!existing.matchedIn.includes('vector')) {
                existing.matchedIn.push('vector');
              }
              if (vr.score > (existing.score ?? 0)) {
                existing.score = vr.score;
              }
              if (!existing.snippet) {
                existing.snippet = vr.text.slice(0, 200);
              }
            } else {
              hitMap.set(vr.docName, {
                docId: doc.id,
                title: doc.title,
                category: doc.category,
                status: doc.status,
                version: doc.version,
                matchedIn: ['vector'],
                snippet: vr.text.slice(0, 200),
                score: vr.score,
              });
            }
          }
        } catch (err) {
          // 向量旁路失败不阻断结构化检索
          this.logger.warn(
            `向量检索降级：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── 合并 + 排序 ──
      const hits = Array.from(hitMap.values()).sort((a, b) => {
        const sa = a.score ?? 0;
        const sb = b.score ?? 0;
        if (sb !== sa) return sb - sa;
        return a.title.localeCompare(b.title);
      });

      const hasVector = hits.some((h) => h.matchedIn.includes('vector'));

      return {
        success: true,
        data: {
          keyword,
          total: hits.length,
          hits,
          ...(hits.length === 0
            ? {
                note: '未命中：可尝试更换关键词、调整目录/状态筛选，或浏览文档列表',
              }
            : {}),
          ...(hasVector ? { enhanced: 'vector' } : {}),
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
