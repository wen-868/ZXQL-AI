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
    metrics.recordAnswerSelfCheck('corrected');
    metrics.recordAnswerSelfCheck('pass');
    metrics.recordPlan();
    metrics.recordToolRetry(true);
    metrics.recordToolRetry(false);
    metrics.recordBillingConsume('ok');
    metrics.recordBillingConsume('ok_balance');
    metrics.recordBillingConsume('skipped');
    metrics.recordBillingConsume('fail');

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
    expect(out).toContain('ai_answer_selfcheck_total{result="corrected"} 1');
    expect(out).toContain('ai_answer_selfcheck_total{result="pass"} 1');
    expect(out).toContain('ai_chat_plan_total 1');
    expect(out).toContain('ai_tool_retry_total{recovered="recovered"} 1');
    expect(out).toContain('ai_tool_retry_total{recovered="failed"} 1');
  });

  // 阶段2 A3 收口：ai_billing_consume_total 此前被记录但从未渲染，
  // 「假 ok」与「真 ok」在监控上无法区分 ⇒ 改造的核心价值失效。
  // 反测信号：删掉 render() 里的本段输出，本用例立即变红。
  it('计费扣减指标被渲染（含 ok_balance），四个 label 均可区分', () => {
    const metrics = new MetricsService();
    metrics.recordBillingConsume('ok');
    metrics.recordBillingConsume('ok');
    metrics.recordBillingConsume('ok_balance');
    metrics.recordBillingConsume('skipped');
    metrics.recordBillingConsume('fail');

    const out = metrics.render();

    expect(out).toContain('ai_billing_consume_total{status="ok"} 2');
    expect(out).toContain('ai_billing_consume_total{status="ok_balance"} 1');
    expect(out).toContain('ai_billing_consume_total{status="skipped"} 1');
    expect(out).toContain('ai_billing_consume_total{status="fail"} 1');
  });

  // 回归信号：若 render() 漏了本指标（阶段2 A3 之前的状态），
  // 「扣免费次数 / 扣余额 / 漏扣」在监控上将完全不可见。
  it('计费指标未记录时不输出该指标行（不产生虚假 0 值）', () => {
    const metrics = new MetricsService();
    const out = metrics.render();
    expect(out).not.toContain('ai_billing_consume_total');
  });

  it('空指标渲染不抛错', () => {
    const metrics = new MetricsService();
    const out = metrics.render();
    // 无条件输出 agent 迭代基线（0 值），其余计数为空
    expect(out).toContain('ai_agent_iterations_sum 0');
    expect(out).not.toContain('ai_request_total');
  });
});
