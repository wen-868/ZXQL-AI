/**
 * ProactivePushService — AI 主动推送服务
 *
 * 职责：
 * 1. 将 AI 定时巡检生成的推送内容写入 t_push_log 表（系统级推送流水，user_id=0 表示系统触发）
 * 2. 同步记录审计日志（AuditLogger，intent=proactive_<task>，含租户 + 推送内容）
 *
 * 设计说明（R70-20）：
 * - 后端推送 API（/api/admin/push/*）全部 requireAuthWithTenant，需要商家用户 JWT；
 *   AI 底座定时巡检是无用户上下文的后台任务，无法携带用户 JWT 调用后端推送接口。
 * - 因此推送落地采用「直写共享 MySQL 的 t_push_log 表」方案（AI 底座与后端共用 liquor_inventory 实例），
 *   渠道标记为 ai_proactive，便于工作台区分 AI 主动推送流水。
 * - 真实移动端/Web 推送（JPush/FCM/HMS/WebSocket/对话卡片）由后端推送通道承载，
 *   本服务落库的推送记录可供后端/前端读取后二次分发展示。
 * - 审计日志（t_ai_audit_log）带 tenant_id，作为按租户维度的 AI 主动推送留痕。
 *
 * 对应表结构：
 * - t_push_log（docs/migrations/066_add_push_log.sql）
 * - t_ai_audit_log（docs/migrations/121_ai_base_tables.sql）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditLogger } from '../../bridge/audit-logger';
import { PushGatewayService } from '../../gateway/push-gateway.service';
import { ProactivePush } from './proactive.types';

@Injectable()
export class ProactivePushService {
  private readonly logger = new Logger(ProactivePushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly auditLogger: AuditLogger,
    private readonly pushGateway: PushGatewayService,
  ) {}

  /**
   * 推送一条 AI 主动消息
   *
   * @param tenantId 租户 ID
   * @param taskName 巡检任务名（用于审计 intent 与日志）
   * @param push     推送内容
   * @returns 是否成功落库
   */
  async push(
    tenantId: string,
    taskName: string,
    push: ProactivePush,
  ): Promise<boolean> {
    // ── 1. 写入 t_push_log（系统级推送流水） ──
    try {
      await this.dataSource.query(
        `INSERT INTO t_push_log
          (user_id, template_id, push_type, channel, title, content, status, error_msg, created_at)
         VALUES (0, NULL, ?, 'ai_proactive', ?, ?, 'SUCCESS', NULL, NOW())`,
        [push.type, push.title, push.content],
      );
    } catch (err) {
      // 推送流水写入失败不影响巡检主流程，仅记日志并返回失败
      this.logger.warn(
        `AI 主动推送写入 t_push_log 失败（task=${taskName}, tenant=${tenantId}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }

    // ── 2. 审计留痕（fire-and-forget，不阻塞） ──
    this.auditLogger.logAiCall({
      tenantId,
      intent: `proactive_${taskName}`,
      userMessage: push.title,
      toolCalls: [
        {
          tool_name: `proactive_${taskName}`,
          is_write_operation: false,
          success: true,
          duration_ms: 0,
          priority: push.priority,
          content: push.content.slice(0, 500),
        },
      ],
      promptTokens: 0,
      completionTokens: 0,
      success: true,
    });

    // ── 3. WebSocket 实时推送（R70 完善度 P1）：推送给该租户在线前端，失败不影响落库 ──
    try {
      this.pushGateway.broadcast(tenantId, {
        title: push.title,
        content: push.content,
        type: push.type,
        priority: push.priority,
        extras: push.extras,
        pushedAt: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `AI 主动推送实时广播失败（task=${taskName}, tenant=${tenantId}）：${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    this.logger.debug(
      `AI 主动推送成功：task=${taskName} tenant=${tenantId} title=${push.title}`,
    );
    return true;
  }
}
