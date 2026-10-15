/**
 * aiDocUpdate — 文档中心 · 修改文档（**写工具**；R101-AI-35 S2）
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）。
 *
 * 三条口径（凌舟裁定 2026-10-15）：
 * 1. **更新不参与 create 的幂等键**（create 的幂等保护"重复入库"；update 保护"重复提交同一变更"）
 * 2. **同内容更新 ⇒ `version` 不递增**（避免无意义版本膨胀；`content_hash` 不变）
 * 3. 🔴 **乐观锁（必备，多端协作）**：按 `(tenant, docId, expectedVersion)` 校验 ——
 *    用户 preview 看到 `version=3` ⇒ confirm 时库里若已是 `version=4`（他人改过）⇒ **明确拒绝**
 *    "文档已被他人修改，请刷新后重试"，**绝不静默覆盖**
 *
 * 权限：`DocAclService.canWrite`（write/admin 且非 archived）；无权 ⇒ 明确拒绝且不落库。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { AiDocEntity } from '../../database/entities/ai-doc.entity';
import { DocAclService } from '../../rag/doc-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

interface UpdateDocArgs {
  docId: string;
  expectedVersion: number;
  title?: string;
  content?: string;
  category?: string;
  confirm: boolean;
}

@Injectable()
export class AiDocUpdateTool implements ITool {
  private readonly logger = new Logger(AiDocUpdateTool.name);

  readonly name = 'aiDocUpdate';
  readonly description =
    '文档中心-修改文档（**写操作**，需确认）：修改标题/正文/目录。' +
    '**必须传 expectedVersion**（乐观锁）：若期间已被他人修改则拒绝并提示刷新，绝不静默覆盖。' +
    '正文未变时版本号不递增（避免无意义膨胀）。' +
    '示例参数：{"docId":"12","expectedVersion":3,"title":"新标题","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      docId: { type: 'string', description: '文档 ID（必填）' },
      expectedVersion: {
        type: 'integer',
        description: '期望版本号（必填，乐观锁；取自上次读取到的 version）',
      },
      title: { type: 'string', description: '新标题（可选）' },
      content: {
        type: 'string',
        description: '新正文（可选；变更则 version+1）',
      },
      category: { type: 'string', description: '新目录（可选）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览，不落库）',
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
    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const { docId, expectedVersion, title, content, category, confirm } =
      parsed.data;

    try {
      const doc = await this.docRepo.findOne({ where: { id: docId } });
      if (!doc) {
        return {
          success: false,
          error: `文档不存在：${docId}`,
          suggestion: '请先用 aiDocList 确认文档 ID',
        };
      }

      // 权限：canWrite（write/admin 且非 archived）
      const allowed = await this.docAcl.canWrite(doc, {
        tenantId: context.tenantId,
        principal: principalOf(context),
      });
      if (!allowed) {
        return {
          success: false,
          error: `无权修改该文档（或文档已归档）：${docId}`,
          suggestion:
            '请确认你是文档 owner、或已被授予 write/admin 权限；已归档文档不可再修改',
        };
      }

      const nextHash =
        typeof content === 'string' && content.trim().length > 0
          ? sha256(content)
          : doc.contentHash;
      const contentChanged = nextHash !== doc.contentHash;
      const titleChanged =
        typeof title === 'string' &&
        title.trim().length > 0 &&
        title !== doc.title;
      const categoryChanged =
        typeof category === 'string' &&
        category.trim().length > 0 &&
        category !== doc.category;
      const nextVersion = contentChanged ? doc.version + 1 : doc.version;

      // ── 预览阶段：绝不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '修改文档',
            summary: `将修改文档「${doc.title}」${contentChanged ? '（正文变更 ⇒ 版本 +1）' : titleChanged || categoryChanged ? '（仅元数据变更）' : '（无实际变更）'}`,
            details: {
              docId,
              expectedVersion,
              currentVersion: doc.version,
              nextVersion,
              contentChanged,
              titleChanged,
              categoryChanged,
            },
          },
        };
      }

      // ── confirm：乐观锁校验（🔴 绝不静默覆盖） ──
      if (doc.version !== expectedVersion) {
        this.logger.warn(
          `乐观锁拒绝：doc=${docId} expected=${expectedVersion} actual=${doc.version}`,
        );
        return {
          success: false,
          error: `文档已被他人修改（期望版本 ${expectedVersion}，当前版本 ${doc.version}），本次修改未执行`,
          suggestion: '请刷新文档后重新提交修改',
        };
      }

      // 无实际变更 ⇒ 不落库、不递增版本
      if (!contentChanged && !titleChanged && !categoryChanged) {
        return {
          success: true,
          data: {
            docId,
            version: doc.version,
            unchanged: true,
            message: '内容与元数据均未变化，未产生新版本',
          },
        };
      }

      doc.title = titleChanged ? String(title) : doc.title;
      doc.category = categoryChanged ? String(category) : doc.category;
      doc.contentHash = nextHash;
      doc.version = nextVersion;
      doc.updatedAt = new Date();
      const saved = await this.docRepo.save(doc);

      return {
        success: true,
        data: {
          docId: saved.id,
          version: saved.version,
          contentChanged,
          message: `文档「${saved.title}」已更新（版本 ${saved.version}）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`文档更新失败：${message}`);
      return {
        success: false,
        error: `文档更新失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  /** 入参解析（docId + expectedVersion 必填） */
  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: UpdateDocArgs }
    | { valid: false; error: string; suggestion: string } {
    const docId =
      typeof args.docId === 'string' && args.docId.trim().length > 0
        ? args.docId.trim()
        : '';
    if (docId.length === 0) {
      return {
        valid: false,
        error: 'docId 不能为空',
        suggestion: '请提供要修改的文档 ID（可由 aiDocList 获取）',
      };
    }
    const expectedVersion = Number(args.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      return {
        valid: false,
        error: `expectedVersion 非法：${String(args.expectedVersion)}（必填，正整数，乐观锁）`,
        suggestion: '请先读取文档拿到当前 version 后再提交修改',
      };
    }
    return {
      valid: true,
      data: {
        docId,
        expectedVersion,
        title: typeof args.title === 'string' ? args.title : undefined,
        content: typeof args.content === 'string' ? args.content : undefined,
        category: typeof args.category === 'string' ? args.category : undefined,
        confirm: args.confirm === true,
      },
    };
  }
}

/** 内容哈希（与 aiDocCreate / 迁移 018 的唯一键口径一致） */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
