/**
 * Audit Logger — AI 审计日志服务
 *
 * 职责：
 * 1. 每次AI调用（LLM 请求）写入 t_ai_audit_log 表（含 provider/model/tokens/latency/成功失败）
 * 2. 每次工具调用（Tool 执行）写入 t_ai_audit_log 表（含 tool_name/参数/结果/耗时）
 * 3. 异步更新 t_ai_usage_daily 表（按租户+日期+服务商汇总用量，UPSERT 模式）
 * 4. 全部异步写入（fire-and-forget），不阻塞主流程；写入失败仅记日志不抛异常
 *
 * 设计原则：
 * - 审计是"best-effort"：日志写入失败不影响业务流程
 * - 异步写入：用 setImmediate / Promise.resolve().then() 解耦，不 await
 * - 脱敏处理：tool_calls JSON 中不记录完整敏感参数（如密码），由调用方负责脱敏
 * - 日量预估：单租户日均 ~500 条审计记录，t_ai_audit_log 按月分区（后续优化）
 *
 * 对应文档：
 * - docs/ai-base/智享AI底座-架构设计文档.md 第七章 7.1 审计日志表
 * - docs/ai-base/智享AI底座-开发文档.md 第八章 审计与计费
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AiAuditLogEntity } from '../database/entities/ai-audit-log.entity';
import {
  ToolCategory,
  ToolExecutionRecord,
  ToolRisk,
} from '../tools/tool.interface';
import { bestEffort } from '../common/error-semantics';

/**
 * 执行车道（取证埋点，方案 12.4）
 *
 * 此前审计表没有车道维度，只能靠 intent 反推，无法回答"哪条通道在干活"。
 */
export type AuditLane =
  | 'chat' // 主对话（Orchestrator Agent Loop）
  | 'agent' // 计划编排（planner + task-runner）
  | 'graph' // 图执行
  | 'proactive' // 主动推送（定时任务/信号驱动）
  | 'evidence' // 取证台账
  | 'tool'; // 单次工具执行（ToolExecutor 直记）

/**
 * AI 调用审计记录（由 Brain Engine / Gateway 在 LLM 调用后组装）
 */
export interface AiCallAuditRecord {
  /** 租户 ID */
  tenantId: string;
  /** 用户 ID */
  userId?: string;
  /** 会话 ID */
  sessionId?: string;
  /** AI 服务商（deepseek / ollama） */
  provider?: string;
  /** 模型名称 */
  model?: string;
  /** 意图标签（如 'sales_order_create' / 'inventory_query'） */
  intent?: string;
  /** 数字员工 UID（以数字员工身份运行时署名） */
  employeeUid?: string;
  /** 执行车道（取证埋点，方案 12.4） */
  lane?: AuditLane;
  /**
   * 本次调用触及的业务域（取证埋点，方案 12.4）
   *
   * 由调用方按工具 → ToolCategory 归并去重后传入（AuditLogger 不持有工具注册表，
   * 避免 bridge ↔ tools 双向依赖）。跨域占比统计以此为据。
   */
  categories?: ToolCategory[];
  /** 用户消息原文 */
  userMessage?: string;
  /** 意图分诊通道（rules/llm/chat/fallback） */
  triageLane?: string;
  /** 分诊业务域（逗号分隔） */
  triageCategories?: string;
  /** 工具调用记录（JSON 数组，包含每次 tool_call 的 name/args/success/duration） */
  toolCalls?: Record<string, unknown>[];
  /** 提示 Token 数 */
  promptTokens: number;
  /** 完成 Token 数 */
  completionTokens: number;
  /** 本次调用延迟毫秒 */
  latencyMs?: number;
  /** 是否成功 */
  success: boolean;
  /** 错误信息（失败时记录） */
  errorMessage?: string;
  /** P1-3 降级元数据（Provider 降级链切换记录） */
  fallback?: {
    used: boolean;
    from: string;
    to: string;
    reason: string;
    attempts: string[];
    latencyMs: number;
  };
}

/**
 * 审计日志写入条目（工具执行维度）
 *
 * 存入 t_ai_audit_log.tool_calls JSON 数组的单个元素结构。
 */
