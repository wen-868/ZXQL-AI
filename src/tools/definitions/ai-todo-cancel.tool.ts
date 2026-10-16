/**
 * aiTodoCancel — 取消待办（**写工具**；R101-AI-41 S1）
 *
 * 背景：批次 2 为"状态变更不绕过幂等"把 `aiTodoUpdate` 做成**不接受 status**（结构性保证），
 * 于是状态入口只剩 `aiTodoComplete` ⇒ **待办没有取消入口**（AI-37 缺口 #2）。本工具补齐。
 *
 * 状态机（对照规范 §2.1）：
 * - 合法迁移：`pending | in_progress → cancelled`
 * - **原子判定**：`UPDATE ... WHERE status IN ('pending','in_progress')`（不先读后写）
 * - **cancelled 是无歧义终态** ⇒ 已 cancelled 再调 ⇒ **回放**（`duplicate:true`）
 * - 🔴 **已 done 再 cancel ⇒ 明确失败**（跨终态：完成不能被"撤销为取消"；
 *   若要撤销完成，是另一个产品动作，本单**不做**）
 *
 * 权限：`canWriteResource`（与 `aiTodoUpdate` 同口径：creator/ACL write/admin）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

@Injectable()
export class AiTodoCancelTool implements ITool {
  private readonly logger = new Logger(AiTodoCancelTool.name);

  readonly name = 'aiTodoCancel';
  readonly description =
    '取消待办（**写操作**，需确认）：把**未完成**（pending/in_progress）的待办置为 cancelled（终态）。' +
    '**已完成的待办不可取消**（会明确失败）；重复取消不会重复改状态（回放）。' +
    '示例参数：{"todoId":"12","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 状态迁移型幂等键：同一待办重复取消 = 同一操作 ⇒ 回放 */
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
          error: `无权取消该待办：${todoId}`,
          suggestion: '需要待办创建者身份，或被授予 write/admin 权限',
        };
      }

      // 同目标终态 ⇒ 回放（cancelled 无歧义）
      if (todo.status === 'cancelled') {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            todoId: todo.id,
            status: todo.status,
            duplicate: true,
            message: `待办 #${todo.id} 已是取消状态，未重复修改`,
          },
        };
      }
      // 🔴 跨终态 ⇒ 明确失败（已完成的不能"撤销为取消"）
      if (todo.status === 'done') {
        return {
          success: false,
          error: `待办 #${todoId} 已完成，不可取消`,
          suggestion:
            '已完成是终态（完成无歧义、不可撤销为取消）；如需重新安排请新建待办',
        };
      }

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '取消待办',
            summary: `将取消待办「${todo.title}」`,
            details: {
              todoId,
              title: todo.title,
              currentStatus: todo.status,
              nextStatus: 'cancelled',
            },
          },
        };
      }

      // ── 原子迁移：条件接受 pending / in_progress ──
      const res = await this.todoRepo.update(
        {
          id: todoId,
          tenantId: todo.tenantId,
          status: In(['pending', 'in_progress']),
        },
        { status: 'cancelled', updatedAt: new Date() },
      );

      if (res.affected === 0) {
        const after = await this.todoRepo.findOne({
          where: { id: todoId, tenantId: todo.tenantId },
        });
        if (after && after.status === 'cancelled') {
          return {
            success: true,
            idempotent_replay: true,
            data: {
              todoId: after.id,
              status: after.status,
              duplicate: true,
              message: `待办 #${after.id} 已是取消状态（并发同操作），未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: after
            ? `取消失败：待办当前状态 ${after.status}（不可取消）`
            : `待办已不存在：${todoId}`,
          suggestion: '请用 aiTodoList 刷新后重试',
        };
      }

      return {
        success: true,
        data: {
          todoId,
          status: 'cancelled',
          message: `待办「${todo.title}」已取消`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`取消待办失败：${message}`);
      return {
        success: false,
        error: `取消待办失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
