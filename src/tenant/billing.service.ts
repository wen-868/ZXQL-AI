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
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { MetricsService } from '../common/metrics.service';

/** 额度判定结果 */
export interface QuotaResult {
  allowed: boolean;
  reason?: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

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
   * @param tenantId 租户 ID
   * @param tokens   本次消耗 Token 数
   * @param chatCount 本次对话数（默认 1）
   */
  async consume(
    tenantId: string,
    tokens: number,
    chatCount = 1,
  ): Promise<void> {
    try {
      const billing = await this.getOrCreate(tenantId);
      if (billing.enabled !== 1) {
        this.metrics.recordBillingConsume('skipped');
        return;
      }

      if (billing.freeChatCount > 0) {
        // 阶段0 B-3（2026-10-07 止血）：原子扣免费次数——此前读-改-写
        // 在并发下丢失更新（N-1 次计费蒸发）。GREATEST 钳制下限 0，
        // 单条 UPDATE 由数据库行锁保证串行。
        await this.repo.query(
          `UPDATE t_tenant_ai_billing
              SET free_chat_count = GREATEST(free_chat_count - ?, 0)
            WHERE tenant_id = ?
              AND free_chat_count > 0`,
          [chatCount, tenantId],
        );
        this.metrics.recordBillingConsume('ok');
        return;
      }

      if (billing.planType !== 'monthly') {
        // 按量扣预付费余额：费用 = overagePrice × tokens/1000
        // 原子 UPDATE（同上）：结算在数据库侧完成，应用层不再回写内存值
        const cost = (Number(billing.overagePrice) * tokens) / 1000;
        await this.repo.query(
          `UPDATE t_tenant_ai_billing
              SET balance = GREATEST(balance - ?, 0)
            WHERE tenant_id = ?`,
          [cost, tenantId],
        );
        this.metrics.recordBillingConsume('ok');
        return;
      }

      // 月费套餐：不按量扣减
      this.metrics.recordBillingConsume('skipped');
    } catch (err) {
      // 阶段0 B-3：写路径失败不再静默——计费失败=漏费，必须可观测
      this.metrics.recordBillingConsume('fail');
      this.logger.error(
        `计费消耗失败（漏计费风险，已计入 fail 指标）：tenant=${tenantId} tokens=${tokens} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async getOrCreate(tenantId: string): Promise<TenantAiBillingEntity> {
    const billing = await this.repo.findOne({ where: { tenantId } });
    if (billing) {
      return billing;
    }
    return this.repo.save(this.repo.create({ tenantId }));
  }
}
