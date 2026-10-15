/**
 * 日程状态迁移基类（Complete / Cancel 共用一份逻辑）—— R101-AI-39
 *
 * 为什么共用：完成与取消**只差目标终态与文案**，各写一份就会出现两份"原子迁移 + affected 判定 +
 * 权限口径"（违反"逻辑一份不复制"）。
 *
 * 🔴 状态机（对照规范 §2.1「互斥终态不可回放」）：
 * - 合法迁移：`planned → done`（完成）、`planned → cancelled`（取消）
 * - **这里可以回放**：done / cancelled 各自**无歧义**（完成就是完成）⇒ `affected=0` 且当前已是**目标终态**
 *   ⇒ 回放（`duplicate:true`）
 * - **但另一终态不可逾越**：已 `done` 再 cancel（或反之）⇒ **明确失败**（两个终态互斥，回放会撒谎）
 *   —— 这正是与审批的区别：审批的 approved/rejected 由**不同人**在并发中产生 ⇒ 连"同目标终态"也不回放；
 *   而日程的终态由**同一批有权者**触发且语义单一 ⇒ 同终态可回放、异终态明确失败
 *
 * 迁移**原子**：`UPDATE ... WHERE status='planned'`（不先读后写）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiScheduleEntity,
  ScheduleStatus,
} from '../../database/entities/ai-schedule.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import { matchesParticipant } from './schedule-participants.util';

export abstract class ScheduleStateBase implements ITool {
  protected readonly logger: Logger;
  protected abstract readonly targetStatus: ScheduleStatus;
  protected abstract readonly actionName: string;

  abstract readonly name: string;
  abstract readonly description: string;
  readonly category = 'report' as const;
  readonly isWriteOperation = true;
  readonly risk = 'medium' as const;
  /** 状态迁移型幂等键（同一日程重复同一操作 = 同一操作 ⇒ 回放） */
  readonly idempotencyKeyFields = ['scheduleId'] as const;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      scheduleId: { type: 'string', description: '日程 ID（必填）' },
      confirm: {
        type: 'boolean',
        description: '是否确认执行（缺省 false ⇒ 仅返回预览，不落库）',
      },
    },
  };

  constructor(
    @InjectRepository(AiScheduleEntity)
    protected readonly scheduleRepo: Repository<AiScheduleEntity>,
    protected readonly officeAcl: OfficeAclService,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const scheduleId =
      typeof args.scheduleId === 'string' && args.scheduleId.trim().length > 0
        ? args.scheduleId.trim()
        : '';
    if (scheduleId.length === 0) {
      return {
        success: false,
        error: 'scheduleId 不能为空',
        suggestion: '请用 aiScheduleList 获取日程 ID',
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
      const allowed = await this.canOperate(schedule, context, principal);
      if (!allowed) {
        return {
          success: false,
          error: `无权${this.actionName}该日程：${scheduleId}`,
          suggestion: '需归属人（owner）、参与者或被授予 write/admin 权限',
        };
      }

      // 终态处理：同目标终态 ⇒ 回放；另一终态 ⇒ 明确失败（互斥）
      if (schedule.status === this.targetStatus) {
        return {
          success: true,
          idempotent_replay: true,
          data: {
            scheduleId: schedule.id,
            status: schedule.status,
            duplicate: true,
            message: `日程 #${schedule.id} 已是 ${schedule.status}，未重复操作`,
          },
        };
      }
      if (schedule.status !== 'planned') {
        return {
          success: false,
          error: `日程当前状态为 ${schedule.status}，不可${this.actionName}`,
          suggestion: '已完成/已取消的日程不可再变更（两个终态互斥）',
        };
      }

      // ── 预览：不落库 ──
      if (!confirm) {
        return {
          success: true,
          preview: {
            operation: `${this.actionName}日程`,
            summary: `将把日程「${schedule.title}」置为 ${this.targetStatus}`,
            details: {
              scheduleId,
              title: schedule.title,
              startAt: new Date(schedule.startAt).toISOString(),
              currentStatus: schedule.status,
              nextStatus: this.targetStatus,
            },
          },
        };
      }

      // ── 原子迁移 ──
      const res = await this.scheduleRepo.update(
        { id: scheduleId, tenantId: schedule.tenantId, status: 'planned' },
        { status: this.targetStatus, updatedAt: new Date() },
      );

      if (res.affected === 0) {
        const after = await this.scheduleRepo.findOne({
          where: { id: scheduleId, tenantId: schedule.tenantId },
        });
        if (after && after.status === this.targetStatus) {
          // 并发下他人已做了**同一**终态操作 ⇒ 无歧义 ⇒ 回放
          return {
            success: true,
            idempotent_replay: true,
            data: {
              scheduleId: after.id,
              status: after.status,
              duplicate: true,
              message: `日程 #${after.id} 已是 ${after.status}（并发同操作），未重复修改`,
            },
          };
        }
        return {
          success: false,
          error: after
            ? `操作未生效：当前状态 ${after.status}（与本次目标 ${this.targetStatus} 互斥）`
            : `日程已不存在：${scheduleId}`,
          suggestion: '请刷新后查看最新状态',
        };
      }

      return {
        success: true,
        data: {
          scheduleId,
          status: this.targetStatus,
          message: `日程「${schedule.title}」已${this.actionName}`,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${this.actionName}日程失败：${message}`);
      return {
        success: false,
        error: `${this.actionName}日程失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }

  /** 权限：归属人 / 参与者（边界匹配）/ 平台 / ACL write（域规则 + 复用 ACL，不复制判定逻辑） */
  protected async canOperate(
    schedule: AiScheduleEntity,
    context: ToolContext,
    principal: OfficePrincipal,
  ): Promise<boolean> {
    if (principal.isPlatform) return true;
    const me = `${principal.type === 'employee' ? 'employee' : 'user'}:${principal.id}`;
    if (schedule.owner === me) return true;
    if (matchesParticipant(schedule.participants, me)) return true;
    for (const role of principal.roles ?? []) {
      if (matchesParticipant(schedule.participants, `role:${role}`))
        return true;
    }
    return this.officeAcl.canWriteResource(
      {
        resourceType: 'schedule',
        resourceId: schedule.id,
        tenantId: schedule.tenantId,
        owner: schedule.owner,
      },
      { tenantId: context.tenantId, principal },
    );
  }
}
