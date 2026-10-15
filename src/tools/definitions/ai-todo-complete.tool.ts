/**
 * aiTodoComplete — 完成待办（**写工具**；R101-AI-37 步骤 3）
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）；`idempotencyKeyFields=['todoId']`
 * （完成是**状态迁移** ⇒ 重复操作幂等，同 archive 口径）。
 *
 * 🔴 **原子判定，不先读后写**：
 *   `UPDATE t_ai_todo SET status='done' WHERE tenant_id=? AND id=? AND status <> 'done'`
 *   ⇒ `affected = 0` 即"已完成/不存在" ⇒ 回放（不重复改状态）
 *   这样做的好处：**并发下只有一个请求真正改状态**，不会出现"两个请求都读到 pending 都执行"。
 *   （反测：改成"先查状态再决定" ⇒ 竞态用例红）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiTodoCompleteTool implements ITool {
  private readonly logger = new Logger(AiTodoCompleteTool.name);

  readonly name = 'aiTodoComplete';
  readonly description =
    '完成待办（**写操作**，需确认）：把待办标记为已完成（done）。' +
    '**重复完成不会重复改状态**（自动回放既有结果）。' +
    '示例参数：{"todoId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 状态迁移型幂等键：同一待办重复完成 = 同一操作 */
  readonly idempotencyKeyFields = ['todoId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      todoId: { type: 'string', description: '待办 ID（必填）' },
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
    const todoId =
      typeof args.todoId === 'string' && args.todoId.trim().length > 0
        ? args.todoId.trim()
        : '';
    if (todoId.length === 0) {
      return {
        success: false,
        error: 'todoId 不能为空',
        suggestion: '请用 aiTodoList 获取待办 ID',
      };
    }
    const confirm = args.confirm === true;

    try {
      const todo = await this.todoRepo.findOne({ where: { id: todoId } });
      if (!todo) {
        return {
          success: false,
          error: `待办不存在：${todoId}`,
          suggestion: '请用 aiTodoList 获取待办 ID',
        };
      }

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
          error: `无权完成该待办：${todoId}`,
          suggestion: '需要待办创建者身份，或被授予 write/admin 权限',
        };
      }

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '完成待办',
            summary: `将把待办「${todo.title}」标记为已完成`,
            details: {
              todoId,
              currentStatus: todo.status,
              nextStatus: 'done',
              note: '重复完成不会重复改状态（原子判定 + 回放）',
            },
          },
        };
      }

      // ── 原子完成：条件里带 status <> 'done' ⇒ 并发下只有一个请求真正改状态 ──
      const res = await this.todoRepo.update(
        { id: todoId, tenantId: todo.tenantId, status: Not('done') },
        { status: 'done', updatedAt: new Date() },
      );

      if (res.affected === 0) {
        // affected=0：要么已完成（回放），要么已被删除
        const after = await this.todoRepo.findOne({
          where: { id: todoId, tenantId: todo.tenantId },
        });
        if (after && after.status === 'done') {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              todoId: after.id,
              status: after.status,
              duplicate: true,
              message: `待办 #${after.id} 已是完成状态，未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: `待办状态未能更新（可能已被删除或状态异常）：${todoId}`,
          suggestion: '请用 aiTodoList 刷新后重试',
        };
      }

      return {
        success: true,
        data: {
          todoId,
          status: 'done',
          message: `待办 #${todoId} 已完成`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`完成待办失败：${message}`);
      return {
        success: false,
        error: `完成待办失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
