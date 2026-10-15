/**
 * aiDocList — 文档中心 · 列文档（**读工具**；R101-AI-35 S2）
 *
 * 治理链：`isWriteOperation=false` ⇒ **读全自动**（不进写审核门、不耗幂等键、限流走读宽桶）。
 *
 * ⚠️ 红线：**必须经 `DocAclService.listVisible` 过滤** —— 不得直接 `docRepo.find` 列表，
 *    否则 ACL 被架空（S2 反测第 3 组：把本工具改成直查 ⇒ 用例必红）。
 *
 * 身份来源（ToolContext → DocPrincipal）：
 * - `userId` ⇒ `user`
 * - `role`   ⇒ 附带 roles（命中 role 维度授权）
 * - `employeeId`（数字员工链路）⇒ `employee`（类型优先取 employee）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { DocAclService, DocPrincipal } from '../../rag/doc-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';

/** 列表项（摘要：不返回全文，避免列表接口过大） */
interface DocListItem {
  docId: string;
  title: string;
  category: string;
  owner: string | null;
  status: string;
  version: number;
  updatedAt: string;
}

@Injectable()
export class AiDocListTool implements ITool {
  private readonly logger = new Logger(AiDocListTool.name);

  readonly name = 'aiDocList';
  readonly description =
    '文档中心-列出文档（只读）：返回当前用户**有权查看**的文档清单（标题/目录/归属/状态/版本），' +
    '可按目录（category）与状态（active|archived）筛选。无权文档不会出现在结果中。' +
    '适合"我有哪些文档""合同目录下有什么"等场景。' +
    '示例参数：{"category":"contract"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      category: {
        type: 'string',
        description: '目录/分类筛选（可选；如 contract/policy/manual）',
      },
      status: {
        type: 'string',
        enum: ['active', 'archived'],
        description: '状态筛选（可选；缺省全部）',
      },
    },
  };

  constructor(private readonly docAcl: DocAclService) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const category =
      typeof args.category === 'string' && args.category.trim().length > 0
        ? args.category.trim()
        : undefined;
    const status =
      args.status === 'active' || args.status === 'archived'
        ? args.status
        : undefined;

    try {
      // ⚠️ 必经 ACL：无权文档在此被过滤掉（直查 docRepo 会架空 ACL ⇒ 反测必红）
      const docs: AiDocEntity[] = await this.docAcl.listVisible(
        { tenantId: context.tenantId, principal: principalOf(context) },
        { category, status },
      );

      const list: DocListItem[] = docs.map((doc) => ({
        docId: doc.id,
        title: doc.title,
        category: doc.category,
        owner: doc.owner,
        status: doc.status,
        version: doc.version,
        updatedAt: new Date(doc.updatedAt).toISOString(),
      }));

      return {
        success: true,
        data: {
          total: list.length,
          list,
          ...(list.length === 0
            ? { note: '当前没有你有权查看的文档（或筛选条件下无匹配）' }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`列文档失败：${message}`);
      return {
        success: false,
        error: `列文档失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}

/** 从工具上下文推导主体身份（数字员工优先） */
export function principalOf(context: ToolContext): DocPrincipal {
  const extended = context as ToolContext & { employeeId?: string };
  if (
    typeof extended.employeeId === 'string' &&
    extended.employeeId.length > 0
  ) {
    return { type: 'employee', id: extended.employeeId };
  }
  const roles =
    typeof context.role === 'string' && context.role.length > 0
      ? [context.role]
      : undefined;
  return {
    type: 'user',
    id: String(context.userId),
    ...(roles ? { roles } : {}),
  };
}
