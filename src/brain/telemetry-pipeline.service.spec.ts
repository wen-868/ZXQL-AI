/**
 * TelemetryPipelineService 契约测试（AI-P2-4-TELEMETRY-PIPELINE-01）
 *
 * 覆盖（卡面三.统一遥测契约 + 四.测试与反测）：
 * - 三通道 begin/end 生命周期与 lane 校验；
 * - sessionId 修正契约（plan/上下文会话优先；反向用例：不再把 tenantId 当会话 ID）；
 * - usage 真实性（unknown 显式标记，不伪装真实 0；graph 正向哨兵同型）；
 * - 计费/usage_daily 单点挂点 + 失败隔离（遥测 sink 故障主任务不受影响）；
 * - chat 既有 triage/fallback 字段不减少；
 * - 真实数据库链路（better-sqlite3 基线表：t_ai_audit_log + t_ai_usage_daily
 *   UPSERT 累计 + 计费失败可观测），非 mock 冒充生产链路。
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unnecessary-type-assertion -- 集成测试批量断言 mock 依赖与真实 DB 行 */
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { AiAuditLogEntity } from '../database/entities/ai-audit-log.entity';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import { AuditLogger } from '../bridge/audit-logger';
import { BillingService } from '../tenant/billing.service';
import { MetricsService } from '../common/metrics.service';
import {
  buildTelemetryEndInput,
  TelemetryPipelineService,
  TelemetrySession,
} from './telemetry-pipeline.service';

function makePipeline(
  over: {
    audit?: { logAiCall: jest.Mock };
    billing?: { consume: jest.Mock };
    metrics?: Record<string, jest.Mock>;
  } = {},
): {
  pipeline: TelemetryPipelineService;
  audit: { logAiCall: jest.Mock };
  billing: { consume: jest.Mock };
  metrics: Record<string, jest.Mock>;
} {
  const audit = over.audit ?? { logAiCall: jest.fn() };
  const billing = over.billing ?? { consume: jest.fn(() => Promise.resolve()) };
  const metrics = over.metrics ?? {
    recordBillingConsume: jest.fn(),
    recordRequest: jest.fn(),
  };
  const pipeline = new TelemetryPipelineService(
    audit as unknown as AuditLogger,
    billing as unknown as BillingService,
    metrics as unknown as MetricsService,
  );
  return { pipeline, audit, billing, metrics };
}

function beginChat(
  pipeline: TelemetryPipelineService,
  over: Record<string, unknown> = {},
): TelemetrySession {
  return pipeline.channelBegin({
    lane: 'chat',
    tenantId: 't1',
    sessionId: 'conv-1',
    userId: 'u1',
    userMessage: '查一下五粮液库存',
    intent: 'chat',
    ...over,
  });
}

