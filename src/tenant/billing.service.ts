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
        return;
      }

      let changed = false;
      if (billing.freeChatCount > 0) {
        billing.freeChatCount = Math.max(0, billing.freeChatCount - chatCount);
        changed = true;
      } else if (billing.planType !== 'monthly') {
        // 按量扣预付费余额：费用 = overagePrice × tokens/1000
        const cost = (Number(billing.overagePrice) * tokens) / 1000;
        billing.balance = Math.max(0, Number(billing.balance) - cost);
        changed = true;
      }
      if (changed) {
        await this.repo.save(billing);
      }
    } catch (err) {
      this.logger.warn(
        `计费消耗失败（非致命）：${err instanceof Error ? err.message : String(err)}`,
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
