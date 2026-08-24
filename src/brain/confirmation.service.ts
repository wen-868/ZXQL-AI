/**
 * ConfirmationService — 写操作确认机制（R70-15）
 *
 * 核心职责（docs/ai-base/智享AI助手-写入操作规范.md 第六章）：
 * 1. 管理待确认操作：所有写操作先生成预览，暂存待确认记录（TTL 5分钟）
 * 2. 生成唯一 confirmation_id，供前端/对话引用
 * 3. 确认词识别："确认/可以/没问题/执行/开单" 等视为确认，其余视为拒绝或修改
 * 4. 可撤销：操作执行成功后 3 分钟内可撤销（仅限未发货状态，由业务侧约束）
 *
 * 存储策略：
 * - 内存 Map（与 ToolRegistry 按租户过滤的内存 Map 模式一致），无外部依赖
 * - 惰性过期清理：每次读写时顺带清除过期记录，避免驻留
 * - 多租户隔离：所有操作按 tenantId 维度存储与校验
 *
 * 接入方：
 * - Orchestrator：工具返回 preview 时调用 create() 暂存待确认操作，tool_result 事件携带 confirmationId
 * - ChatController：提供 confirm / cancel / revoke / list 管理端点
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { ToolResult } from '../tools/tool.interface';

/** 确认记录状态 */
export type ConfirmationStatus =
  | 'pending' // 待确认（预览已生成，等待用户确认）
  | 'confirmed' // 已确认（用户确认，等待执行）
  | 'executed' // 已执行（工具已执行成功）
  | 'cancelled' // 已取消（用户拒绝/取消）
  | 'expired'; // 已过期（超过 TTL）

/** 已执行操作状态 */
export type ExecutedStatus = 'executed' | 'revoked';

/** 待确认操作记录 */
export interface PendingConfirmation {
  /** 唯一确认 ID */
  confirmationId: string;
  /** 租户 ID（多租户隔离） */
  tenantId: string;
  /** 会话 ID（可选，关联对话） */
  conversationId?: string;
  /** 待执行工具名称 */
  toolName: string;
  /** 工具参数（confirm 未置 true 的预览参数） */
  args: Record<string, unknown>;
  /** 预览卡片数据（操作名/摘要/结构化明细） */
  preview?: ToolResult['preview'];
  /** 操作名称（如"创建销售单"，供确认词匹配与展示） */
  operationLabel: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 过期时间戳（创建 + 5 分钟 TTL） */
  expiresAt: number;
  /** 状态 */
  status: ConfirmationStatus;
}

/** 已执行操作记录（撤销窗口管理） */
export interface ExecutedOperation {
  /** 唯一操作 ID */
  operationId: string;
  /** 租户 ID */
  tenantId: string;
  /** 会话 ID（可选） */
  conversationId?: string;
  /** 来源确认 ID（可选，由确认流程产生的执行记录关联） */
  confirmationId?: string;
  /** 执行工具名称 */
  toolName: string;
  /** 执行参数（confirm=true 的最终参数） */
  args: Record<string, unknown>;
  /** 执行结果（ToolResult.data） */
  result?: unknown;
  /** 操作名称 */
  operationLabel: string;
  /** 执行时间戳（ms） */
  executedAt: number;
  /** 撤销截止时间戳（执行 + 3 分钟窗口） */
  revokeExpiresAt: number;
  /** 状态 */
  status: ExecutedStatus;
}

/** 创建待确认记录的输入 */
export interface CreateConfirmationInput {
  /** 租户 ID（必填） */
  tenantId: string;
  /** 会话 ID（可选） */
  conversationId?: string;
  /** 待执行工具名称（必填） */
  toolName: string;
  /** 工具参数（必填） */
  args: Record<string, unknown>;
  /** 预览卡片数据（可选） */
  preview?: ToolResult['preview'];
  /** 操作名称（必填，如"创建销售单"） */
  operationLabel: string;
}

/** 注册已执行操作的输入 */
export interface RegisterExecutedInput {
  /** 租户 ID（必填） */
  tenantId: string;
  /** 会话 ID（可选） */
  conversationId?: string;
  /** 来源确认 ID（可选） */
  confirmationId?: string;
  /** 执行工具名称（必填） */
  toolName: string;
  /** 执行参数（必填） */
  args: Record<string, unknown>;
  /** 执行结果（可选） */
  result?: unknown;
  /** 操作名称（必填） */
  operationLabel: string;
}

/** 待确认操作 TTL：5 分钟 */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;
/** 撤销窗口 TTL：3 分钟 */
export const REVOKE_TTL_MS = 3 * 60 * 1000;

/** 确认词集合（用户说这些词视为确认执行） */
const CONFIRM_KEYWORDS = [
  '确认',
  '可以',
  '好的',
  '没问题',
  '行',
  '对',
  '是的',
  '执行',
  '开单',
  '就这么办',
  '确定',
  '同意',
];