describe('TelemetryPipelineService（三通道统一遥测契约）', () => {
  describe('sessionId 修正契约（D4）', () => {
    it('resolveSessionId：preferred 优先（plan 运行上下文会话）', () => {
      const { pipeline } = makePipeline();
      expect(
        pipeline.resolveSessionId('agent', 't1', 'plan-sess-9', 'conv-1'),
      ).toBe('plan-sess-9');
    });

    it('resolveSessionId：preferred 缺失时回退 conversationId', () => {
      const { pipeline } = makePipeline();
      expect(
        pipeline.resolveSessionId('agent', 't1', undefined, 'conv-1'),
      ).toBe('conv-1');
    });

    it('resolveSessionId：双空兜底非空（lane-session-tenant），不会把 tenantId 当会话 ID', () => {
      const { pipeline } = makePipeline();
      const resolved = pipeline.resolveSessionId('agent', 't1', null, null);
      expect(resolved).toBe('agent-session-t1');
      expect(resolved).not.toBe('t1');
    });

    it('反向哨兵（D4 旧行为反测）：传入 sessionId=tenantId 被修正，不再是裸租户 ID', () => {
      const { pipeline } = makePipeline();
      const session = pipeline.channelBegin({
        lane: 'agent',
        tenantId: 't1',
        // 模拟旧实现直接把 tenantId 塞进 sessionId 的调用形态
        sessionId: 't1',
      });
      expect(session.sessionId).not.toBe('t1');
      expect(session.sessionId).toBe('agent-session-t1');
    });
  });

  describe('生命周期与 lane', () => {
    it('channelBegin：非法 lane fail-fast（lane 只允许 chat/agent/graph）', () => {
      const { pipeline } = makePipeline();
      expect(() =>
        pipeline.channelBegin({
          lane: 'mcp' as 'chat',
          tenantId: 't1',
          sessionId: 's1',
        }),
      ).toThrow(/非法遥测 lane/);
    });

    it('channelBegin：sessionId 归一落句柄（lane/tenant/user 全字段）', () => {
      const { pipeline } = makePipeline();
      const session = beginChat(pipeline);
      expect(session.lane).toBe('chat');
      expect(session.tenantId).toBe('t1');
      expect(session.sessionId).toBe('conv-1');
      expect(session.userId).toBe('u1');
      expect(session.startTime).toBeGreaterThan(0);
    });

    it('三通道同一契约：agent/graph begin+end 与 chat 产出同构审计字段', async () => {
      for (const lane of ['chat', 'agent', 'graph'] as const) {
        const { pipeline, audit } = makePipeline();
        const session = pipeline.channelBegin({
          lane,
          tenantId: 't1',
          sessionId: `s-${lane}`,
          userId: 'u1',
        });
        await pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            latencyMs: 100,
            usageSource: 'measured',
          },
          provider: 'deepseek',
          model: 'deepseek-chat',
        });
        expect(audit.logAiCall).toHaveBeenCalledTimes(1);
        const record = audit.logAiCall.mock.calls[0][0] as Record<
          string,
          unknown
        >;
        expect(record.lane).toBe(lane);
        expect(record.tenantId).toBe('t1');
        expect(record.sessionId).toBe(`s-${lane}`);
        expect(record.promptTokens).toBe(10);
        expect(record.completionTokens).toBe(5);
        expect(record.success).toBe(true);
      }
    });
  });

  describe('usage 真实性与计费单点（D12）', () => {
    it('channelEnd：审计带 lane/session/usage/triage/fallback（chat 既有字段不减少）', async () => {
      const { pipeline, audit } = makePipeline();
      const session = beginChat(pipeline);
      await pipeline.channelEnd({
        session,
        success: true,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          latencyMs: 200,
          usageSource: 'measured',
        },
        provider: 'deepseek',
        model: 'deepseek-chat',
        intent: 'chat',
        triageLane: 'rules',
        triageCategories: 'order,inventory',
        fallback: {
          used: false,
          from: 'deepseek',
          to: 'deepseek',
          reason: '',
          attempts: [],
          latencyMs: 0,
        },
        toolCalls: [{ tool_name: 'searchProduct', success: true }],
        categories: ['product'],
      });
      const record = audit.logAiCall.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(record.triageLane).toBe('rules');
      expect(record.triageCategories).toBe('order,inventory');
      expect(record.fallback).toEqual(expect.objectContaining({ used: false }));
      expect(record.toolCalls).toEqual([
        { tool_name: 'searchProduct', success: true },
      ]);
      expect(record.categories).toEqual(['product']);
    });

    it('usageSource=unknown：按 0 记账但审计落 usage_unknown 标记（不伪装真实 0）', async () => {
      const { pipeline, audit } = makePipeline();
      const session = pipeline.channelBegin({
        lane: 'graph',
        tenantId: 't1',
        sessionId: 'g1',
      });
      await pipeline.channelEnd({
        session,
        success: true,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: 50,
          usageSource: 'unknown',
        },
      });
      const record = audit.logAiCall.mock.calls[0][0] as {
        toolCalls: Array<{ event?: string }>;
        promptTokens: number;
      };
      const marker = record.toolCalls?.find(
        (t) => t.event === 'usage_unknown',
      ) as { event?: string; lane?: string } | undefined;
      expect(marker).toBeDefined();
      expect(marker?.lane).toBe('graph');
      expect(record.promptTokens).toBe(0);
    });

    it('usageSource=measured：无 usage_unknown 标记', async () => {
      const { pipeline, audit } = makePipeline();
      const session = beginChat(pipeline);
      await pipeline.channelEnd({
        session,
        success: true,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          latencyMs: 100,
          usageSource: 'measured',
        },
      });
      const record = audit.logAiCall.mock.calls[0][0] as {
        toolCalls?: Array<{ event?: string }>;
      };
      const marker = record.toolCalls?.find((t) => t.event === 'usage_unknown');
      expect(marker).toBeUndefined();
    });

    it('计费单点：channelEnd 恰好调用一次 billing.consume(tenant, totalTokens)', async () => {
      const { pipeline, billing } = makePipeline();
      const session = beginChat(pipeline);
      await pipeline.channelEnd({
        session,
        success: true,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          latencyMs: 100,
          usageSource: 'measured',
        },
      });
      expect(billing.consume).toHaveBeenCalledTimes(1);
      expect(billing.consume).toHaveBeenCalledWith('t1', 15);
    });

    it('F1 正向哨兵：agent 通道 measured 用量 → 恰好一次 BillingService.consume(tenant, totalTokens)', async () => {
      const { pipeline, billing, audit } = makePipeline();
      const session = pipeline.channelBegin({
        lane: 'agent',
        tenantId: 't1',
        sessionId: 'plan-run-sess-7',
        userId: 'u1',
        userMessage: 'agent 计划目标（F1 计费正向哨兵）',
        intent: 'agent_plan',
      });
      await pipeline.channelEnd({
        session,
        success: true,
        usage: {
          promptTokens: 120,
          completionTokens: 60,
          totalTokens: 180,
          latencyMs: 250,
          usageSource: 'measured',
        },
        provider: 'agent',
        model: 'planner+runner',
        intent: 'agent_plan',
      });
      // 计费单点：恰好一次，金额口径 = totalTokens（调用方侧再按 overage_price 折算）
      expect(billing.consume).toHaveBeenCalledTimes(1);
      expect(billing.consume).toHaveBeenCalledWith('t1', 180);
      // 审计侧：lane=agent 且 sessionId 不回退 tenantId（D4 联动确认）
      const record = audit.logAiCall.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(record.lane).toBe('agent');
      expect(record.sessionId).toBe('plan-run-sess-7');
      expect(record.sessionId).not.toBe('t1');
      expect(record.promptTokens).toBe(120);
      expect(record.completionTokens).toBe(60);
    });

    it('billable=false（失败路径保持 chat 原口径）：不计费、审计仍发', async () => {
      const { pipeline, billing, audit } = makePipeline();
      const session = beginChat(pipeline);
      await pipeline.channelEnd({
        session,
        success: false,
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          latencyMs: 0,
          usageSource: 'unknown',
        },
        billable: false,
        error: '对话处理失败',
      });
      expect(billing.consume).not.toHaveBeenCalled();
      expect(audit.logAiCall).toHaveBeenCalledTimes(1);
    });
  });

  describe('失败隔离（遥测 sink 故障不影响主任务）', () => {
    it('审计 sink 抛错：channelEnd 不抛、计费仍执行', async () => {
      const { pipeline, billing } = makePipeline({
        audit: {
          logAiCall: jest.fn(() => {
            throw new Error('audit sink down');
          }),
        },
      });
      const session = beginChat(pipeline);
      await expect(
        pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            latencyMs: 100,
            usageSource: 'measured',
          },
        }),
      ).resolves.toBeUndefined();
      expect(billing.consume).toHaveBeenCalledTimes(1);
    });

    it('计费失败：channelEnd 不抛、审计已发、指标 fail（可据死信补扣）', async () => {
      const { pipeline, audit, metrics } = makePipeline({
        billing: {
          consume: jest.fn(() => Promise.reject(new Error('billing db down'))),
        },
      });
      const session = beginChat(pipeline);
      await expect(
        pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            latencyMs: 100,
            usageSource: 'measured',
          },
        }),
      ).resolves.toBeUndefined();
      expect(audit.logAiCall).toHaveBeenCalledTimes(1);
      expect(metrics.recordBillingConsume).toHaveBeenCalledWith('fail');
    });
  });

  describe('真实数据库链路（better-sqlite3 基线表，等价可核证据）', () => {
    const savedMode = process.env.INTEGRATION_MODE;
    let ds: DataSource;

    beforeAll(async () => {
      process.env.INTEGRATION_MODE = 'standalone';
      ds = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [AiAuditLogEntity, TenantAiBillingEntity],
        synchronize: false,
      });
      await ds.initialize();
      const baseline = fs
        .readFileSync(
          path.resolve(__dirname, '../../migrations-sqlite/000_baseline.sql'),
          'utf8',
        )
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');
      for (const stmt of baseline
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)) {
        await ds.query(stmt);
      }
    });

    afterAll(async () => {
      await ds.destroy();
      if (savedMode === undefined) {
        delete process.env.INTEGRATION_MODE;
      } else {
        process.env.INTEGRATION_MODE = savedMode;
      }
    });

    function makeRealPipeline(): {
      pipeline: TelemetryPipelineService;
      billing: { consume: jest.Mock };
    } {
      const auditLogger = new AuditLogger(
        ds.getRepository(AiAuditLogEntity),
        ds,
        { get: () => undefined } as never,
      );
      // 计费走真实 sqlite 仓储（真实 DB 交互）；GREATEST 方言差异使扣减失败
      // ⇒ 恰好作为「计费失败不阻断主任务且可观测」的真实链路证据
      const billing = new BillingService(
        ds.getRepository(TenantAiBillingEntity),
        new MetricsService(),
      );
      const pipeline = new TelemetryPipelineService(
        auditLogger,
        billing,
        new MetricsService(),
      );
      const consumeSpy = jest.spyOn(billing, 'consume');
      return {
        pipeline,
        billing: { consume: consumeSpy as unknown as jest.Mock },
      };
    }

    it('真实库：三通道 channelEnd 落 t_ai_audit_log（lane/session/usage 全字段）', async () => {
      const { pipeline } = makeRealPipeline();
      for (const lane of ['chat', 'agent', 'graph'] as const) {
        const session = pipeline.channelBegin({
          lane,
          tenantId: 'tenant-real',
          sessionId: `sess-real-${lane}`,
          userId: 'u1',
          userMessage: '真实链路验收消息',
        });
        await pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 20,
            completionTokens: 8,
            totalTokens: 28,
            latencyMs: 120,
            usageSource: lane === 'graph' ? 'unknown' : 'measured',
          },
          provider: 'deepseek',
          model: 'deepseek-chat',
          intent: 'telemetry_it',
        });
      }
      const rows = await ds.query(
        `SELECT lane, session_id, prompt_tokens, completion_tokens, intent, tool_calls
           FROM t_ai_audit_log
          WHERE tenant_id = 'tenant-real' ORDER BY lane`,
      );
      expect(rows).toHaveLength(3);
      const byLane = Object.fromEntries(
        rows.map((r: Record<string, unknown>) => [r.lane as string, r]),
      );
      expect(byLane.chat.session_id).toBe('sess-real-chat');
      expect(byLane.agent.session_id).toBe('sess-real-agent');
      expect(byLane.graph.session_id).toBe('sess-real-graph');
      expect(Number(byLane.chat.prompt_tokens)).toBe(20);
      expect(Number(byLane.chat.completion_tokens)).toBe(8);
      expect(byLane.chat.intent).toBe('telemetry_it');
      // graph unknown 用量在真实审计行中带 usage_unknown 标记（不伪装真实 0）
      const graphToolCalls = JSON.stringify(byLane.graph.tool_calls);
      expect(graphToolCalls).toContain('usage_unknown');
    });

    it('真实库：t_ai_usage_daily 按 (tenant,date,provider) UPSERT 累加（两次调用一行）', async () => {
      const { pipeline } = makeRealPipeline();
      for (let i = 0; i < 2; i++) {
        const session = pipeline.channelBegin({
          lane: 'chat',
          tenantId: 'tenant-usage',
          sessionId: `sess-usage-${i}`,
        });
        await pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            latencyMs: 30,
            usageSource: 'measured',
          },
          provider: 'deepseek',
          model: 'deepseek-chat',
        });
        // fire-and-forget 写入落盘等待
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const rows = await ds.query(
        `SELECT chat_count, prompt_tokens, completion_tokens, total_tokens, provider
           FROM t_ai_usage_daily
          WHERE tenant_id = 'tenant-usage'`,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].chat_count)).toBe(2);
      expect(Number(rows[0].prompt_tokens)).toBe(20);
      expect(Number(rows[0].completion_tokens)).toBe(10);
      expect(Number(rows[0].total_tokens)).toBe(30);
    });

    it('真实库：计费失败不阻断主任务且留下可观测失败记录（metrics + 死信）', async () => {
      const errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const { pipeline, billing } = makeRealPipeline();
      const session = pipeline.channelBegin({
        lane: 'agent',
        tenantId: 'tenant-billing',
        sessionId: 'sess-billing-1',
      });
      // 真实 BillingService（sqlite 仓储）扣减路径失败（方言差异）——
      // channelEnd 必须照常完成（不抛），失败落 error/死信可观测
      await expect(
        pipeline.channelEnd({
          session,
          success: true,
          usage: {
            promptTokens: 5,
            completionTokens: 5,
            totalTokens: 10,
            latencyMs: 40,
            usageSource: 'measured',
          },
        }),
      ).resolves.toBeUndefined();
      expect(billing.consume).toHaveBeenCalledTimes(1);
      const auditRows = await ds.query(
        `SELECT COUNT(1) AS c FROM t_ai_audit_log WHERE tenant_id = 'tenant-billing'`,
      );
      expect(Number(auditRows[0].c)).toBe(1);
      errorSpy.mockRestore();
    });
  });
});

