/**
 * A5 MetricsService 单元测试
 *
 * 覆盖：请求/耗时/Token/工具调用/迭代/样本计数与 Prometheus 渲染。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { MetricsService } from './metrics.service';

describe('A5 MetricsService', () => {
  it('记录并渲染 Prometheus text format', () => {
    const metrics = new MetricsService();
    metrics.recordRequest('t_001', 'glm', 'success');
    metrics.recordRequest('t_001', 'glm', 'fail');
    metrics.recordDuration(1500);
    metrics.recordTokens(100, 50);
    metrics.recordToolCall('queryInventory', 'success');
    metrics.recordToolCall('createSalesOrder', 'fail');
    metrics.recordToolDuration('queryInventory', 200);
    metrics.recordAgentIterations(3);
    metrics.recordDbSample('experience');
    metrics.recordDbSample('correction');

    const out = metrics.render({ queryInventory: 1 });
    expect(out).toContain(
      'ai_request_total{tenant_id="t_001",provider="glm",status="success"} 1',
    );
    expect(out).toContain('ai_request_duration_seconds_sum 1.5');
    expect(out).toContain('ai_token_consumed_total{type="prompt"} 100');
    expect(out).toContain(
      'ai_tool_call_total{tool_name="createSalesOrder",status="fail"} 1',
    );
    expect(out).toContain('ai_tool_circuit_open{tool_name="queryInventory"} 1');
    expect(out).toContain('ai_agent_iterations_sum 3');
    expect(out).toContain('ai_db_sample_total{type="correction"} 1');
  });

  it('空指标渲染不抛错', () => {
    const metrics = new MetricsService();
    const out = metrics.render();
    // 无条件输出 agent 迭代基线（0 值），其余计数为空
    expect(out).toContain('ai_agent_iterations_sum 0');
    expect(out).not.toContain('ai_request_total');
  });
});