/** 拒绝/取消词集合（用户说这些词视为拒绝或需要修改） */
const CANCEL_KEYWORDS = [
  '取消',
  '算了',
  '不要',
  '等等',
  '不对',
  '改一下',
  '不是这个',
  '撤销',
  '放弃',
  '不执行',
];

@Injectable()
export class ConfirmationService {
  private readonly logger = new Logger(ConfirmationService.name);

  /** 待确认记录：confirmationId → PendingConfirmation */
  private readonly pendingMap = new Map<string, PendingConfirmation>();
  /** 已执行记录：operationId → ExecutedOperation */
  private readonly executedMap = new Map<string, ExecutedOperation>();

  // ── 待确认操作管理 ──

  /**
   * 创建待确认记录（写操作生成预览时调用）
   *
   * @param input 创建输入
   * @returns 新创建的待确认记录（含 confirmationId）
   */
  create(input: CreateConfirmationInput): PendingConfirmation {
    const now = Date.now();
    const confirmation: PendingConfirmation = {
      confirmationId: randomUUID(),
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      toolName: input.toolName,
      args: input.args,
      preview: input.preview,
      operationLabel: input.operationLabel,
      createdAt: now,
      expiresAt: now + CONFIRM_TTL_MS,
      status: 'pending',
    };

    this.pendingMap.set(confirmation.confirmationId, confirmation);
    this.logger.log(
      `创建待确认操作：id=${confirmation.confirmationId} tenant=${input.tenantId} tool=${input.toolName}（${input.operationLabel}）`,
    );

    return confirmation;
  }

  /**
   * 查询待确认记录（惰性过期检查）
   *
   * @param confirmationId 确认 ID
   * @returns 待确认记录；不存在或已过期返回 null
   */
  get(confirmationId: string): PendingConfirmation | null {
    const record = this.pendingMap.get(confirmationId);
    if (!record) {
      return null;
    }

    // 惰性过期检查
    if (Date.now() > record.expiresAt) {
      this.pendingMap.delete(confirmationId);
      this.logger.warn(
        `待确认操作已过期：id=${confirmationId} tool=${record.toolName}`,
      );
      return null;
    }

    return record;
  }

