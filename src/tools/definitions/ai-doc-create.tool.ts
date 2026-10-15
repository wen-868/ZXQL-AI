/**
 * aiDocCreate — 文档中心 · AI 生成内容入库（**写工具**；R101-AI-35 S2）
 *
 * 治理链：`isWriteOperation=true` ⇒ 走**写全审核**（preview → 用户确认 → confirm 才落库）+
 * 幂等（唯一键 `(tenant_id, content_hash)` ⇒ 同内容重复入库**回放**既有文档，不新增行）。
 *
 * 语义要点：
 * - `source_type='generated'`（AI 生成）；`owner` = 调用者（`context.userId`）⇒ 由 DocAclService
 *   的"owner ⇒ admin"规则自然取得管理权
 * - `content_hash = sha256(content)` ⇒ 幂等依据（与迁移 018 的 `uk_ai_doc_tenant_hash` 一致）
 * - **preview 阶段绝不落库**（红线：预览不消耗任何幂等键、不写库）
 * - `execute` 禁抛异常：所有错误经 `ToolResult.success=false` 返回
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { ITool, ToolContext, ToolResult } from '../tool.interface';

/** 解析后的入参 */
interface CreateDocArgs {
  title: string;
  content: string;
  category: string;
  tags?: string;
  confirm: boolean;
}

@Injectable()
export class AiDocCreateTool implements ITool {
  private readonly logger = new Logger(AiDocCreateTool.name);

  readonly name = 'aiDocCreate';
  readonly description =
    '文档中心-新建文档（**写操作**，需确认）：把 AI 生成/整理好的内容入库为文档中心的一份文档，' +
    '可指定目录（category）。同租户**同内容**重复入库会自动回放既有文档（不产生重复）。' +
    '流程：先返回预览卡片，用户确认后再真正入库。' +
    '示例参数：{"title":"2026 采购合同要点","content":"...","category":"contract","confirm":false}';
  // 归入既有分类体系的"报表分析"桶（办公域第一批；ToolCategory 暂无 office 值，
  // 若后续新增 'office' 分类，此处一行切换即可）
  readonly category = 'report' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '文档标题（必填，非空）' },
      content: { type: 'string', description: '文档正文（必填，非空）' },
      category: {
        type: 'string',
        description:
          '目录/分类（可选，默认 default；如 contract/policy/manual）',
      },
      tags: { type: 'string', description: '标签（可选，逗号分隔）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不入库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiDocEntity)
    private readonly docRepo: Repository<AiDocEntity>,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const { title, content, category, confirm } = parsed.data;
    const contentHash = sha256(content);
    // R101-AI-35 tags 补齐：入库前归一化（去空项/去重/trim/总长截断 500）
    const tagsInfo = normalizeTags(parsed.data.tags);

    // ── 预览阶段：**绝不落库**（红线）──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '新建文档',
          summary: `将入库文档「${title}」（目录：${category}，正文 ${content.length} 字）`,
          details: {
            title,
            category,
            contentLength: content.length,
            contentHash,
            sourceType: 'generated',
            owner: context.userId,
            tags: tagsInfo.value,
            // 超长截断**如实展示**（不静默）
            ...(tagsInfo.truncated
              ? {
                  tagsTruncated: true,
                  tagsNote: `标签超长已截断至 ${tagsInfo.value?.split(',').length ?? 0} 个（上限 500 字符）`,
                }
              : {}),
            note: '确认后入库；同租户同内容重复入库将自动回放既有文档',
          },
        },
      };
    }

    try {
      // ── 幂等：同 (tenant_id, content_hash) ⇒ 回放既有文档（不新增行）──
      const existed = await this.docRepo.findOne({
        where: { tenantId: context.tenantId, contentHash },
      });
      if (existed) {
        this.logger.log(
          `文档已存在，回放：tenant=${context.tenantId} doc=${existed.id}`,
        );
        return {
          success: true,
          idempotent_replay: true,
          data: {
            docId: existed.id,
            title: existed.title,
            category: existed.category,
            status: existed.status,
            duplicate: true,
            message: `同内容文档已存在（文档ID=${existed.id}），已直接复用，未重复入库`,
          },
        };
      }

      const saved = await this.docRepo.save(
        this.docRepo.create({
          tenantId: context.tenantId,
          title,
          category,
          owner: context.userId,
          sourceType: 'generated',
          contentHash,
          tags: tagsInfo.value,
          storagePath: null,
          status: 'active',
          version: 1,
          createdBy: context.userId,
        }),
      );

      return {
        success: true,
        data: {
          docId: saved.id,
          title: saved.title,
          category: saved.category,
          status: saved.status,
          contentHash,
          message: `文档「${title}」已入库（文档ID=${saved.id}）`,
        },
      };
    } catch (err) {
      // 竞态兜底：唯一键冲突（并发同内容）⇒ 再读一次并回放，不把错误抛给用户
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE|Duplicate|constraint/i.test(message)) {
        const raced = await this.docRepo.findOne({
          where: { tenantId: context.tenantId, contentHash },
        });
        if (raced) {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              docId: raced.id,
              duplicate: true,
              message: `同内容文档已存在（文档ID=${raced.id}），已直接复用`,
            },
          };
        }
      }
      this.logger.error(`文档入库失败：${message}`);
      return {
        success: false,
        error: `文档入库失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  /** 入参解析（title/content 必填非空） */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: CreateDocArgs }
    | { valid: false; error: string; suggestion: string } {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (title.length === 0) {
      return {
        valid: false,
        error: 'title 不能为空',
        suggestion: '请提供文档标题',
      };
    }
    const content = typeof args.content === 'string' ? args.content : '';
    if (content.trim().length === 0) {
      return {
        valid: false,
        error: 'content 不能为空',
        suggestion: '请提供文档正文',
      };
    }
    const category =
      typeof args.category === 'string' && args.category.trim().length > 0
        ? args.category.trim()
        : 'default';
    const tags =
      typeof args.tags === 'string' && args.tags.trim().length > 0
        ? args.tags.trim()
        : undefined;
    const confirm = args.confirm === true;

    return { valid: true, data: { title, content, category, tags, confirm } };
  }
}

/** 内容哈希（sha256 hex；与迁移 018 的 uk_ai_doc_tenant_hash 口径一致） */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * 标签归一化（R101-AI-35 tags 补齐）
 *
 * 口径：逗号分隔串 ⇒ 去空项、去重（保序）、trim、**总长截断 500**（截断不报错，
 * 但由调用方在 preview 里**如实展示**"已截断"——不搞静默）。
 */
export function normalizeTags(raw?: string): {
  value: string | null;
  truncated: boolean;
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { value: null, truncated: false };
  }
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const piece of raw.split(',')) {
    const tag = piece.trim();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    parts.push(tag);
  }
  if (parts.length === 0) return { value: null, truncated: false };

  const LIMIT = 500;
  const joined = parts.join(',');
  if (joined.length <= LIMIT) return { value: joined, truncated: false };

  // 截断到 limit 内**最后一个完整标签**（不切断标签）
  let acc = '';
  for (const tag of parts) {
    const next = acc.length === 0 ? tag : `${acc},${tag}`;
    if (next.length > LIMIT) break;
    acc = next;
  }
  return {
    value: acc.length > 0 ? acc : parts[0].slice(0, LIMIT),
    truncated: true,
  };
}
