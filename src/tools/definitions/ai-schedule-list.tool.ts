/**
 * aiScheduleList — 日程列表（**读工具**；R101-AI-39）
 *
 * 治理链：`isWriteOperation=false` ⇒ 读全自动。
 *
 * 权限（**库层隔离**，同批次 2/3）：
 * `tenant_id=? AND (id IN(:granted) OR owner=:me OR participants LIKE '%,me,%')`
 * ⇒ **绝不"先查全量再内存过滤"**；之后逐行 `resolveResource` 确认（纵深防御）
 *
 * ⚠️ participants 匹配的**双方言一致性**（凌舟点名）：
 * - 存储归一化为**首尾带逗号**（`,user:u1,user:u12,`），匹配用 `LIKE '%,user:u1,%'`
 *   ⇒ 杜绝 `%u1%` 误命中 `u12` 的**子串误配**
 * - MySQL LIKE 默认大小写不敏感 / sqlite 默认区分 ⇒ principal 由 `principalOf()` 生成且**全小写**
 *   ⇒ 实际取值域内无歧义（注释留痕；若将来允许大写 id 需显式统一大小写）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiScheduleEntity } from '../../database/entities/ai-schedule.entity';
import {
  OfficeAclService,
  OfficePrincipal,
} from '../../rag/office-acl.service';
import { ITool, ToolContext, ToolResult } from '../tool.interface';
import { principalOf } from './ai-doc-list.tool';
import { ScheduleDomainService } from '../../brain/schedule/schedule-domain.service';

@Injectable()
export class AiScheduleListTool implements ITool {
  private readonly logger = new Logger(AiScheduleListTool.name);

  readonly name = 'aiScheduleList';
  readonly description =
    '日程清单（只读）：列出当前用户**有权查看**的日程（我创建的 / 我参与的 / 被 ACL 授权的），' +
    '可按时间范围（from/to）、状态（planned|done|cancelled）筛选。' +
    '示例参数：{"from":"2026-10-16","status":"planned"}';
  readonly category = 'report' as const;
  readonly isWriteOperation = false;

  readonly parameters = {
    type: 'object' as const,
    properties: {
      from: { type: 'string', description: '开始时间下限（可选，ISO 日期）' },
      to: { type: 'string', description: '开始时间上限（可选，ISO 日期）' },
      status: {
        type: 'string',
        enum: ['planned', 'done', 'cancelled'],
        description: '状态筛选（可选；非法值忽略）',
      },
    },
  };

  constructor(
    @InjectRepository(AiScheduleEntity)
    readonly scheduleRepo: Repository<AiScheduleEntity>,
    /**
     * AI-P2-2：可见性判定与库层过滤**已上收领域服务**。
     * 保留注入位以维持既有构造签名（spec / DI 兼容）。
     */
    readonly officeAcl: OfficeAclService,
    private readonly domain: ScheduleDomainService,
  ) {}

  async execute(
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const principal: OfficePrincipal = principalOf(context);
    const status =
      args.status === 'planned' ||
      args.status === 'done' ||
      args.status === 'cancelled'
        ? args.status
        : undefined;
    const from =
      typeof args.from === 'string' && args.from.trim().length > 0
        ? new Date(args.from)
        : undefined;
    const to =
      typeof args.to === 'string' && args.to.trim().length > 0
        ? new Date(args.to)
        : undefined;

    try {
      // AI-P2-2 §五.7：可见性**统一走领域服务**（租户 + owner/代管/参与者/共享角色∪人员/ACL）
      // 领域服务内部即为**库层条件**（非先查全量再过滤），并含共享范围并集
      const rows = await this.domain.listVisible(
        { tenantId: context.tenantId, principal },
        { from: from ?? null, to: to ?? null, status: status ?? null },
      );

      // 纵深防御：逐行再走一次同一判定（领域服务唯一口径）
      const visible: Array<Record<string, unknown>> = [];
      for (const s of rows) {
        const access = await this.domain.resolveAccess(s, {
          tenantId: context.tenantId,
          principal,
        });
        if (access === 'none') continue;
        visible.push({
          scheduleId: s.id,
          title: s.title,
          startAt: new Date(s.startAt).toISOString(),
          endAt: s.endAt ? new Date(s.endAt).toISOString() : null,
          owner: s.owner,
          participants: s.participants,
          status: s.status,
          remindAt: s.remindAt ? new Date(s.remindAt).toISOString() : null,
          // AI-P2-2：共享/代管/重复系列可见（与人工入口同字段）
          viewerRoles: s.viewerRoles ?? null,
          viewerUserIds: s.viewerUserIds ?? null,
          managerUserIds: s.managerUserIds ?? null,
          access,
          seriesId: s.seriesId ?? null,
          occurrenceAt: s.occurrenceAt
            ? new Date(s.occurrenceAt).toISOString()
            : null,
          recurrenceRule: s.recurrenceRule ?? null,
        });
      }

      return {
        success: true,
        data: {
          total: visible.length,
          list: visible,
          aclBucket: {
            resourceType: 'schedule',
            grantedCount: 0,
            scope: principal.isPlatform
              ? 'platform(跨租户)'
              : 'tenant+owner+participants',
          },
          ...(visible.length === 0
            ? { note: '当前没有你有权查看的日程（或筛选条件下无匹配）' }
            : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`日程清单查询失败：${message}`);
      return {
        success: false,
        error: `日程清单查询失败：${message}`,
        suggestion: '请稍后重试；若持续失败请检查数据库连接',
      };
    }
  }
}
