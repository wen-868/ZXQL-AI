/**
 * ConfirmationService — 写操作确认机制（R70-15，P0-1 对接 WriteGuard 令牌）
 *
 * 核心职责（docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 23 章 WriteGuard）：
 * 1. 管理待确认操作：所有写操作先生成预览，经 WriteGuardService 挂起生成令牌（Redis，24h TTL）
 * 2. 确认词识别："确认/可以/没问题/执行/开单" 等视为确认，其余视为拒绝或修改
 * 3. 高危写二次确认：risk=high 或 needsReview 的操作需二次确认才真正执行（资金/删除/批量）
 * 4. 可撤销：操作执行成功后 3 分钟内可撤销（仅限未发货状态，由业务侧约束）
 *
 * P0-1 演进（保持前端体验，后端改令牌）：
 * - confirmationId 即 WriteGuard token（wg_ 前缀），前端确认卡无需改动
 * - 存储由内存 Map 升级为 Redis（24h TTL），Redis 不可用自动降级内存
 * - confirm/cancel 全轨迹审计（t_ai_audit_log，token 脱敏）
 *
 * 接入方：
 * - Orchestrator：工具返回 preview 时调用 create() 暂存待确认操作，tool_result 事件携带 confirmationId
 * - ChatController / WriteGuardController：confirm / cancel / revoke / list 管理端点
 *
 * 负责人: AI底座 | 创建日期: 2026-08-02（P0-1 重构 2026-08-25）
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  ToolContext,
  ToolResult,
  ToolRisk,
} from '../tools/tool.interface';
import { ToolExecutor } from '../tools/tool-executor';
import {
  PendingWrite,
  WriteGuardService,
  WRITE_TOKEN_TTL_MS,
} from './write-guard.service';

/** 确认记录状态（保持与 WriteGuard 状态机对齐） */
export type ConfirmationStatus =
  | 'pending' // 待确认（预览已生成，等待用户确认）
  | 'first_confirmed' // 首次确认（高危写，等待二次确认）
  | 'confirmed' // 已确认（用户确认，等待执行）
  | 'cancelled' // 已取消（用户拒绝/取消）
  | 'expired'; // 已过期（超过 TTL）

/** 已执行操作状态 */
export type ExecutedStatus = 'executed' | 'revoked';

/** 待确认操作记录 */
export interface PendingConfirmation {
  /** 唯一确认 ID（即 WriteGuard token） */
  confirmationId: string;
  /** 租户 ID（多租户隔离） */
  tenantId: string;
  /** 会话 ID（可选，关联对话） */
  conversationId?: string;
  /** 自主任务计划 ID（可选；Agent 内核写步骤挂起） */
  planId?: number;
  /** 计划步骤 ID（可选；Agent 内核写步骤挂起） */
  planStepId?: string;
  /** 待执行工具名称 */
  toolName: string;
  /** 文档类型（写入业务对象，如 sales_order_create） */
  docType: string;
  /** 风险分级 */
  risk: ToolRisk;
  /** 是否强制人工审核 */
  needsReview: boolean;
  /** 已确认次数（高危写二次确认计数） */
  confirmCount: number;
  /** 工具参数（confirm 未置 true 的预览参数） */
  args: Record<string, unknown>;
  /** 预览卡片数据（操作名/摘要/结构化明细） */
  preview?: ToolResult['preview'];
  /** 操作名称（如"创建销售单"，供确认词匹配与展示） */
  operationLabel: string;
  /** 创建时间戳（ms） */
  createdAt: number;
  /** 过期时间戳（创建 + 24h TTL） */
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
  /** 自主任务计划 ID（可选） */
  planId?: number;
  /** 计划步骤 ID（可选） */
  planStepId?: string;
  /** 待执行工具名称（必填） */
  toolName: string;
  /** 文档类型（可选，默认工具名；P0-2 由 WriteSchemaRegistry 统一定义） */
  docType?: string;
  /** 风险分级（可选，默认 medium——写操作一律须令牌确认） */
  risk?: ToolRisk;
  /** 是否强制人工审核（可选，默认 risk=high） */
  needsReview?: boolean;
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

/** 确认结果（含高危二次确认标记） */
export type ConfirmResult =
  | {
      success: true;
      confirmation: PendingConfirmation;
      /** true = 高危写首次确认，需二次确认后才真正执行 */
      needsSecondConfirm?: boolean;
    }
  | { success: false; error: string };

/** 确认并执行结果 */
export interface ConfirmAndExecuteResult {
  success: boolean;
  data?: unknown;
  operationId?: string;
  message?: string;
  error?: string;
  suggestion?: string;
  needsSecondConfirm?: boolean;
}

/** 待确认操作 TTL：24 小时（WriteGuard 令牌制，P0-1） */
export const CONFIRM_TTL_MS = WRITE_TOKEN_TTL_MS;
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
  private readonly writeGuardService: WriteGuardService;

