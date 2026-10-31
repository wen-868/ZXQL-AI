/**
 * WriteConfirmPipelineService — 写确认管线统一入口（AI-P2-4 切片 1）
 *
 * 审计报告 AI-P2-4-CHANNEL-UNIFICATION-AUDIT-01 切片 1：chat / agent / graph
 * 三通道的「写预览 → 创建确认令牌」此前各自调 ConfirmationService.create
 * 并各自计算 expireAt（chat 用 WRITE_TOKEN_TTL_MS 常量、agent 用本地 getter、
 * graph 硬编码 24h——D1 口径漂移）。本组件把「令牌创建 + 过期时间计算」
 * 收敛为唯一入口：三通道只做事件映射，不再各自拼装令牌与过期时间。
 *
 * 单源保证：
 * - 令牌仍由 ConfirmationService.create → WriteGuardService.suspend 生成
 *   （wg_ 前缀 / TTL 钳制 / NX+CAS 锁 / customerScope / 惰性过期全部不变）；
 * - expireAt 直接透传 suspend 落库的 write.expiresAt（= now + tokenTtlMs，
 *   随 WRITE_TOKEN_TTL_HOURS 可配置），三边与令牌真实过期时间严格一致；
 * - graph 通道的 24h 硬编码（graph-executor L371）由本入口消除。
 *
 * 负责人: 阿洲 | 创建日期: 2026-10-31
 */
import { Injectable } from '@nestjs/common';
import {
  ConfirmationService,
  PendingConfirmation,
} from './confirmation.service';
import type { CreateConfirmationInput } from './confirmation.service';

/** 写确认挂起结果（通道适配器据此映射各自的 SSE 事件形态） */
export interface WriteConfirmSuspendResult {
  /** 确认令牌（即 WriteGuard token，wg_ 前缀）——通道事件与确认端点共用 */
  token: string;
  /** 令牌过期时间戳（ms）——单一来源：WriteGuardService.suspend 落库值 */
  expireAt: number;
  /** 完整待确认记录（通道需要 docType/risk/preview 等字段时取用） */
  confirmation: PendingConfirmation;
}

@Injectable()
export class WriteConfirmPipelineService {
  constructor(private readonly confirmationService: ConfirmationService) {}

  /**
   * 写确认挂起唯一入口
   *
   * 三通道在写工具返回 preview 后调用本方法；拿到结果后各自映射既有
   * SSE 事件形态（chat: tool_result+pending_write+await_confirm；
   * agent: 四连含 agent_step；graph: pending_write+await_confirm）。
   * 令牌生成与 expireAt 计算不在此外的任何位置发生。
   */
  /**
   * 写确认令牌 TTL（毫秒）——三通道 await_confirm expireAt 的统一来源
   * （委托 ConfirmationService → WriteGuardService.getTokenTtlMs）
   */
  getTokenTtlMs(): number {
    return this.confirmationService.getTokenTtlMs();
  }

  async suspend(
    input: CreateConfirmationInput,
  ): Promise<WriteConfirmSuspendResult> {
    const confirmation = await this.confirmationService.create(input);
    return {
      token: confirmation.confirmationId,
      expireAt: confirmation.expiresAt,
      confirmation,
    };
  }
}
