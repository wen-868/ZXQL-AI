/**
 * UsageStatsService — AI 用量统计服务（完善度 P2-用量计费闭环）
 *
 * 职责：
 * 1. 按租户 + 日期范围查询 t_ai_usage_daily 用量明细
 * 2. 按租户汇总区间内对话/工具调用/Token/费用
 * 3. 跨租户用量概览（管理视角）
 *
 * 数据口径：t_ai_usage_daily 由 AuditLogger 在每次 LLM 调用/工具调用后 UPSERT 落库，
 * 本服务只读查询，不修改数据。
 *
 * 对应文档：
 * - docs/AI底座完善度分析报告.md 五、P2 用量计费闭环
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

/** 用量明细行 */
export interface UsageDailyRow {
  tenantId: string;
  statDate: string;
  chatCount: number;
  toolCallCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  provider: string | null;
  model: string | null;
}

/** 租户区间汇总 */
export interface UsageTotals {
  tenantId: string;
  days: number;
  chatCount: number;
  toolCallCount: number;
  totalTokens: number;
  totalCost: number;
}

/** 数据行（DataSource.query 返回结构） */
type Row = Record<string, unknown>;

@Injectable()
export class UsageStatsService {
  private readonly logger = new Logger(UsageStatsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * 查询租户用量明细（按统计日期倒序）
   *
   * @param tenantId 租户 ID
   * @param startDate 起始日期 YYYY-MM-DD（可选）
   * @param endDate   结束日期 YYYY-MM-DD（可选）
   */
  async getDailyUsage(
    tenantId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<UsageDailyRow[]> {
    this.logger.debug(
      `查询用量明细：tenant=${tenantId} range=${startDate ?? '*'}-${endDate ?? '*'}`,
    );
    const { where, params } = this.buildWhere(tenantId, startDate, endDate);
    const rows = await this.dataSource.query<Row[]>(
      `SELECT tenant_id, stat_date, chat_count, tool_call_count,
              prompt_tokens, completion_tokens, total_tokens, total_cost,
              provider, model
       FROM t_ai_usage_daily
       ${where}
       ORDER BY stat_date DESC`,
      params,
    );
    return (rows ?? []).map((r) => ({
      tenantId: UsageStatsService.toStr(r.tenant_id) ?? tenantId,
      statDate: UsageStatsService.toStr(r.stat_date) ?? '',
      chatCount: UsageStatsService.toNum(r.chat_count),
      toolCallCount: UsageStatsService.toNum(r.tool_call_count),
      promptTokens: UsageStatsService.toNum(r.prompt_tokens),
      completionTokens: UsageStatsService.toNum(r.completion_tokens),
      totalTokens: UsageStatsService.toNum(r.total_tokens),
      totalCost: UsageStatsService.toNum(r.total_cost),
      provider: UsageStatsService.toStr(r.provider) ?? null,
      model: UsageStatsService.toStr(r.model) ?? null,
    }));
  }

  /**
   * 查询租户区间用量汇总（SUM 聚合）
   */
  async getTenantTotals(
    tenantId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<UsageTotals> {
    const { where, params } = this.buildWhere(tenantId, startDate, endDate);
    const rows = await this.dataSource.query<Row[]>(
      `SELECT COUNT(*) AS days,
              COALESCE(SUM(chat_count), 0) AS chat_count,
              COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(total_cost), 0) AS total_cost
       FROM t_ai_usage_daily
       ${where}`,
      params,
    );
    const row = rows?.[0] ?? {};
    return {
      tenantId,
      days: UsageStatsService.toNum(row.days),
      chatCount: UsageStatsService.toNum(row.chat_count),
      toolCallCount: UsageStatsService.toNum(row.tool_call_count),
      totalTokens: UsageStatsService.toNum(row.total_tokens),
      totalCost: UsageStatsService.toNum(row.total_cost),
    };
  }

  /**
   * 跨租户用量概览（管理视角，按总费用倒序）
   */
  async listTenantUsage(
    startDate?: string,
    endDate?: string,
  ): Promise<UsageTotals[]> {
    this.logger.debug(
      `查询跨租户用量概览：range=${startDate ?? '*'}-${endDate ?? '*'}`,
    );
    const where: string[] = [];
    const params: string[] = [];
    if (startDate) {
      where.push('stat_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      where.push('stat_date <= ?');
      params.push(endDate);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await this.dataSource.query<Row[]>(
      `SELECT tenant_id,
              COUNT(*) AS days,
              COALESCE(SUM(chat_count), 0) AS chat_count,
              COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(total_cost), 0) AS total_cost
       FROM t_ai_usage_daily
       ${whereClause}
       GROUP BY tenant_id
       ORDER BY total_cost DESC`,
      params,
    );
    return (rows ?? []).map((r) => ({
      tenantId: UsageStatsService.toStr(r.tenant_id) ?? '',
      days: UsageStatsService.toNum(r.days),
      chatCount: UsageStatsService.toNum(r.chat_count),
      toolCallCount: UsageStatsService.toNum(r.tool_call_count),
      totalTokens: UsageStatsService.toNum(r.total_tokens),
      totalCost: UsageStatsService.toNum(r.total_cost),
    }));
  }

  /** 构建租户 + 日期范围 WHERE 子句与参数 */
  private buildWhere(
    tenantId: string,
    startDate?: string,
    endDate?: string,
  ): { where: string; params: string[] } {
    const conditions = ['tenant_id = ?'];
    const params = [tenantId];
    if (startDate) {
      conditions.push('stat_date >= ?');
      params.push(startDate);
    }
    if (endDate) {
      conditions.push('stat_date <= ?');
      params.push(endDate);
    }
    return { where: `WHERE ${conditions.join(' AND ')}`, params };
  }

  private static toStr(value: unknown): string | undefined {
    return typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : undefined;
  }

  private static toNum(value: unknown): number {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
  }
}