  /** 已执行记录：operationId → ExecutedOperation（撤销窗口，内存 3 分钟） */
  private readonly executedMap = new Map<string, ExecutedOperation>();

  constructor(
    @Optional() writeGuard?: WriteGuardService,
    @Optional() private readonly executor?: ToolExecutor,
  ) {
    // 未注入（单测/独立使用）时创建内存降级实例
    this.writeGuardService =
      writeGuard ??
      new WriteGuardService({
        get: () => undefined,
      } as unknown as ConfigService);
  }

  // ── 待确认操作管理（WriteGuard 令牌制）──

  /**
   * 创建待确认记录（写操作生成预览时调用）
   *
   * 内部委托 WriteGuardService.suspend() 生成令牌（Redis 24h TTL）。
   *
   * @param input 创建输入
   * @returns 新创建的待确认记录（confirmationId = WriteGuard token）
   */
  async create(input: CreateConfirmationInput): Promise<PendingConfirmation> {
    const risk = input.risk ?? 'medium';
    const write: PendingWrite = await this.writeGuardService.suspend({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      planId: input.planId,
      planStepId: input.planStepId,
      toolName: input.toolName,
      docType: input.docType ?? input.toolName,
      risk,
      needsReview: input.needsReview ?? risk === 'high',
      args: input.args,
      preview: input.preview,
      operationLabel: input.operationLabel,
    });

    return this.toConfirmation(write);
  }

  /**
   * 查询待确认记录（惰性过期检查，委托 WriteGuardService）
   *
   * @param confirmationId 确认 ID（即令牌）
   * @returns 待确认记录；不存在或已过期返回 null
   */
  async get(confirmationId: string): Promise<PendingConfirmation | null> {
    // 无租户上下文时无法校验隔离，先尝试从所有已知租户读取：
    // 实际调用均携带 tenantId（getByTenant），此方法仅兼容旧式单参查询
    const write = await this.writeGuardService.get(confirmationId, '*');
    return write ? this.toConfirmation(write) : null;
  }

  /**
   * 按租户查询待确认记录
   *
   * @param confirmationId 确认 ID（即令牌）
   * @param tenantId       租户 ID
   * @returns 待确认记录；不存在或已过期返回 null
   */
  async getByTenant(
    confirmationId: string,
    tenantId: string,
  ): Promise<PendingConfirmation | null> {
    const write = await this.writeGuardService.get(confirmationId, tenantId);
    return write ? this.toConfirmation(write) : null;
  }

  /**
   * 列出某租户全部待确认操作（未过期）
   *
   * @param tenantId 租户 ID
   * @returns 待确认记录列表（按创建时间倒序）
   */
  async listPending(tenantId: string): Promise<PendingConfirmation[]> {
    const writes = await this.writeGuardService.listPending(tenantId);
    return writes.map((w) => this.toConfirmation(w));
  }

  /**
   * 确认待确认操作（用户说"确认"后调用）
   *
   * 委托 WriteGuardService.confirm()：租户隔离 + 状态机 + 高危二次确认。
   * 高危写（risk=high / needsReview）首次确认返回 needsSecondConfirm=true，
   * 需再次调用 confirm() 才会真正放行执行。
   *
   * @param confirmationId 确认 ID（令牌）
   * @param tenantId       租户 ID（隔离校验）
   * @returns 确认结果
   */
  async confirm(
    confirmationId: string,
    tenantId: string,
  ): Promise<ConfirmResult> {
    const result = await this.writeGuardService.confirm(
      confirmationId,
      tenantId,
    );
    if (!result.success || !result.pendingWrite) {
      return { success: false, error: result.error ?? '确认失败' };
    }
    return {
      success: true,
      confirmation: this.toConfirmation(result.pendingWrite),
      needsSecondConfirm: result.needsSecondConfirm,
    };
  }