// ════ S3：buildTelemetryEndInput 组装单源（收敛实施卡 S3）════
describe('buildTelemetryEndInput（三通道 telemetry 输入组装单源）', () => {
  const baseSession: TelemetrySession = {
    lane: 'chat',
    tenantId: 't1',
    sessionId: 'sess-s3',
    userId: 'u1',
    startTime: 1000,
  };

  it('chat 成功形态：usage 三元组=入参之和、billable 缺省 true、无 error', () => {
    const input = buildTelemetryEndInput({
      session: baseSession,
      success: true,
      promptTokens: 100,
      completionTokens: 50,
      usageSource: 'measured',
      latencyMs: 200,
    });
    expect(input.usage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 200,
      usageSource: 'measured',
    });
    expect(input.billable).toBe(true);
    expect(input.success).toBe(true);
    expect(input.error).toBeUndefined();
    expect(input.session).toBe(baseSession);
  });

  it('chat 失败形态：billable:false 显式透传、error 透传（口径不漂移）', () => {
    const input = buildTelemetryEndInput({
      session: baseSession,
      success: false,
      promptTokens: 0,
      completionTokens: 0,
      usageSource: 'unknown',
      latencyMs: 0,
      billable: false,
      error: '对话处理失败',
    });
    expect(input.billable).toBe(false);
    expect(input.success).toBe(false);
    expect(input.usage.usageSource).toBe('unknown');
    expect(input.usage.totalTokens).toBe(0);
    expect(input.error).toContain('对话处理失败');
  });

  it('agent 形态：overrides 透传 provider/model/intent（审计字段不缺失）', () => {
    const input = buildTelemetryEndInput(
      {
        session: { ...baseSession, lane: 'agent', sessionId: 'plan-run-9' },
        success: true,
        promptTokens: 120,
        completionTokens: 60,
        usageSource: 'measured',
        latencyMs: 250,
      },
      { provider: 'agent', model: 'planner+runner', intent: 'agent_plan' },
    );
    expect(input.session.lane).toBe('agent');
    expect(input.session.sessionId).toBe('plan-run-9');
    expect(input.provider).toBe('agent');
    expect(input.model).toBe('planner+runner');
    expect(input.intent).toBe('agent_plan');
    expect(input.usage.totalTokens).toBe(180);
  });

  it('graph 形态：unknown 用量显式标注（usage 伪 0 反测锚）', () => {
    const input = buildTelemetryEndInput({
      session: { ...baseSession, lane: 'graph' },
      success: true,
      promptTokens: 0,
      completionTokens: 0,
      usageSource: 'unknown',
      latencyMs: 50,
    });
    expect(input.usage.usageSource).toBe('unknown');
    expect(input.usage.totalTokens).toBe(0);
    expect(input.session.lane).toBe('graph');
  });

  it('lane 原样透传（M6/混淆反测锚：组装层不改写通道）', () => {
    for (const lane of ['chat', 'agent', 'graph'] as const) {
      const input = buildTelemetryEndInput({
        session: { ...baseSession, lane },
        success: true,
        promptTokens: 1,
        completionTokens: 1,
        usageSource: 'measured',
        latencyMs: 1,
      });
      expect(input.session.lane).toBe(lane);
    }
  });
});