  /**
   * 列出某租户全部待确认操作（未过期）
   *
   * @param tenantId 租户 ID
   * @returns 待确认记录列表（按创建时间倒序）
   */
  listPending(tenantId: string): PendingConfirmation[] {
    const records: PendingConfirmation[] = [];

    for (const [id, record] of this.pendingMap) {
      // 过期清理 + 跳过其他租户
      if (Date.now() > record.expiresAt) {
        this.pendingMap.delete(id);
        continue;
      }
      if (record.tenantId === tenantId) {
        records.push(record);
      }
    }

    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 确认待确认操作（用户说"确认"后调用）
   *
   * 校验：记录存在、未过期、租户匹配、状态为 pending。
   * 确认后将状态置为 confirmed，返回操作数据供执行方调用工具（confirm=true）。
   *
   * @param confirmationId 确认 ID
   * @param tenantId       租户 ID（隔离校验）
   * @returns 确认结果
   */
  confirm(
    confirmationId: string,
    tenantId: string,
  ):
    | { success: true; confirmation: PendingConfirmation }
    | { success: false; error: string } {
    const record = this.get(confirmationId);
    if (!record) {
      return {
        success: false,
        error: '待确认操作不存在或已过期，请重新发起操作',
      };
    }

    if (record.tenantId !== tenantId) {
      return { success: false, error: '无权操作其他租户的待确认记录' };
    }

    if (record.status !== 'pending') {
      return {
        success: false,
        error: `待确认操作状态为 ${record.status}，无法重复确认`,
      };
    }

    record.status = 'confirmed';
    this.logger.log(
      `用户已确认操作：id=${confirmationId} tool=${record.toolName}（${record.operationLabel}）`,
    );

    return { success: true, confirmation: record };
  }

  /**
   * 取消待确认操作（用户拒绝/取消时调用）
   *
   * @param confirmationId 确认 ID
   * @param tenantId       租户 ID
   * @returns 是否取消成功
   */
  cancel(confirmationId: string, tenantId: string): boolean {
    const record = this.pendingMap.get(confirmationId);
    if (!record) {
      return false;
    }

    if (record.tenantId !== tenantId) {
      return false;
    }

    record.status = 'cancelled';
    this.pendingMap.delete(confirmationId);
    this.logger.log(
      `用户已取消操作：id=${confirmationId} tool=${record.toolName}（${record.operationLabel}）`,
    );

    return true;
  }

  /**
   * 清理全部过期记录（可由定时任务或手动调用）
   *
   * @returns 清理数量
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, record] of this.pendingMap) {
      if (now > record.expiresAt) {
        this.pendingMap.delete(id);
        cleaned++;
      }
    }

    for (const [id, record] of this.executedMap) {
      if (now > record.revokeExpiresAt) {
        this.executedMap.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.log(`清理过期确认/撤销记录：${cleaned} 条`);
    }

    return cleaned;
  }

  // ── 可撤销窗口管理 ──

  /**
   * 注册已执行操作（工具执行成功后调用，开启 3 分钟撤销窗口）
   *
   * @param input 已执行操作信息
   * @returns 已执行操作记录（含 operationId）
   */
  registerExecuted(input: RegisterExecutedInput): ExecutedOperation {
    const now = Date.now();
    const operation: ExecutedOperation = {
      operationId: randomUUID(),
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      confirmationId: input.confirmationId,
      toolName: input.toolName,
      args: input.args,
      result: input.result,
      operationLabel: input.operationLabel,
      executedAt: now,
      revokeExpiresAt: now + REVOKE_TTL_MS,
      status: 'executed',
    };

    this.executedMap.set(operation.operationId, operation);
    this.logger.log(
      `注册已执行操作（可撤销窗口 3 分钟）：id=${operation.operationId} tool=${input.toolName}（${input.operationLabel}）`,
    );

    return operation;
  }

  /**
   * 查询已执行操作
   *
   * @param operationId 操作 ID
   * @returns 已执行操作记录；不存在返回 null
   */
  getExecuted(operationId: string): ExecutedOperation | null {
    return this.executedMap.get(operationId) ?? null;
  }

  /**
   * 校验操作是否可撤销
   *
   * 撤销条件（写入操作规范 6.3）：
   * - 操作存在
   * - 租户匹配
   * - 执行后 3 分钟内
   * - 尚未撤销
   * （"仅限未发货状态"由业务侧工具约束，本服务负责窗口与状态校验）
   *
   * @param operationId 操作 ID
   * @param tenantId    租户 ID
   * @returns 校验结果
   */
  canRevoke(
    operationId: string,
    tenantId: string,
  ): { ok: boolean; reason?: string } {
    const operation = this.executedMap.get(operationId);
    if (!operation) {
      return { ok: false, reason: '操作记录不存在或已过期' };
    }

    if (operation.tenantId !== tenantId) {
      return { ok: false, reason: '无权操作其他租户的记录' };
    }

    if (operation.status === 'revoked') {
      return { ok: false, reason: '该操作已被撤销' };
    }

    if (Date.now() > operation.revokeExpiresAt) {
      return {
        ok: false,
        reason: '超过 3 分钟撤销窗口，请通过正常流程处理',
      };
    }

    return { ok: true };
  }

  /**
   * 标记操作已撤销
   *
   * @param operationId 操作 ID
   * @param tenantId    租户 ID
   * @returns 是否撤销成功
   */
  markRevoked(operationId: string, tenantId: string): boolean {
    const check = this.canRevoke(operationId, tenantId);
    if (!check.ok) {
      this.logger.warn(
        `撤销被拒绝：id=${operationId} tenant=${tenantId} reason=${check.reason ?? '未知'}`,
      );
      return false;
    }

    const operation = this.executedMap.get(operationId)!;
    operation.status = 'revoked';
    this.executedMap.delete(operationId);
    this.logger.log(
      `操作已撤销：id=${operationId} tool=${operation.toolName}（${operation.operationLabel}）`,
    );

    return true;
  }

  // ── 确认词/拒绝词识别 ──

  /**
   * 判断用户消息是否为确认词
   *
   * 规则：消息去除空白后，以任一确认词开头或完全等于确认词。
   * 示例："确认"、"确认创建"、"可以，就这么办"、"没问题" 均视为确认。
   *
   * @param message 用户消息
   * @returns 是否为确认
   */
  static isConfirmMessage(message: string): boolean {
    const normalized = message.replace(/\s+/g, '');
    return CONFIRM_KEYWORDS.some((kw) => {
      // 完全等于确认词
      if (normalized === kw) {
        return true;
      }
      // 以确认词开头 + 常见确认后缀（避免"行李箱/对比一下"等误判）
      if (normalized.startsWith(kw)) {
        const rest = normalized.slice(kw.length);
        if (rest.length === 0) {
          return true;
        }
        return (
          rest.startsWith('创建') ||
          rest.startsWith('执行') ||
          rest.startsWith('开单') ||
          /^[，,。！!？?好的吧啊的嗯对]/.test(rest)
        );
      }
      return false;
    });
  }

  /**
   * 判断用户消息是否为拒绝/取消词
   *
   * 规则：消息去除空白后，以任一取消词开头或包含。
   * 示例："取消"、"算了，不创建了"、"改一下数量" 均视为拒绝/修改。
   *
   * @param message 用户消息
   * @returns 是否为拒绝/取消
   */
  static isCancelMessage(message: string): boolean {
    const normalized = message.replace(/\s+/g, '');
    return CANCEL_KEYWORDS.some((kw) => normalized.includes(kw));
  }
}