  /**
   * 确认并执行（WriteGuard 完整流程，供 ChatController / WriteGuardController 复用）
   *
   * 流程：confirm 校验 → 高危二次确认（needsSecondConfirm=true 时返回，不执行）
   *       → 构造 confirm=true 参数 → 调用工具执行 → 注册 3 分钟撤销窗口
   *
   * @param token       令牌
   * @param tenantId    租户 ID
   * @param toolContext 工具执行上下文
   * @param remark      执行备注（可选）
   * @returns 执行结果
   */
  async confirmAndExecute(
    token: string,
    tenantId: string,
    toolContext: ToolContext,
    remark?: string,
  ): Promise<ConfirmAndExecuteResult> {
    const confirmed = await this.confirm(token, tenantId);
    if (!confirmed.success) {
      return { success: false, error: confirmed.error };
    }
    if (confirmed.needsSecondConfirm) {
      return {
        success: true,
        needsSecondConfirm: true,
        message: '高危操作需二次确认，请再次确认执行',
      };
    }
    return this.executeConfirmed(confirmed.confirmation, toolContext, remark);
  }

  /**
   * 执行已确认操作（构造 confirm=true 参数 → 调用工具 → 注册撤销窗口）
   *
   * @param record      已确认的待确认记录
   * @param toolContext 工具执行上下文
   * @param remark      执行备注（可选）
   * @returns 执行结果
   */
  async executeConfirmed(
    record: PendingConfirmation,
    toolContext: ToolContext,
    remark?: string,
  ): Promise<ConfirmAndExecuteResult> {
    if (!this.executor) {
      return { success: false, error: '工具执行器不可用（服务未装配）' };
    }

    // 构造最终执行参数（confirm=true）
    const execArgs: Record<string, unknown> = {
      ...record.args,
      confirm: true,
    };
    if (remark && record.args.remark === undefined) {
      execArgs.remark = remark;
    }

    const result = await this.executor.executeToolCall(
      {
        id: `confirm-${record.confirmationId}`,
        type: 'function',
        function: {
          name: record.toolName,
          arguments: JSON.stringify(execArgs),
        },
      },
      toolContext,
    );

    if (!result.success) {
      this.logger.warn(
        `确认执行失败：id=${record.confirmationId} tool=${record.toolName} error=${result.error ?? '未知'}`,
      );
      return {
        success: false,
        error: result.error ?? '工具执行失败',
        suggestion: result.suggestion,
      };
    }

    // 执行成功 → 注册 3 分钟撤销窗口
    const operation = this.registerExecuted({
      tenantId: record.tenantId,
      conversationId: record.conversationId,
      confirmationId: record.confirmationId,
      toolName: record.toolName,
      args: execArgs,
      result: result.data,
      operationLabel: record.operationLabel,
    });

    this.logger.log(
      `确认执行成功：id=${record.confirmationId} tool=${record.toolName} operationId=${operation.operationId}`,
    );

    return {
      success: true,
      data: result.data,
      operationId: operation.operationId,
      message: `${record.operationLabel}执行成功，3 分钟内可撤销`,
    };
  }

  /**
   * 取消待确认操作（用户拒绝/取消时调用）
   *
   * @param confirmationId 确认 ID（令牌）
   * @param tenantId       租户 ID
   * @returns 是否取消成功
   */
  async cancel(confirmationId: string, tenantId: string): Promise<boolean> {
    return this.writeGuardService.cancel(confirmationId, tenantId);
  }

  /**
   * 清理过期记录（WriteGuard 内存模式 + 本服务撤销窗口）
   *
   * @returns 清理数量
   */
  cleanupExpired(): number {
    const now = Date.now();
    let cleaned = this.writeGuardService.cleanupExpired();

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

  // ── 类型转换 ──

  private toConfirmation(write: PendingWrite): PendingConfirmation {
    return {
      confirmationId: write.token,
      tenantId: write.tenantId,
      conversationId: write.conversationId,
      planId: write.planId,
      planStepId: write.planStepId,
      toolName: write.toolName,
      docType: write.docType,
      risk: write.risk,
      needsReview: write.needsReview,
      confirmCount: write.confirmCount,
      args: write.args,
      preview: write.preview,
      operationLabel: write.operationLabel,
      createdAt: write.createdAt,
      expiresAt: write.expiresAt,
      status: write.status,
    };
  }
}
