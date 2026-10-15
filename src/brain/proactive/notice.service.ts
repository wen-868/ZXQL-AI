/**
 * NoticeService — 站内通知落库（R101-AI-40）
 *
 * 核心语义（凌舟裁定 ② 的纠正）：
 * - **通知是持久化事实，推送只是实时增强** ⇒ 落库**不依赖** `push()` 成败
 * - 去重（规范 §2.2）：`dedupe_key` 可空 ⇒ **业务幂等承重**（同租户同键**未读**已存在 ⇒ 不再插）；
 *   DB 唯一键 `(tenant_id, dedupe_key)` 仅在**并发**时兜底（含 NULL 不判重 ⇒ 无键时 DB 层无效）
 *
 * **绝不抛**：`record()` 内部吞异常并记日志（同批次 4"提醒失败不影响日程"）—— 通知落库失败
 * 不得影响调用主流程（推送/日程/巡检）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  AiNoticeEntity,
  NoticeSource,
} from '../../database/entities/ai-notice.entity';
import { normalizeParticipants } from '../../tools/definitions/schedule-participants.util';

export interface RecordNoticeInput {
  tenantId: string;
  /** 接收人（principal 串，逗号分隔；内部会归一化为首尾逗号） */
  receiver: string;
  title: string;
  content?: string | null;
  type: string;
  priority: string;
  source: NoticeSource;
  refId?: string | null;
  dedupeKey?: string | null;
}

@Injectable()
export class NoticeService {
  private readonly logger = new Logger(NoticeService.name);

  constructor(
    @InjectRepository(AiNoticeEntity)
    private readonly noticeRepo: Repository<AiNoticeEntity>,
  ) {}

  /**
   * 落一条站内通知（消息：**业务幂等**；DB 唯一键兜并发）
   *
   * @returns `{ inserted, noticeId?, deduped? }`；异常被吞 ⇒ 返回 `{ inserted:false, error }`
   */
  async record(input: RecordNoticeInput): Promise<{
    inserted: boolean;
    noticeId?: string;
    deduped?: boolean;
    error?: string;
  }> {
    try {
      const receiver = normalizeParticipants(input.receiver);
      if (!receiver) {
        this.logger.warn('通知落库跳过：receiver 为空');
        return { inserted: false, error: 'receiver 为空' };
      }

      // ── 业务幂等（承重）：同租户同 dedupe_key **未读**已存在 ⇒ 不重复插 ──
      if (input.dedupeKey) {
        const existing = await this.noticeRepo.findOne({
          where: {
            tenantId: input.tenantId,
            dedupeKey: input.dedupeKey,
            readAt: IsNull(),
          },
        });
        if (existing) {
          return { inserted: false, deduped: true, noticeId: existing.id };
        }
      }

      try {
        const saved = await this.noticeRepo.save(
          this.noticeRepo.create({
            tenantId: input.tenantId,
            receiver,
            title: input.title,
            content: input.content ?? null,
            type: input.type,
            priority: input.priority,
            readAt: null,
            archivedAt: null,
            source: input.source,
            refId: input.refId ?? null,
            dedupeKey: input.dedupeKey ?? null,
          }),
        );
        return { inserted: true, noticeId: saved.id };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // 并发兜底：唯一键冲突 ⇒ 视为已落（deduped）
        if (/UNIQUE|Duplicate|constraint/i.test(message)) {
          return { inserted: false, deduped: true };
        }
        throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 🔴 绝不外抛：通知落库失败不影响调用主流程
      this.logger.warn(`通知落库失败（已隔离，不影响主流程）：${message}`);
      return { inserted: false, error: message };
    }
  }
}
