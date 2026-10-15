/**
 * aiTodoList — 待办清单（**读工具**；R101-AI-37 步骤 3）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动（不进写审核门、不耗幂等键、走读宽桶）。
 *
 * ⚠️ 权限实现（凌舟 R101-AI-37 裁定 ①，**与文档工具的差异已记在注释里**）：
 * - 文档工具**只依赖 ACL 服务**（结构上不可架空）；本工具因需按 assignee/status/due 查询，
 *   必须注入 `todoRepo` ⇒ 结构防线变弱
 * - 因此本工具**把 ACL 可见集作为库查询条件**（库层隔离）：
 *   `tenant_id = ? AND (id IN (:...granted) OR created_by = :me OR assignee IN (:me))`
 *   **绝不允许**"先查全量再内存过滤"（一旦过滤被绕过 ⇒ 泄漏全量）
 * - 之后再逐行 `resolveResource` 确认（纵深防御；反测：绕过 ACL ⇒ 红）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { AiTodoEntity } from '../../database/entities/ai-todo.entity';
import {
  OfficeAclContext,
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';

/** 清单项（摘要） */
interface TodoItem {
  todoId: string;
  title: string;
  assignee: string;
  status: string;
  priority: string;
  dueAt: string | null;
  source: string;
}

@Injectable()
export class AiTodoListTool implements ITool {
  private readonly logger = new Logger(AiTodoListTool.name);

  readonly name = 'aiTodoList';
  readonly description =
    '待办清单（只读）：列出当前用户**有权查看**的待办（自己创建的、指派给自己的、或被 ACL 授权的），' +
    '可按负责人（assignee）、状态（pending|in_progress|done|cancelled）、截止时间（dueBefore）筛选。' +
    '示例参数：{"status":"pending","dueBefore":"2026-10-20"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      assignee: {
        type: 'string',
        description: '负责人筛选（可选；如 user:u-1 或 employee:e-1）',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done', 'cancelled'],
        description: '状态筛选（可选；非法值忽略）',
      },
      dueBefore: {
        type: 'string',
        description: '截止时间上限（可选，ISO 日期；如 2026-10-20）',
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
    const principal: OfficePrincipal = principalOf(context);
    const ctx: OfficeAclContext = { tenantId: context.tenantId, principal };

    const assignee =
      typeof args.assignee === 'string' && args.assignee.trim().length > 0
        ? args.assignee.trim()
        : undefined;
    const status =
      args.status === 'pending' ||
      args.status === 'in_progress' ||
      args.status === 'done' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const dueBefore =
      typeof args.dueBefore === 'string' && args.dueBefore.trim().length > 0
        ? new Date(args.dueBefore)
        : undefined;

    try {
      // ① ACL 可见集（库层隔离的关键输入）
      const grantedIds = principal.isPlatform
        ? []
        : await this.officeAcl.aclGrantedIds('todo', ctx);
      const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;

      // ② 库层条件：租户 + (ACL 可见 OR 自己创建 OR 指派给自己)；平台身份跨租户
      const base: Record<string, unknown> = {};
      if (!principal.isPlatform) base.tenantId = context.tenantId;
      if (status !== undefined) base.status = status;
      if (assignee !== undefined) base.assignee = assignee;
      if (dueBefore !== undefined && !Number.isNaN(dueBefore.getTime())) {
        base.dueAt = LessThanOrEqual(dueBefore);
      }

      // 非平台：用 OR 收窄到"可见候选集"（**不是全量**）
      const visibility = principal.isPlatform
        ? [base]
        : [
            { ...base, id: In(grantedIds.length > 0 ? grantedIds : ['-1']) },
            { ...base, createdBy: principal.id },
            { ...base, assignee: me },
          ];

      const rows = await this.todoRepo.find({ where: visibility });

      // ③ 纵深防御：逐行确认（ACL 或 creator 或 assignee）
      const visible: TodoItem[] = [];
      for (const todo of rows) {
        const resource = {
          resourceType: 'todo' as const,
          resourceId: todo.id,
          tenantId: todo.tenantId,
          owner: todo.createdBy,
        };
        const access = await this.officeAcl.resolveResource(resource, ctx);
        const isCreator =
          todo.createdBy !== null && todo.createdBy === principal.id;
        const isAssignee = todo.assignee === me;
        if (access !== 'none' || isCreator || isAssignee) {
          visible.push({
            todoId: todo.id,
            title: todo.title,
            assignee: todo.assignee,
            status: todo.status,
            priority: todo.priority,
            dueAt: todo.dueAt ? new Date(todo.dueAt).toISOString() : null,
            source: todo.source,
          });
        }
      }

      return {
        success: true,
        data: {
          total: visible.length,
          list: visible,
          aclBucket: {
            resourceType: 'todo',
            grantedCount: grantedIds.length,
            scope: principal.isPlatform
              ? 'platform(跨租户)'
              : 'tenant+creator+assignee',
          },
          ...(visible.length === 0
            ? { note: '当前没有你有权查看的待办（或筛选条件下无匹配）' }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`待办清单查询失败：${message}`);
      return {
        success: false,
        error: `待办清单查询失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
