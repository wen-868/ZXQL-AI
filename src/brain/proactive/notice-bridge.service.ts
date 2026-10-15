/**
 * NoticeBridgeService — "推送 + 站内通知"旁路组合（R101-AI-40）
 *
 * 为什么是旁路而不是改 `ProactivePushService`：
 * - 该服务是 **9 项巡检共用的既有件**，其 spec 有断言；红线要求**不侵入既有逻辑**
 * - 旁路组合：本服务持有一个 `pushWithNotice()`，把既有 `push()` 与 `NoticeService.record()` 组合
 *   ⇒ 调用方（日程提醒）改用本服务；巡检逐点切换（独立后续单）
 *
 * 🔴 **语义（凌舟裁定 ② 纠正）**：**站内通知无条件落库，不依赖推送成败**
 * - 准确的"为什么"（凌舟二次核实源码后的澄清）：`push()` 的 `ok=false` **只发生在 `t_push_log` INSERT 失败**
 *   （`broadcast` 在 try/catch 内、失败不改返回值 ⇒ 离线时 `ok` 仍为 true）。
 *   而 `t_push_log` 是**跨线审计表（MS 拥有）** ⇒ 一旦它故障/不可写，**"站内通知"这条本应独立的
 *   持久化兜底会跟着一起失效** —— 而"push_log 写不进去"恰恰是站内通知**最该顶上**的时刻。
 *   ⇒ 若写成 `if (ok) record(...)`，等于把通知绑在跨线审计表的写入成败上（脆弱且语义错位）。
 * - 次序：**先落通知（持久化事实）→ 再推实时（实时增强）**
 * - 主次不倒置：`record()` 失败**不得**让本方法抛（其内部已吞并记日志）
 *
 * 返回值语义：= **实时推送结果**（与既有 `push()` 调用方契约一致）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { ProactivePushType, ProactivePriority } from './proactive.types';
import { ProactivePushService } from './proactive-push.service';
import { NoticeService, RecordNoticeInput } from './notice.service';
import { NoticeSource } from '../../database/entities/ai-notice.entity';

export interface NoticeContext {
  /** 接收人（principal 串，逗号分隔；由调用方给出 owner/participants 展开） */
  receiver: string;
  source: NoticeSource;
  refId?: string | null;
  /** 去重键（如 `schedule:{id}:{remindAtISO}`）；可空 ⇒ 由业务幂等承重 */
  dedupeKey?: string | null;
}

@Injectable()
export class NoticeBridgeService {
  private readonly logger = new Logger(NoticeBridgeService.name);

  constructor(
    private readonly notice: NoticeService,
    private readonly proactivePush: ProactivePushService,
  ) {}

  /**
   * 落站内通知（无条件）+ 实时推送（尽力而为）
   *
   * @returns 实时推送结果（`push()` 的返回值语义不变）
   */
  async pushWithNotice(
    tenantId: string,
    taskName: string,
    push: {
      title: string;
      content: string;
      type: ProactivePushType;
      priority: ProactivePriority;
    },
    ctx: NoticeContext,
  ): Promise<boolean> {
    // ── ① 先落站内通知（**无条件**，不依赖推送成败）──
    const recorded = await this.safeRecord({
      tenantId,
      receiver: ctx.receiver,
      title: push.title,
      content: push.content,
      type: push.type,
      priority: push.priority,
      source: ctx.source,
      refId: ctx.refId ?? null,
      dedupeKey: ctx.dedupeKey ?? null,
    });
    if (!recorded.inserted) {
      this.logger.log(
        `站内通知未新增（deduped=${recorded.deduped === true}，err=${recorded.error ?? '-'}）：task=${taskName}`,
      );
    }

    // ── ② 再推实时（尽力而为；成败都改变不了"通知已落库"这一事实）──
    return this.proactivePush.push(tenantId, taskName, push);
  }

  /**
   * 纵深防御包装（AI-35 教训"不信任自己的契约"）：
   * `NoticeService.record` 契约上绝不抛，但调用方仍要防 —— 一旦它抛，
   * **不得阻断后续实时推送**（主次不倒置）。
   */
  private async safeRecord(input: RecordNoticeInput): Promise<{
    inserted: boolean;
    deduped?: boolean;
    error?: string;
  }> {
    try {
      return await this.notice.record(input);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      this.logger.warn(`站内通知落库异常（已隔离，不影响推送）：${m}`);
      return { inserted: false, error: m };
    }
  }
}
