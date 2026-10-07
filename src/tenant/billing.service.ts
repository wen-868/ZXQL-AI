/**
 * BillingService — 租户计费运行时扣减（B5，决策 20）
 *
 * 额度判定（checkQuota）+ 消耗（consume）：
 * - 免费对话次数（free_chat_count）优先扣减
 * - 用尽后按预付费余额（balance）扣减（overage_price × 千 Token）
 * - 月度套餐（monthly）按月费计，不逐次扣减
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { MetricsService } from '../common/metrics.service';
import { bestEffort } from '../common/error-semantics';

/** 额度判定结果 */
export interface QuotaResult {
  allowed: boolean;
  reason?: string;
}

/**
 * 从 `repo.query()` 的返回值里取 affectedRows。
 *
 * `repo.query()` 走 mysql2 直连，返回的是协议层 OK 包（OkPacket），
 * 计数字段名为 `affectedRows`（mysql2 lib/packets/resultset_header.js）。
 * ⚠️ 不是 TypeORM `UpdateResult.affected` —— 那是 `update()` 的返回形态，
 * 二者字段名不同，写错会静默得到 undefined（undefined > 0 为 false，
 * 会把「扣成功」误判成「未命中」）。
 */
function affectedRowsOf(result: unknown): number {
  if (typeof result !== 'object' || result === null) {
    return 0;
  }
  const value = (result as { affectedRows?: unknown }).affectedRows;
  return typeof value === 'number' ? value : 0;
}

@Injectable()
export class BillingService {
  constructor(
    @InjectRepository(TenantAiBillingEntity)
    private readonly repo: Repository<TenantAiBillingEntity>,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * 额度判定（请求前可选调用；enabled=0 拒绝）
   */
  async checkQuota(tenantId: string): Promise<QuotaResult> {
    const billing = await this.getOrCreate(tenantId);
    if (billing.enabled !== 1) {
      return { allowed: false, reason: '该租户 AI 计费未启用（AI_002）' };
    }
    if (
      billing.freeChatCount > 0 ||
      billing.monthlyChatLimit === 0 ||
      billing.balance > 0
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: '免费次数与预付费余额均已用尽，请联系管理员充值',
    };
  }

  /**
   * 消耗（任务结束后调用）：优先扣免费次数，再扣预付费余额
   *
   * P1-B 迁移（2026-10-07）：语义定为 bestEffort。
   * 判据链：① 失败会让用户看到"成功"吗？不会——本方法在对话已返回后调用，
   * 扣减失败不影响本次回答，用户无从察觉，故不是必须上抛的"真相链"；
   * ② 数据丢了会账目不平吗？会——漏计费直接造成账目不平，不能降级为无声；
   * ③ 故取 bestEffort：不阻断主流程，但失败必落 logger.error + 指标 + 死信，
   * 运维可据死信补扣。`recordBillingConsume('fail')` 为阶段0 B-3 既有指标，
   * 语义上与 bestEffort 的指标互补（前者是计费域专用计数），故保留。
   *
   * @param tenantId 租户 ID
   * @param tokens   本次消耗 Token 数
   * @param chatCount 本次对话数（默认 1）
   */
  async consume(
    tenantId: string,
    tokens: number,
    chatCount = 1,
  ): Promise<void> {
    await bestEffort(
      async () => {
        try {
          await this.deduct(tenantId, tokens, chatCount);
        } catch (err) {
          // 阶段0 B-3：计费失败必须计入 fail 指标（漏计费可观测），再上抛给
          // bestEffort 统一记录 logger.error + 语义指标 + 死信
          this.metrics.recordBillingConsume('fail');
          throw err;
        }
      },
      {
        op: 'billing.consume',
        tenantId,
        detail: `tokens=${tokens} chatCount=${chatCount}`,
      },
    );
  }

  /** 实际扣减逻辑（失败向上抛，由 consume 的 bestEffort 统一接管语义） */
  private async deduct(
    tenantId: string,
    tokens: number,
    chatCount: number,
  ): Promise<void> {
    const billing = await this.getOrCreate(tenantId);
    if (billing.enabled !== 1) {
      this.metrics.recordBillingConsume('skipped');
      return;
    }

    // 阶段2 A3（2026-10-07）：判据下沉到数据库。
    //
    // 此前判据读的是 getOrCreate 返回的内存快照：并发时 req1/req2 同读
    // freeChatCount=1 都进入免费分支，req1 的 UPDATE 命中扣成 0，req2 因
    // `WHERE free_chat_count > 0` 不匹配而实际影响 0 行 —— 但代码不看
    // affectedRows，照记 ok。⇒ 第二次请求被免费放行且从未扣减，指标显示 ok
    // 而账上少扣一次。假的 ok 比没有指标更危险（会掩盖真实漏费）。
    //
    // 改为：先无条件扣免费次数，**用 affectedRows 决定是否落入余额分支**，
    // 而非用内存快照提前分流。判据（是否还有免费次数）由数据库的行锁 +
    // WHERE 条件原子裁决，每个并发请求都落到正确分支。
    //
    // ⚠️ 不加事务：事务不解决「判据读的是快照」这个本质，判据已下沉到 SQL，
    // 此处需要的是单条 UPDATE 的原子性（由 InnoDB 行锁保证）。
    const freeResult: unknown = await this.repo.query(
      `UPDATE t_tenant_ai_billing
          SET free_chat_count = GREATEST(free_chat_count - ?, 0)
        WHERE tenant_id = ?
          AND free_chat_count > 0`,
      [chatCount, tenantId],
    );

    if (affectedRowsOf(freeResult) > 0) {
      // 免费次数确实扣减到了（命中 ≥1 行）——此时记 ok 才是真的
      this.metrics.recordBillingConsume('ok');
      return;
    }

    // affectedRows === 0 ⇒ 免费次数已耗尽（并发下同样准确，因为判据在 DB 侧）
    // 此时才读快照的 planType 决定是否走余额扣减
    if (billing.planType !== 'monthly') {
      // 按量扣预付费余额：费用 = overagePrice × tokens/1000
      // 原子 UPDATE：结算在数据库侧完成，应用层不再回写内存值
      const cost = (Number(billing.overagePrice) * tokens) / 1000;
      await this.repo.query(
        `UPDATE t_tenant_ai_billing
            SET balance = GREATEST(balance - ?, 0)
          WHERE tenant_id = ?`,
        [cost, tenantId],
      );
      // 与「命中免费次数」可区分：ok=扣免费次数 / ok_balance=扣预付费余额
      this.metrics.recordBillingConsume('ok_balance');
      return;
    }

    // 月费套餐：不按量扣减
    this.metrics.recordBillingConsume('skipped');
  }

  private async getOrCreate(tenantId: string): Promise<TenantAiBillingEntity> {
    const billing = await this.repo.findOne({ where: { tenantId } });
    if (billing) {
      return billing;
    }
    return this.repo.save(this.repo.create({ tenantId }));
  }
}
