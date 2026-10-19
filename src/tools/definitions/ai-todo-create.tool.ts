/**
 * aiTodoCreate — 新建待办（**写工具**；R101-AI-37 步骤 3）
 *
 * 治理链：`isWriteOperation=true` ⇒ 写全审核（preview → confirm）；`risk='medium'`
 * （建单本身低风险，但 `assignee='employee:xxx'` 会**派活给数字员工** ⇒ 提到 medium）。
 *
 * 幂等**双保险**（凌舟裁定）：
 * 1. **业务幂等**：同 `(tenant, title, assignee)` 且**未完结**（status ∉ done/cancelled）已存在 ⇒ 回放
 *    —— 兜住 `due_at` 为 NULL 时 MySQL/sqlite 唯一键语义差异（多 NULL 不冲突）
 * 2. **DB 唯一键** `(tenant_id, title, assignee, due_at)`：并发竞态下唯一键冲突 ⇒ 再读一次并回放
 *    ⇒ 说明**哪层承重**：业务层挡"日常重复提交"，DB 层挡"并发同时提交"
 *
 * 数字员工派单（**复用既有路径，不新建**）：`assignee='employee:xxx'` ⇒ 调用既有
 * `DispatchEmployeeTaskTool.execute({ target: xxx, task, taskType:'todo' })`（其内部走 `employeeService.dispatchTask`）。
 * ⚠️ 回写（员工完成 ⇒ 待办自动 done）**本批不做**（凌舟裁定 ③：独立立项；**不碰 `src/brain/employee/*`**）。
 * 🔴 派单失败**不影响建单**（主次不倒置）：待办仍入库，仅 `dispatch.status='failed'`。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import {
  AiTodoEntity,
  TodoPriority,
} from '../../database/entities/ai-todo.entity';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { DispatchEmployeeTaskTool } from './dispatch-employee-task.tool';

interface CreateTodoArgs {
  title: string;
  assignee: string;
  description?: string;
  priority: TodoPriority;
  dueAt?: Date;
  confirm: boolean;
}

@Injectable()
export class AiTodoCreateTool implements ITool {
  private readonly logger = new Logger(AiTodoCreateTool.name);

  readonly name = 'aiTodoCreate';
  readonly description =
    '新建待办（**写操作**，需确认）：把一件事登记为待办，可指定负责人（user:{id} 或 employee:{id}）、' +
    '截止时间与优先级。**指派给数字员工（employee:）会自动派单**给该员工执行。' +
    '同一负责人同名未完结待办不会重复创建（自动回放既有待办）。' +
    '示例参数：{"title":"准备季度汇报","assignee":"employee:e-1","dueAt":"2026-10-20","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 幂等业务键（业务层挡"日常重复提交"；DB 唯一键另有一层挡并发） */
  readonly idempotencyKeyFields = ['title', 'assignee'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '待办标题（必填）' },
      assignee: {
        type: 'string',
        description: '负责人（可选，默认当前用户）：user:{id} 或 employee:{id}',
      },
      description: { type: 'string', description: '详细说明（可选）' },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: '优先级（可选，默认 normal）',
      },
      dueAt: { type: 'string', description: '截止时间（可选，ISO 日期）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiTodoEntity)
    private readonly todoRepo: Repository<AiTodoEntity>,
    // 复用既有派单工具（不新建派发路径）；@Optional ⇒ 单测可只传仓储
    @Optional()
    private readonly dispatchTool?: DispatchEmployeeTaskTool,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const parsed = this.parseArgs(args, context);
    if (!parsed.valid) {
      return {
        success: false,
        error: parsed.error,
        suggestion: parsed.suggestion,
      };
    }
    const { title, assignee, description, priority, dueAt, confirm } =
      parsed.data;
    const isEmployee = assignee.startsWith('employee:');
    const target = isEmployee ? assignee.slice('employee:'.length) : null;

    // ── 预览：**零副作用**（不查库、不落库）──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '新建待办',
          summary: `将创建待办「${title}」，负责人 ${assignee}${dueAt ? `，截止 ${dueAt.toISOString().slice(0, 10)}` : ''}`,
          details: {
            title,
            assignee,
            description: description ?? null,
            priority,
            dueAt: dueAt ? dueAt.toISOString() : null,
            source: 'ai',
            ...(isEmployee
              ? { dispatchPlanned: `将复用既有派单 → 数字员工 ${target}` }
              : {}),
            idempotency: '同负责人同名未完结待办 ⇒ 回放既有待办（不重复建单）',
          },
        },
      };
    }

    try {
      // ── 幂等第 1 层（业务）：同 (tenant,title,assignee) 且未完结 ⇒ 回放 ──
      const existing = await this.todoRepo.findOne({
        where: {
          tenantId: context.tenantId,
          title,
          assignee,
          status: Not(In(['done', 'cancelled'])),
        },
      });
      if (existing) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            todoId: existing.id,
            assignee,
            status: existing.status,
            duplicate: true,
            message: `同名未完结待办已存在（#${existing.id}），已直接复用，未重复建单`,
          },
        };
      }

      // ── 落库（幂等第 2 层：DB 唯一键挡并发）──
      let saved: AiTodoEntity;
      try {
        saved = await this.todoRepo.save(
          this.todoRepo.create({
            tenantId: context.tenantId,
            title,
            description: description ?? null,
            assignee,
            status: 'pending',
            priority,
            dueAt: dueAt ?? null,
            source: 'ai',
            createdBy: context.userId,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/UNIQUE|Duplicate|constraint/i.test(message)) {
          const raced = await this.todoRepo.findOne({
            where: {
              tenantId: context.tenantId,
              title,
              assignee,
              dueAt: dueAt ?? IsNull(),
            },
          });
          if (raced) {
            return {
              success: true,
              idempotent_replay: true,
              data: {
                todoId: raced.id,
                assignee,
                duplicate: true,
                message: `并发提交：同名待办已存在（#${raced.id}），已复用`,
              },
            };
          }
        }
        throw err;
      }

      // ── 数字员工派单（复用既有路径；失败不影响建单）──
      let dispatch: Record<string, unknown> | undefined;
      if (isEmployee && target !== null) {
        const task = description ? `${title}\n${description}` : title;
        if (!this.dispatchTool) {
          dispatch = {
            status: 'skipped',
            reason: '派单工具未注入（单测/降级）',
          };
        } else {
          try {
            const r = await this.dispatchTool.execute(
              {
                target,
                task,
                taskType: 'todo',
                // R101-AI-46：关联待办（数字员工成功完成后自动回写 done）
                linkedTodoId: String(saved.id),
              },
              context,
            );
            dispatch = r.success
              ? { status: 'dispatched', target, summary: r.data }
              : { status: 'failed', target, error: r.error };
          } catch (err) {
            // 纵深防御：派单异常隔离（不信任其契约）
            const m = err instanceof Error ? err.message : String(err);
            this.logger.warn(`派单异常（已隔离，待办已建）：#${saved.id} ${m}`);
            dispatch = { status: 'failed', target, error: m };
          }
        }
      }

      return {
        success: true,
        data: {
          todoId: saved.id,
          title: saved.title,
          assignee: saved.assignee,
          status: saved.status,
          source: saved.source,
          ...(dispatch ? { dispatch } : {}),
          message: `待办「${title}」已创建（#${saved.id}，负责人 ${assignee}）${
            dispatch?.status === 'dispatched' ? '，已派单给数字员工' : ''
          }${dispatch?.status === 'failed' ? '，但派单失败（待办仍在，可稍后重派）' : ''}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`创建待办失败：${message}`);
      return {
        success: false,
        error: `创建待办失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  /** 入参解析（title 必填；assignee 须为 user:/employee: 前缀） */
  private parseArgs(
    args: Record<string, unknown>,
    context: ToolContext,
  ):
    | { valid: true; data: CreateTodoArgs }
    | { valid: false; error: string; suggestion: string } {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (title.length === 0) {
      return {
        valid: false,
        error: 'title 不能为空',
        suggestion: '请提供待办标题',
      };
    }
    const rawAssignee =
      typeof args.assignee === 'string' && args.assignee.trim().length > 0
        ? args.assignee.trim()
        : `user:${context.userId}`;
    if (!/^(user|employee):[A-Za-z0-9_-]+$/.test(rawAssignee)) {
      return {
        valid: false,
        error: `assignee 格式非法：${rawAssignee}`,
        suggestion: '负责人须形如 user:{id} 或 employee:{id}',
      };
    }
    let dueAt: Date | undefined;
    if (typeof args.dueAt === 'string' && args.dueAt.trim().length > 0) {
      const d = new Date(args.dueAt);
      if (Number.isNaN(d.getTime())) {
        return {
          valid: false,
          error: `dueAt 不是合法日期：${args.dueAt}`,
          suggestion: '请提供 ISO 日期，如 2026-10-20',
        };
      }
      dueAt = d;
    }
    const priority: TodoPriority =
      args.priority === 'low' || args.priority === 'high'
        ? args.priority
        : 'normal';
    const description =
      typeof args.description === 'string' && args.description.trim().length > 0
        ? args.description
        : undefined;
    return {
      valid: true,
      data: {
        title,
        assignee: rawAssignee,
        description,
        priority,
        dueAt,
        confirm: args.confirm === true,
      },
    };
  }
}
