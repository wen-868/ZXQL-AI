/**
 * aiScheduleUpdate — 修改日程（**写工具**；R101-AI-39）
 *
 * 🔴 两条硬约束（沿用批次 3 模式）：
 * 1. **不接受 `status`**（状态迁移走 complete/cancel 的原子路径）⇒ 传即明确拒绝
 * 2. **仅 `planned` 可改**（已 done/cancelled 为终态 ⇒ 明确拒绝）
 *
 * 权限：归属人 / 参与者（边界匹配）/ 平台 / ACL write
 * 参与者改动用 `normalizeParticipants` 归一化（首尾逗号 ⇒ 库层 LIKE 无子串误配）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import { OfficeAclService } from '../../rag/office-acl.service';
import { ScheduleDomainService } from '../../brain/schedule/schedule-domain.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import { normalizeParticipants } from './schedule-participants.util';

@Injectable()
export class AiScheduleUpdateTool implements ITool {
  private readonly logger = new Logger(AiScheduleUpdateTool.name);

  readonly name = 'aiScheduleUpdate';
  readonly description =
    '修改日程（**写操作**，需确认）：改标题/时间/参与者/提醒时间。**仅未完成（planned）的日程可改**；' +
    '**不接受状态修改**（完成用 aiScheduleComplete、取消用 aiScheduleCancel）。' +
    '示例参数：{"scheduleId":"12","startAt":"2026-10-21T10:00:00+08:00","confirm":false}';
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      scheduleId: { type: 'string', description: '日程 ID（必填）' },
      title: { type: 'string', description: '新标题（可选）' },
      startAt: { type: 'string', description: '新开始时间（可选，ISO）' },
      endAt: { type: 'string', description: '新结束时间（可选，ISO）' },
      participants: {
        type: 'string',
        description: '新参与者（可选，逗号分隔）',
      },
      remindAt: { type: 'string', description: '新提醒时间（可选，ISO）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅预览，不落库）',
      },
      scope: {
        type: 'string',
        enum: ['single', 'following', 'all'],
        description:
          '作用域（重复日程专用；缺省 single）：single=仅本次、following=本次及以后、all=整系列',
      },
    },
  };

  constructor(
    @InjectRepository(AiScheduleEntity)
    private readonly scheduleRepo: Repository<AiScheduleEntity>,
    /**
     * AI-P2-2：ACL 判定已**上收领域服务**（同一判定只保留一份）。
     * 保留该注入位以维持既有构造签名（spec 与 DI 兼容），标记 public readonly
     * 而非私有 ⇒ 既不断言"仍在此使用"，也不破坏调用方。
     */
    readonly officeAcl: OfficeAclService,
    private readonly domain: ScheduleDomainService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // 🔴 状态变更必须走专用工具
    if (args.status !== undefined) {
      return {
        success: false,
        error: '本工具不接受 status 修改（避免绕过状态机原子迁移）',
        suggestion: '完成用 aiScheduleComplete；取消用 aiScheduleCancel',
      };
    }
    const scheduleId =
      typeof args.scheduleId === 'string' && args.scheduleId.trim().length > 0
        ? args.scheduleId.trim()
        : '';
    if (scheduleId.length === 0) {
      return {
        success: false,
        error: 'scheduleId 不能为空',
        suggestion: '请提供日程 ID',
      };
    }
    const confirm = args.confirm === true;

    try {
      const schedule = await this.scheduleRepo.findOne({
        where: { id: scheduleId },
      });
      if (!schedule) {
        return {
          success: false,
          error: `日程不存在：${scheduleId}`,
          suggestion: '请用 aiScheduleList 获取日程 ID',
        };
      }

      const principal = principalOf(context);
      // AI-P2-2 §五.7：权限判定统一走**唯一领域服务**（不再在此复制一套 me/participant/ACL 判定）
      // ⇒ viewer 只读用户在此被拒绝（卡面反测 2），manager 获准，owner/admin 获准
      try {
        await this.domain.assertCanWrite(schedule, {
          tenantId: context.tenantId,
          principal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `无权修改该日程：${scheduleId}（${message}）`,
          suggestion:
            '需归属人、代管人员或被授予 write/admin 权限（参与者/共享仅只读）',
        };
      }

      // 🔴 仅 planned 可改
      if (schedule.status !== 'planned') {
        return {
          success: false,
          error: `日程状态为 ${schedule.status}，仅未完成（planned）的日程可修改`,
          suggestion: '已终态的日程不可改；如需变更请新建日程',
        };
      }

      const newStartAt = parseDate(args.startAt);
      if (args.startAt !== undefined && !newStartAt) {
        return {
          success: false,
          error: `startAt 非法：${JSON.stringify(args.startAt)}`,
          suggestion: 'ISO 时间',
        };
      }
      const newEndAt = parseDate(args.endAt);
      if (args.endAt !== undefined && !newEndAt) {
        return {
          success: false,
          error: `endAt 非法：${JSON.stringify(args.endAt)}`,
          suggestion: 'ISO 时间',
        };
      }
      const newRemindAt = parseDate(args.remindAt);
      if (args.remindAt !== undefined && !newRemindAt) {
        return {
          success: false,
          error: `remindAt 非法：${JSON.stringify(args.remindAt)}`,
          suggestion: 'ISO 时间',
        };
      }
      const effectiveStart = newStartAt ?? new Date(schedule.startAt);
      const effectiveEnd =
        newEndAt ?? (schedule.endAt ? new Date(schedule.endAt) : null);
      if (effectiveEnd && effectiveEnd.getTime() < effectiveStart.getTime()) {
        return {
          success: false,
          error: 'endAt 早于 startAt',
          suggestion: '请检查时间区间',
        };
      }

      const changes: Record<string, unknown> = {};
      if (typeof args.title === 'string' && args.title.trim().length > 0) {
        changes.title = args.title.trim();
      }
      if (newStartAt) changes.startAt = newStartAt;
      if (newEndAt) changes.endAt = newEndAt;
      if (typeof args.participants === 'string') {
        changes.participants = normalizeParticipants(args.participants);
      }
      if (newRemindAt) {
        changes.remindAt = newRemindAt;
        // 提醒时间被改 ⇒ 重置提醒幂等标记（可再次提醒）
        changes.remindedAt = null;
      }

      // AI-P2-2 §四.6：作用域（单次/后续/整系列）——缺省 single，避免"整系列修改伪装成单次"
      const scopeRaw = String(
        (args.scope as string | undefined) ?? 'single',
      ).toLowerCase();
      if (!['single', 'following', 'all'].includes(scopeRaw)) {
        return {
          success: false,
          error: `scope 非法：${String(args.scope)}`,
          suggestion:
            '可选 single（仅本次）/ following（本次及以后）/ all（整系列）',
        };
      }
      const scope = scopeRaw as 'single' | 'following' | 'all';
      if (scope !== 'single' && !schedule.seriesId) {
        return {
          success: false,
          error: '该日程不是重复日程，scope 只能为 single',
          suggestion: '单次日程没有"后续/整系列"语义',
        };
      }

      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: '修改日程',
            summary:
              `将修改日程「${schedule.title}」的 ${Object.keys(changes).join('、') || '（无字段变化）'}` +
              `（作用域 ${scope}${scope === 'all' ? '，整系列' : scope === 'following' ? '，本次及以后' : '，仅本次'}）`,
            details: {
              scheduleId,
              seriesId: schedule.seriesId ?? null,
              scope,
              currentStatus: schedule.status,
              changes: {
                ...changes,
                ...(changes.startAt
                  ? { startAt: (changes.startAt as Date).toISOString() }
                  : {}),
                ...(changes.endAt
                  ? { endAt: (changes.endAt as Date).toISOString() }
                  : {}),
                ...(changes.remindAt
                  ? { remindAt: (changes.remindAt as Date).toISOString() }
                  : {}),
              },
              statusNote: '状态不在可改字段内（请用 complete/cancel）',
            },
          },
        };
      }

      // ── 落库：**唯一领域服务**（三作用域语义由它实现；工具层不写 SQL）──
      const { remindedAt, ...patchForDomain } = changes;
      void remindedAt;
      const res = await this.domain.update(
        { tenantId: context.tenantId, principal },
        scheduleId,
        {
          ...(patchForDomain.title !== undefined
            ? { title: patchForDomain.title as string }
            : {}),
          ...(patchForDomain.startAt !== undefined
            ? { startAt: patchForDomain.startAt as Date }
            : {}),
          ...(patchForDomain.endAt !== undefined
            ? { endAt: patchForDomain.endAt as Date }
            : {}),
          ...(patchForDomain.remindAt !== undefined
            ? { remindAt: patchForDomain.remindAt as Date }
            : {}),
          ...(patchForDomain.participants !== undefined
            ? { participants: patchForDomain.participants as string | null }
            : {}),
        },
        scope,
      );

      // 提醒时间被改 ⇒ 重置提醒幂等标记（可再次提醒）——按作用域同步
      if (newRemindAt) {
        if (scope === 'single' || !schedule.seriesId) {
          await this.scheduleRepo.update(
            { id: schedule.id, tenantId: context.tenantId },
            { remindedAt: null },
          );
        } else {
          await this.scheduleRepo.update(
            { seriesId: schedule.seriesId, tenantId: context.tenantId },
            { remindedAt: null },
          );
        }
      }

      return {
        success: true,
        data: {
          scheduleId,
          seriesId: schedule.seriesId ?? null,
          scope,
          updated: res.updated,
          status: schedule.status,
          changed: Object.keys(changes),
          message: `日程 #${schedule.id} 已更新（作用域 ${scope}，影响 ${res.updated} 条，状态仍为 ${schedule.status}）`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`修改日程失败：${message}`);
      return {
        success: false,
        error: `修改日程失败：${message}`,
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