interface ToolCallAuditEntry {
  /** 工具名称 */
  tool_name: string;
  /** 是否为写操作 */
  is_write_operation: boolean;
  /** 执行是否成功 */
  success: boolean;
  /** 执行耗时毫秒 */
  duration_ms: number;
  /** 错误信息（失败时） */
  error?: string;
  /** 入参摘要（已脱敏，截断超长参数） */
  args_summary: Record<string, unknown>;
}

/**
 * WriteGuard 写审核事件审计记录（P0-1）
 *
 * 覆盖写操作全轨迹：挂起（pending）/ 首次确认（first_confirmed）/ 确认（confirmed）/
 * 取消（cancelled）/ 过期（expired）。token 入库前必须脱敏（maskToken）。
 */
export interface WriteGuardAuditRecord {
  /** 租户 ID */
  tenantId: string;
  /** 会话 ID（可选） */
  sessionId?: string;
  /** 事件类型 */
  event: 'pending' | 'first_confirmed' | 'confirmed' | 'cancelled' | 'expired';
  /** 令牌（已脱敏） */
  token: string;
  /** 工具名称 */
  toolName: string;
  /** 文档类型 */
  docType: string;
  /** 风险分级 */
  risk: ToolRisk;
  /** 是否强制人工审核 */
  needsReview: boolean;
  /** 操作名称 */
  operationLabel: string;
  /** 预览摘要（可选） */
  summary?: string;
}

@Injectable()
export class AuditLogger {
  private readonly logger = new Logger(AuditLogger.name);

