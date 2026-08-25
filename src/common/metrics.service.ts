/**
 * MetricsService — Prometheus 指标（A5，文档 16.3）
 *
 * 内存计数，暴露 GET /api/admin/metrics（Prometheus text format）。
 * 指标覆盖：请求总数/耗时、Token 消耗、工具调用、Agent 迭代、
 * ai_db 样本采集量、熔断状态（熔断状态实时读 CircuitBreakerService）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  /** ai_request_total{tenant,provider,status} */
  private requestTotal = new Map<string, number>();
  /** ai_request_duration_seconds：sum + count */
  private durationSumMs = 0;
  private durationCount = 0;
  /** ai_token_consumed_total{type} */
  private tokenConsumed = new Map<string, number>();
  /** ai_tool_call_total{tool,status} */
  private toolCallTotal = new Map<string, number>();
  /** ai_tool_duration_seconds{tool}：sum + count */
  private toolDurationMs = new Map<string, number>();
  private toolDurationCount = new Map<string, number>();
  /** ai_agent_iterations：sum + count */
  private iterationsSum = 0;
  private iterationsCount = 0;
  /** ai_db_sample_total{type} */
  private dbSampleTotal = new Map<string, number>();

  recordRequest(
    tenantId: string,
    provider: string,
    status: 'success' | 'fail',
  ): void {
    const key = `${tenantId}|${provider}|${status}`;
    this.requestTotal.set(key, (this.requestTotal.get(key) ?? 0) + 1);
  }

  recordDuration(latencyMs: number): void {
    this.durationSumMs += latencyMs;
    this.durationCount += 1;
  }

  recordTokens(prompt: number, completion: number): void {
    this.tokenConsumed.set(
      'prompt',
      (this.tokenConsumed.get('prompt') ?? 0) + prompt,
    );
    this.tokenConsumed.set(
      'completion',
      (this.tokenConsumed.get('completion') ?? 0) + completion,
    );
  }

  recordToolCall(tool: string, status: 'success' | 'fail'): void {
    const key = `${tool}|${status}`;
    this.toolCallTotal.set(key, (this.toolCallTotal.get(key) ?? 0) + 1);
  }

  recordToolDuration(tool: string, durationMs: number): void {
    this.toolDurationMs.set(
      tool,
      (this.toolDurationMs.get(tool) ?? 0) + durationMs,
    );
    this.toolDurationCount.set(
      tool,
      (this.toolDurationCount.get(tool) ?? 0) + 1,
    );
  }

  recordAgentIterations(iterations: number): void {
    this.iterationsSum += iterations;
    this.iterationsCount += 1;
  }

  recordDbSample(type: 'experience' | 'correction' | 'sample'): void {
    this.dbSampleTotal.set(type, (this.dbSampleTotal.get(type) ?? 0) + 1);
  }

  /**
   * 渲染 Prometheus text format（文档 16.3 指标子集）
   *
   * @param circuitOpen 熔断状态：toolName → 1/0（由调用方从熔断器读取）
   */
  render(circuitOpen: Record<string, number> = {}): string {
    const lines: string[] = [];

    for (const [key, value] of this.requestTotal) {
      const [tenant, provider, status] = key.split('|');
      lines.push(
        `ai_request_total{tenant_id="${tenant}",provider="${provider}",status="${status}"} ${value}`,
      );
    }
    lines.push(`ai_request_duration_seconds_sum ${this.durationSumMs / 1000}`);
    lines.push(`ai_request_duration_seconds_count ${this.durationCount}`);
    for (const [type, value] of this.tokenConsumed) {
      lines.push(`ai_token_consumed_total{type="${type}"} ${value}`);
    }
    for (const [key, value] of this.toolCallTotal) {
      const [tool, status] = key.split('|');
      lines.push(
        `ai_tool_call_total{tool_name="${tool}",status="${status}"} ${value}`,
      );
    }
    for (const [tool, sum] of this.toolDurationMs) {
      lines.push(
        `ai_tool_duration_seconds_sum{tool_name="${tool}"} ${sum / 1000}`,
      );
      lines.push(
        `ai_tool_duration_seconds_count{tool_name="${tool}"} ${
          this.toolDurationCount.get(tool) ?? 0
        }`,
      );
    }
    for (const [tool, open] of Object.entries(circuitOpen)) {
      lines.push(`ai_tool_circuit_open{tool_name="${tool}"} ${open}`);
    }
    lines.push(`ai_agent_iterations_sum ${this.iterationsSum}`);
    lines.push(`ai_agent_iterations_count ${this.iterationsCount}`);
    for (const [type, value] of this.dbSampleTotal) {
      lines.push(`ai_db_sample_total{type="${type}"} ${value}`);
    }

    return `${lines.join('\n')}\n`;
  }
}
