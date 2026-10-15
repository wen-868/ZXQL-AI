/**
 * aiTodoUpdate — 修改待办（**写工具**；R101-AI-37 步骤 3）
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）。
 *
 * 🔴 **不接受 `status`**：状态变更一律走 `aiTodoComplete`（完成）/ 取消路径。
 *   理由（凌舟裁定 ②）：状态变更是**幂等语义**（重复操作要回放），而内容修改不需要；
 *   从接口上堵住"改状态绕过幂等"比事后补锁更可靠 —— 传 `status` 一律**明确拒绝**并给出正确入口。
 *
 * 权限：`canWriteResource`（**非** canRead）—— 只读授权不得修改。
 *
 * ⚠️ **改 `assignee` 不会自动重新派单**（本批裁定③：派单仅在创建时发生；重派/回写独立立项）。
 *    描述里已向用户说明，避免误以为"改负责人 = 自动派活"。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiTodoEntity,
  TodoPriority,
} from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

interface UpdateTodoArgs {
  todoId: string;
  title?: string;
  description?: string;
  priority?: TodoPriority;
  dueAt?: Date;
  assignee?: string;
  confirm: boolean;
}

@Injectable()
export class AiTodoUpdateTool implements ITool {
  private readonly logger = new Logger(AiTodoUpdateTool.name);

  readonly name = 'aiTodoUpdate';
  readonly description =
    '修改待办（**写操作**，需确认）：改标题/说明/优先级/截止时间/负责人。' +
    '**不接受状态修改**——要标记完成请用 aiTodoComplete。' +
    '注意：修改负责人**不会自动重新派单**（派单只发生在创建时）。' +
    '示例参数：{"todoId":"12","priority":"high","dueAt":"2026-10-22","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      todoId: { type: 'string', description: '待办 ID（必填）' },
      title: { type: 'string', description: '新标题（可选）' },
      description: { type: 'string', description: '新说明（可选）' },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: '新优先级（可选）',
      },
      dueAt: { type: 'string', description: '新截止时间（可选，ISO 日期）' },
      assignee: {
        type: 'string',
        description:
          '新负责人（可选，user:{id} / employee:{id}；不会自动派单）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiTodoEntity)
    private readonly todoRepo: Repository<AiTodoEntity>,
    private readonly officeAcl: OfficeAclService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // 🔴 状态变更必须走 complete：**先于一切**明确拒绝（不看 confirm）
    if (args.status !== undefined) {
      return {
        success: false,
        error: '本工具不接受 status 修改（避免绕过"重复完成"的幂等语义）',
        suggestion: '标记完成请用 aiTodoComplete；取消请用取消流程',
      };
    }

    const parsed = this.parseArgs(args);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const { todoId, title, description, priority, dueAt, assignee, confirm } =
      parsed.data;

    try {
      const todo = await this.todoRepo.findOne({ where: { id: todoId } });
      if (!todo) {
        return {
          success: false,
          error: `待办不存在：${todoId}`,
          suggestion: '请用 aiTodoList 获取待办 ID',
        };
      }

      // 权限：**canWriteResource**（只读授权不得修改）
      const allowed = await this.officeAcl.canWriteResource(
        {
          resourceType: 'todo',
          resourceId: todo.id,
          tenantId: todo.tenantId,
          owner: todo.createdBy,
        },
        { tenantId: context.tenantId, principal: principalOf(context) },
      );
      if (!allowed) {
        return {
          success: false,
          error: `无权修改该待办：${todoId}`,
          suggestion: '需要待办创建者身份，或被授予 write/admin 权限',
        };
      }

      const changes = {
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(dueAt !== undefined ? { dueAt } : {}),
        ...(assignee !== undefined ? { assignee } : {}),
      };

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '修改待办',
            summary: `将修改待办「${todo.title}」的 ${Object.keys(changes).join('、') || '（无字段变化）'}`,
            details: {
              todoId,
              current: {
                title: todo.title,
                priority: todo.priority,
                dueAt: todo.dueAt ? new Date(todo.dueAt).toISOString() : null,
                assignee: todo.assignee,
              },
              changes,
              statusNote: '状态不在可改字段内（请用 aiTodoComplete）',
              dispatchNote: '修改负责人不会自动派单',
            },
          },
        };
      }

      todo.title = title ?? todo.title;
      todo.description =
        description !== undefined ? description : todo.description;
      todo.priority = priority ?? todo.priority;
      todo.dueAt = dueAt !== undefined ? dueAt : todo.dueAt;
      todo.assignee = assignee ?? todo.assignee;
      todo.updatedAt = new Date();
      const saved = await this.todoRepo.save(todo);

      return {
        success: true,
        data: {
          todoId: saved.id,
          title: saved.title,
          assignee: saved.assignee,
          priority: saved.priority,
          dueAt: saved.dueAt ? new Date(saved.dueAt).toISOString() : null,
          status: saved.status,
          changed: Object.keys(changes),
          message: `待办 #${saved.id} 已更新（状态保持 ${saved.status}）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`修改待办失败：${message}`);
      return {
        success: false,
        error: `修改待办失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  private parseArgs(
    args: Record<string, unknown>,
  ):
    | { valid: true; data: UpdateTodoArgs }
    | { valid: false; error: string; suggestion: string } {
    const todoId =
      typeof args.todoId === 'string' && args.todoId.trim().length > 0
        ? args.todoId.trim()
        : '';
    if (todoId.length === 0) {
      return {
        valid: false,
        error: 'todoId 不能为空',
        suggestion: '请提供待办 ID',
      };
    }
    let dueAt: Date | undefined;
    if (typeof args.dueAt === 'string' && args.dueAt.trim().length > 0) {
      const d = new Date(args.dueAt);
      if (Number.isNaN(d.getTime())) {
        return {
          valid: false,
          error: `dueAt 不是合法日期：${args.dueAt}`,
          suggestion: '如 2026-10-22',
        };
      }
      dueAt = d;
    }
    const assignee =
      typeof args.assignee === 'string' && args.assignee.trim().length > 0
        ? args.assignee.trim()
        : undefined;
    if (
      assignee !== undefined &&
      !/^(user|employee):[A-Za-z0-9_-]+$/.test(assignee)
    ) {
      return {
        valid: false,
        error: `assignee 格式非法：${assignee}`,
        suggestion: '负责人须形如 user:{id} 或 employee:{id}',
      };
    }
    return {
      valid: true,
      data: {
        todoId,
        title:
          typeof args.title === 'string' && args.title.trim().length > 0
            ? args.title.trim()
            : undefined,
        description:
          typeof args.description === 'string' ? args.description : undefined,
        priority:
          args.priority === 'low' ||
          args.priority === 'normal' ||
          args.priority === 'high'
            ? args.priority
            : undefined,
        dueAt,
        assignee,
        confirm: args.confirm === true,
      },
    };
  }
}