  constructor(
    @InjectRepository(AiAuditLogEntity)
    private readonly auditLogRepo: Repository<AiAuditLogEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * 记录一次 AI 调用（LLM 请求）
   *
   * 由 Brain Engine 在每次 LLM 调用（流式或非流式）完成后调用。
   * 异步写入 t_ai_audit_log，同时更新 t_ai_usage_daily 汇总。
   *
   * @param record AI 调用审计记录
   */
  logAiCall(record: AiCallAuditRecord): void {
    // 异步写入，不阻塞主流程
    this.fireAndForget(
      async () => {
        // P1-3：Provider 降级元数据并入 tool_calls（event=provider_fallback）
        const toolCalls = [...(record.toolCalls ?? [])];
        if (record.fallback?.used) {
          toolCalls.push({
            event: 'provider_fallback',
            from: record.fallback.from,
            to: record.fallback.to,
            reason: record.fallback.reason,
            attempts: record.fallback.attempts,
            latency_ms: record.fallback.latencyMs,
          });
        }

        // 合规脱敏（2026-09-05 找茬审计 #4）：AUDIT_MASK_MESSAGE=true 时对
        // 对话原文做 PII 掩码（手机号/连续证件号），审计仍可排障但不存明文 PII
        let userMessage = record.userMessage ?? null;
        // P2 修复（2026-10-04）：掩码默认开启（此前默认 false，手机号/证件号
        // 明文入库）；需关闭时显式设 AUDIT_MASK_MESSAGE=false
        if (
          userMessage &&
          (process.env.AUDIT_MASK_MESSAGE || 'true') === 'true'
        ) {
          userMessage = userMessage
            .replace(
              /1[3-9]\d{9}/g,
              (m) => m.slice(0, 3) + '****' + m.slice(-2),
            )
            .replace(/\d{15,18}/g, (m) => m.slice(0, 4) + '****' + m.slice(-3));
        }

        const entity = this.auditLogRepo.create({
          tenantId: record.tenantId,
          userId: record.userId ?? null,
          sessionId: record.sessionId ?? null,
          provider: record.provider ?? null,
          model: record.model ?? null,
          intent: record.intent ?? null,
          employeeUid: record.employeeUid ?? null,
          triageLane: record.triageLane ?? null,
          triageCategories: record.triageCategories ?? null,
          lane: record.lane ?? null,
          categories: record.categories?.length ? record.categories : null,
          userMessage,
          toolCalls: toolCalls.length > 0 ? toolCalls : null,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
          latencyMs: record.latencyMs ?? null,
          success: record.success ? 1 : 0,
          errorMessage: record.errorMessage ?? null,
        });
        await this.auditLogRepo.save(entity);

        // 更新日用量汇总
        await this.upsertDailyUsage({
          tenantId: record.tenantId,
          provider: record.provider ?? null,
          model: record.model ?? null,
          chatCount: 1,
          toolCallCount: record.toolCalls?.length ?? 0,
          promptTokens: record.promptTokens,
          completionTokens: record.completionTokens,
        });

        this.logger.debug(
          `审计日志已写入：tenant=${record.tenantId} provider=${record.provider} tokens=${record.promptTokens + record.completionTokens} success=${record.success}`,
        );
      },
      {
        op: 'audit.logAiCall',
        tenantId: record.tenantId,
        detail:
          `lane=${record.lane ?? '-'} intent=${record.intent ?? '-'} ` +
          `tokens=${record.promptTokens + record.completionTokens} success=${record.success} ` +
          `session=${record.sessionId ?? '-'}`,
      },
    );
  }

  /**
   * 记录一次工具执行
   *
   * 由 ToolExecutor 在每次工具执行完成后调用。
   * 异步写入 t_ai_audit_log（intent='tool_execution'），同时更新 t_ai_usage_daily 的 tool_call_count。
   *
   * @param record 工具执行记录（由 ToolExecutor 组装）
   */
  logToolExecution(record: ToolExecutionRecord): void {
    this.fireAndForget(
      async () => {
        // 构造工具调用审计条目
        const toolCallEntry: ToolCallAuditEntry = {
          tool_name: record.toolName,
          is_write_operation: record.isWriteOperation,
          success: record.success,
          duration_ms: record.durationMs,
          error: record.error,
          args_summary: this.sanitizeArgs(record.args),
        };

        const entity = this.auditLogRepo.create({
          tenantId: record.context.tenantId,
          userId: record.context.userId ?? null,
          sessionId: record.context.sessionId ?? null,
          provider: null,
          model: null,
          intent: 'tool_execution',
          lane: 'tool',
          categories: record.category ? [record.category] : null,
          userMessage: null,
          toolCalls: [toolCallEntry as unknown as Record<string, unknown>],
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: record.durationMs,
          success: record.success ? 1 : 0,
          errorMessage: record.error ?? null,
        });
        await this.auditLogRepo.save(entity);

        // 更新日用量汇总（仅 tool_call_count +1）
        await this.upsertDailyUsage({
          tenantId: record.context.tenantId,
          provider: null,
          model: null,
          chatCount: 0,
          toolCallCount: 1,
          promptTokens: 0,
          completionTokens: 0,
        });

        this.logger.debug(
          `工具审计已写入：tool=${record.toolName} tenant=${record.context.tenantId} success=${record.success} ${record.durationMs}ms`,
        );
      },
      {
        op: 'audit.logToolExecution',
        tenantId: record.context.tenantId,
        detail:
          `tool=${record.toolName} category=${record.category ?? '-'} ` +
          `success=${record.success} session=${record.context.sessionId ?? '-'}`,
      },
    );
  }

  /**
   * 记录 WriteGuard 写审核事件（P0-1）
   *
   * 由 WriteGuardService 在令牌状态流转时调用（挂起/首次确认/确认/取消/过期），
   * 写入 t_ai_audit_log（intent='write_guard'，tool_calls 携带事件明细）。
   *
   * @param record 写审核事件记录
   */
  logWriteGuardEvent(record: WriteGuardAuditRecord): void {
    this.fireAndForget(
      async () => {
        const entity = this.auditLogRepo.create({
          tenantId: record.tenantId,
          userId: null,
          sessionId: record.sessionId ?? null,
          provider: null,
          model: null,
          intent: 'write_guard',
          userMessage: record.operationLabel,
          toolCalls: [
            {
              event: record.event,
              token: record.token,
              tool_name: record.toolName,
              doc_type: record.docType,
              risk: record.risk,
              needs_review: record.needsReview,
              summary: record.summary,
            },
          ],
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: null,
          success: 1,
          errorMessage: null,
        });
        await this.auditLogRepo.save(entity);

        this.logger.debug(
          `WriteGuard 审计已写入：event=${record.event} tenant=${record.tenantId} tool=${record.toolName}`,
        );
      },
      {
        op: 'audit.logWriteGuardEvent',
        tenantId: record.tenantId,
        detail:
          `event=${record.event} tool=${record.toolName} docType=${record.docType} ` +
          `risk=${record.risk} needsReview=${record.needsReview}`,
      },
    );
  }

  /**
   * 查询审计日志（工作台用）
   *
   * @param tenantId 租户 ID
   * @param options  查询条件（日期范围 / 意图 / 分页）
   * @returns 审计日志列表
   */
  async queryAuditLogs(
    tenantId: string,
    options?: {
      startDate?: string;
      endDate?: string;
      intent?: string;
      sessionId?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<{ list: AiAuditLogEntity[]; total: number }> {
    const page = options?.page ?? 1;
    const pageSize = options?.pageSize ?? 20;

    const qb = this.auditLogRepo
      .createQueryBuilder('log')
      .where('log.tenant_id = :tenantId', { tenantId })
      .orderBy('log.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (options?.startDate) {
      qb.andWhere('log.created_at >= :startDate', {
        startDate: options.startDate,
      });
    }
    if (options?.endDate) {
      qb.andWhere('log.created_at <= :endDate', { endDate: options.endDate });
    }
    if (options?.intent) {
      qb.andWhere('log.intent = :intent', { intent: options.intent });
    }
    if (options?.sessionId) {
      qb.andWhere('log.session_id = :sessionId', {
        sessionId: options.sessionId,
      });
    }

    const [list, total] = await qb.getManyAndCount();
    return { list, total };
  }

  /**
   * UPSERT 日用量汇总
   *
   * 按 (tenant_id, stat_date, provider) **三列**唯一键：
   * - 命中唯一键则累加（chat_count / tool_call_count / tokens）
   * - 未命中则插入
   *
   * ⚠️ 该唯一键由 migrations/014_usage_daily_unique_key.sql 建立（D-2 / P0-014 重做）。
   *   **键建立之前，本 UPSERT 并不具备去重能力**：INSERT 不带 id，主键自增
   *   永不冲突，而表上其余索引全是非唯一的 ⇒ ON DUPLICATE KEY UPDATE 分支
   *   永不命中 ⇒ 每次调用都INSERT 新行，t_ai_usage_daily 按请求数而非
   *   「租户×日期×服务商」膨胀，用量报表与超阈值告警静默失真。
   *   014 执行后行为才与上面的描述一致。
   *
   * ⚠️ 为什么是三列而不是四列（含 model）：生产上已存在的唯一键就是三列
   *   （uk_tenant_date_provider），本UPSERT 命中哪一列的唯一键就按哪一列累加
   *   ⇒ 生产实际的累加口径**早已是三列**，不同 model 的用量早已被累加进同一行。
   *   014 的存量合并同样按三列口径，两者一致；四元组键比真实口径更宽，
   *   既拦不住分叉，也与合并口径不一致。
   *   ⚠️ 代价（不可逆）：合并后 model退化为「代表值」，**本表不能再按 model 拆分**。
   *   需要按 model 分析用量时必须查明细表 t_ai_audit_log。
   *
   * ⚠️ provider / model 传哨兵值 'unknown' 而非 NULL：MySQL 唯一索引视每个 NULL
   *   互不相同，传 NULL 的行不会被唯一键去重（会重新膨胀）；且列定义已是
   *   NOT NULL DEFAULT 'unknown'（014 第6 步），传 NULL 会被直接拒绝。
   *   'unknown' 是普通值，可被唯一键正常去重。
   *   ⚠️ 哨兵值三处必须完全一致，缺一处即静默失效（库里一种、约定另一种，
   *   报表与唯一键口径随之分叉）：
   *     1. 库默认值：provider/model 均 NOT NULL DEFAULT 'unknown'（014 第 6 步）
   *     2. 迁移回填值：NULL 与 '' 一律回填 'unknown'（014 第 5 步）
   *     3. 写入侧兜底：此处`?? 'unknown'`
   *
   * 使用 MySQL INSERT ... ON DUPLICATE KEY UPDATE 语法（TypeORM 的 upsert 方法封装）
   */
  private async upsertDailyUsage(params: {
    tenantId: string;
    provider: string | null;
    model: string | null;
    chatCount: number;
    toolCallCount: number;
    promptTokens: number;
    completionTokens: number;
  }): Promise<void> {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const totalTokens = params.promptTokens + params.completionTokens;

    // P1-C 迁移：此前 catch + logger.warn 静默吞掉，用量汇总失真无任何可观测手段
    // （报表与超阈值告警随之失真）。改为 bestEffort：仍不阻断主流程，但失败必落
    // logger.error + 指标 + 死信，运维可据死信补录。
    await bestEffort(
      async () => {
        // 使用原生 SQL UPSERT（TypeORM upsert 在 1.x 版本可能不兼容，用原生 SQL 更可靠）
        await this.dataSource.query(
          `INSERT INTO t_ai_usage_daily
          (tenant_id, stat_date, chat_count, tool_call_count, prompt_tokens, completion_tokens, total_tokens, provider, model, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
          chat_count = chat_count + VALUES(chat_count),
          tool_call_count = tool_call_count + VALUES(tool_call_count),
          prompt_tokens = prompt_tokens + VALUES(prompt_tokens),
          completion_tokens = completion_tokens + VALUES(completion_tokens),
          total_tokens = total_tokens + VALUES(total_tokens),
          updated_at = NOW()`,
          [
            params.tenantId,
            today,
            params.chatCount,
            params.toolCallCount,
            params.promptTokens,
            params.completionTokens,
            totalTokens,
            // P0-014 重做：唯一索引对每个 NULL 视为互不相同 ⇒ 传 NULL 的行不会被去重；
            // 且列定义已是 NOT NULL DEFAULT 'unknown'（014 第 6 步），传 NULL 会被拒绝。
            // 哨兵值 'unknown' 与「库默认值 / 迁移回填值」三处完全一致（见上方注释）。
            params.provider ?? 'unknown',
            params.model ?? 'unknown',
          ],
        );
      },
      {
        op: 'audit.upsertDailyUsage',
        tenantId: params.tenantId,
        detail: `statDate=${today} provider=${params.provider ?? '-'} model=${
          params.model ?? '-'
        } chat=${params.chatCount} tool=${params.toolCallCount} tokens=${totalTokens}`,
      },
    );
  }

  /**
   * 参数脱敏：截断超长参数值，移除可能的敏感字段
   *
   * 遵循踩坑日志 #10：用 unknown 而非 any，避免类型安全隐患。
   */
  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key'];

    for (const [key, value] of Object.entries(args)) {
      if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
        sanitized[key] = '***';
        continue;
      }

      if (typeof value === 'string') {
        // P2 修复（2026-10-04）：字符串参数做内容级 PII 遮蔽（手机号/长号段）
        let masked = value
          .replace(/1[3-9]\d{9}/g, (m) => m.slice(0, 3) + '****' + m.slice(-2))
          .replace(/\d{15,18}/g, (m) => m.slice(0, 4) + '****' + m.slice(-3));
        if (masked.length > 500) {
          masked = masked.slice(0, 500) + '...（截断）';
        }
        sanitized[key] = masked;
      } else if (typeof value === 'object' && value !== null) {
        try {
          const jsonStr = JSON.stringify(value);
          if (jsonStr.length > 500) {
            sanitized[key] = jsonStr.slice(0, 500) + '...（截断）';
          } else {
            sanitized[key] = value;
          }
        } catch {
          sanitized[key] = '[不可序列化]';
        }
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Fire-and-forget：异步执行，不阻塞调用方，捕获所有异常
   *
   * P1-C 迁移：审计主流水（t_ai_audit_log）落库失败此前只 logger.warn，
   * 取证链断点无人可见。改走 bestEffort：失败落 logger.error + 指标 + 死信，
   * 仍是非阻塞（不 await），主流程不受影响。
   *
   * @param fn  审计写入动作
   * @param ctx bestEffort 上下文（op / tenantId / detail）
   */
  private fireAndForget(
    fn: () => Promise<void>,
    ctx: { op: string; tenantId?: string; detail?: string },
  ): void {
    // bestEffort 自身不抛（死信写入失败也只落日志，见 error-semantics），
    // 因此这里无需再挂 .catch；不 await 以保持 fire-and-forget 非阻塞语义。
    void bestEffort(fn, ctx);
  }
}
