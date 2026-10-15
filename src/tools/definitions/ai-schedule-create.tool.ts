/**
 * aiScheduleCreate — 新建日程（**写工具**；R101-AI-39）
 *
 * 幂等**双层**（对照规范 §2.2）：
 * 1. **DB 层对本表有效**：唯一键 `(tenant_id, title, owner, start_at)` **四列全 NOT NULL**
 *    ⇒ 不像 `due_at`/`related_biz` 那样因 NULL 不判重（竞态冲突 ⇒ 再读回放）
 * 2. **业务层**：同键且未终态（status='planned'）前置检查 ⇒ 挡"日常重复提交"
 *
 * 冲突检测：同 owner 在 `[start, end)` 内已有 planned 日程 ⇒ **只提示不阻止**（凌舟裁定）
 * 参与者归一化：`,a,b,`（首尾逗号）⇒ 库层 `LIKE '%,me,%'` 无子串误配（见 schedule-participants.util）
 *
 * 本批边界：**重复日程不做**；共享/代管不做；外部日历同步不做
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, MoreThanOrEqual, Not, Repository } from 'typeorm';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import { normalizeParticipants } from './schedule-participants.util';

@Injectable()
export class AiScheduleCreateTool implements ITool {
  private readonly logger = new Logger(AiScheduleCreateTool.name);

  readonly name = 'aiScheduleCreate';
  readonly description =
    '新建日程（**写操作**，需确认）：安排一次日程（标题 + 开始时间，可选结束时间/参与者/提醒时间）。' +
    '同归属人、同标题、同开始时间的未完成日程不会重复创建（自动回放）；' +
    '若时间与既有日程冲突**只提示不阻止**。本批不支持重复日程（recurrence）。' +
    '示例参数：{"title":"季度复盘会","startAt":"2026-10-20T14:00:00+08:00","participants":"user:u-2","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 幂等键（DB 层四列全 NOT NULL ⇒ 有效；业务层再前置一层） */
  readonly idempotencyKeyFields = ['title', 'owner', 'startAt'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: '日程标题（必填）' },
      startAt: {
        type: 'string',
        description: '开始时间（必填，ISO，如 2026-10-20T14:00:00+08:00）',
      },
      endAt: { type: 'string', description: '结束时间（可选，ISO）' },
      owner: {
        type: 'string',
        description: '归属人（可选，默认当前用户）：user:{id} 或 employee:{id}',
      },
      participants: {
        type: 'string',
        description:
          '参与者（可选，逗号分隔 principal：user:/role:/employee:）',
      },
      remindAt: {
        type: 'string',
        description: '提醒时间（可选，ISO；到期由系统推送提醒）',
      },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiScheduleEntity)
    private readonly scheduleRepo: Repository<AiScheduleEntity>,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (title.length === 0) {
      return {
        success: false,
        error: 'title 不能为空',
        suggestion: '请提供日程标题',
      };
    }
    const startAt = parseDate(args.startAt);
    if (!startAt) {
      return {
        success: false,
        error: `startAt 缺失或非法：${JSON.stringify(args.startAt)}`,
        suggestion: '请提供 ISO 开始时间，如 2026-10-20T14:00:00+08:00',
      };
    }
    const endAt = parseDate(args.endAt);
    if (args.endAt !== undefined && !endAt) {
      return {
        success: false,
        error: `endAt 非法：${JSON.stringify(args.endAt)}`,
        suggestion: 'ISO 时间',
      };
    }
    if (endAt && endAt.getTime() < startAt.getTime()) {
      return {
        success: false,
        error: 'endAt 早于 startAt',
        suggestion: '请检查时间区间',
      };
    }
    const principal = principalOf(context);
    const owner =
      typeof args.owner === 'string' && args.owner.trim().length > 0
        ? args.owner.trim()
        : `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    if (!/^(user|employee):[A-Za-z0-9_-]+$/.test(owner)) {
      return {
        success: false,
        error: `owner 格式非法：${owner}`,
        suggestion: '归属人须形如 user:{id} 或 employee:{id}',
      };
    }
    const participants = normalizeParticipants(
      typeof args.participants === 'string' ? args.participants : undefined,
    );
    const remindAt = parseDate(args.remindAt);
    if (args.remindAt !== undefined && !remindAt) {
      return {
        success: false,
        error: `remindAt 非法：${JSON.stringify(args.remindAt)}`,
        suggestion: 'ISO 时间',
      };
    }
    const confirm = args.confirm === true;

    // ── 预览：零副作用（不查库不落库）──
    if (!confirm) {
      return {
        success: true,
        preview: {
          operation: '新建日程',
          summary: `将创建日程「${title}」（${startAt.toISOString()}${endAt ? ` → ${endAt.toISOString()}` : ''}），归属人 ${owner}`,
          details: {
            title,
            startAt: startAt.toISOString(),
            endAt: endAt ? endAt.toISOString() : null,
            owner,
            participants,
            remindAt: remindAt ? remindAt.toISOString() : null,
            source: 'ai',
            note: '冲突检测只提示不阻止；重复日程（recurrence）本批不支持',
            idempotency:
              '唯一键 (tenant,title,owner,start_at) 四列全 NOT NULL ⇒ DB 层有效；业务层再前置一层',
          },
        },
      };
    }

    try {
      // ── 幂等（业务层）：同键且未终态 ⇒ 回放 ──
      const existing = await this.scheduleRepo.findOne({
        where: {
          tenantId: context.tenantId,
          title,
          owner,
          startAt,
          status: Not('cancelled'),
        },
      });
      if (existing) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            scheduleId: existing.id,
            status: existing.status,
            duplicate: true,
            message: `同键日程已存在（#${existing.id}，状态 ${existing.status}），已直接复用`,
          },
        };
      }

      // ── 冲突检测（只提示不阻止）──
      const windowStart = startAt;
      const windowEnd = endAt ?? new Date(startAt.getTime() + 60 * 60 * 1000);
      const conflicts = await this.scheduleRepo.find({
        where: [
          {
            tenantId: context.tenantId,
            owner,
            status: 'planned',
            startAt: Between(windowStart, windowEnd),
          },
          {
            tenantId: context.tenantId,
            owner,
            status: 'planned',
            endAt: MoreThanOrEqual(windowStart),
          },
        ],
      });

      // ── 落库（DB 唯一键挡并发）──
      let saved: AiScheduleEntity;
      try {
        saved = await this.scheduleRepo.save(
          this.scheduleRepo.create({
            tenantId: context.tenantId,
            title,
            startAt,
            endAt: endAt ?? null,
            owner,
            participants,
            status: 'planned',
            remindAt: remindAt ?? null,
            remindedAt: null,
            source: 'ai',
            createdBy: context.userId,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/UNIQUE|Duplicate|constraint/i.test(message)) {
          const raced = await this.scheduleRepo.findOne({
            where: { tenantId: context.tenantId, title, owner, startAt },
          });
          if (raced) {
            return {
              success: true,
              idempotent_replay: true,
              data: {
                scheduleId: raced.id,
                status: raced.status,
                duplicate: true,
                message: `并发提交：同键日程已存在（#${raced.id}），已复用`,
              },
            };
          }
        }
        throw err;
      }

      return {
        success: true,
        data: {
          scheduleId: saved.id,
          title: saved.title,
          startAt: new Date(saved.startAt).toISOString(),
          owner: saved.owner,
          status: saved.status,
          remindAt: saved.remindAt
            ? new Date(saved.remindAt).toISOString()
            : null,
          conflicts: conflicts.slice(0, 5).map((c) => ({
            scheduleId: c.id,
            title: c.title,
            startAt: new Date(c.startAt).toISOString(),
          })),
          ...(conflicts.length > 0
            ? {
                warning: `该时段与 ${conflicts.length} 条既有日程重叠（仅提示，未阻止）`,
              }
            : {}),
          message: `日程「${title}」已创建（#${saved.id}）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`创建日程失败：${message}`);
      return {
        success: false,
        error: `创建日程失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}

/** 解析 ISO 日期（非法 ⇒ null） */
function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || v.trim().length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
