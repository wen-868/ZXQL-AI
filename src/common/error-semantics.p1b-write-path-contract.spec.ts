/**
 * P1-B 写路径吞异常点迁移 —— 三级错误语义契约测试（阶段1-批次 P1-B）
 *
 * 目的：给「可观测性」上测试保护。
 *
 * 背景：本批次把 4 个文件域内的 catch 迁移到 degrade / bestEffort。这些迁移
 * 全部是「行为不变+ 增加可观测」——原有 37 个业务用例在迁移后依然全绿。因此
 * 「劣化后测试仍全绿」是正确结果，但这也意味着：若有人把迁移回退成
 * try/catch + logger.warn，全量测试毫无察觉。故每条用例除断言业务行为不变外，
 * 必须额外断言语义指标生效（errorSemanticsCount(...) === 1）——只有第二条
 * 断言才证明迁移真的接上了。
 *
 * 覆盖的迁移点：
 * 1. billing.consume        —— bestEffort（漏计费：账目不平，不阻断主流程）
 * 2. bridge.healthCheck     —— degrade  （只读探针，如实报 unreachable）
 * 3. weekly_plan.cron       —— degrade  （定时触发器，无调用方）
 * 4. weekly_plan.llm        —— degrade  （旁路增强，降级为真实信号清单）
 * 5. weekly_plan.push       —— bestEffort（审计留痕缺失= 审计断链）
 * 6. agent.step             —— bestEffort（单步容错，失败须可追）
 * 7. agent.experience_capture —— bestEffort（进化飞轮样本源，断链）
 *
 * usage.controller 无catch 点（grep 确认零命中），故不在本文件覆盖；详见
 * 执行报告「未迁移项说明」。
 *
 * 反测约定：把任一处 `errorSemanticsCount(..., 'fail')` 的期望从 1 改成 0
 * 必须变红；把任一处从 1 改成 2 也必须变红。两者都变红才说明断言有信号。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-07
 */

import { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { Repository } from 'typeorm';
import { BillingService } from '../tenant/billing.service';
import type { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';
import type { MetricsService } from '../common/metrics.service';
import { ServiceClient } from '../bridge/service-client';
import { WeeklyPlanService } from '../brain/proactive/weekly-plan.service';
import type { AiConfigService } from '../tenant/ai-config.service';
import type { ProviderRouterService } from '../brain/router/provider-router.service';
import type { ProactivePushService } from '../brain/proactive/proactive-push.service';
import { TaskRunnerService } from '../brain/agent/task-runner.service';
import type { PlanStep } from '../brain/agent/agent.types';
import {
  DeadLetterRecord,
  errorSemanticsCount,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
} from './error-semantics';

describe('P1-B 写路径迁移契约（业务模块确实走三级语义）', () => {
  let deadLetters: DeadLetterRecord[];
  const sink = (r: DeadLetterRecord): void => {
    deadLetters.push(r);
  };

  beforeEach(() => {
    // 计数器是模块级单例，每条用例前清零（jest 各 spec 文件模块隔离，不跨文件污染）
    resetErrorSemanticsMetrics();
    deadLetters = [];
    setDefaultDeadLetterSink(sink);
  });

  afterEach(() => {
    setDefaultDeadLetterSink(null);
  });

  // ──────────────────────────────────────────────────────────
  // 1. billing.consume → bestEffort
  // ──────────────────────────────────────────────────────────
  describe('billing.consume（BillingService 漏计费）', () => {
    function createBilling(
      billing: Partial<TenantAiBillingEntity>,
      opts: { queryError?: Error } = {},
    ): {
      service: BillingService;
      query: jest.Mock;
      metrics: { recordBillingConsume: jest.Mock };
    } {
      const query = opts.queryError
        ? jest.fn().mockRejectedValue(opts.queryError)
        : // mysql2 OK 包形态：repo.query() 返回 raw（OkPacket），计数字段是
          // affectedRows，不是 TypeORM UpdateResult 的 affected。
          // 阶段2 A3 起判据读affectedRows，故mock 必须是真实字段名。
          jest.fn().mockResolvedValue({ affectedRows: 1 });
      const repo = {
        findOne: jest.fn().mockResolvedValue(billing),
        create: jest.fn((d: Record<string, unknown>) => d),
        save: jest.fn((d: Record<string, unknown>) =>
          Promise.resolve({ id: 1, ...d }),
        ),
        query,
      } as unknown as Repository<TenantAiBillingEntity>;
      const metrics = { recordBillingConsume: jest.fn() };
      return {
        service: new BillingService(repo, metrics as unknown as MetricsService),
        query,
        metrics,
      };
    }

    it('扣减失败：不抛（主流程不阻断）+ 落死信 + best_effort 指标为 1', async () => {
      const { service, metrics } = createBilling(
        {
          tenantId: 't_001',
          enabled: 1,
          freeChatCount: 0,
          balance: 10,
          overagePrice: 0.001,
          planType: 'prepaid',
        },
        // 原子 UPDATE 失败（DB 不可达）
        { queryError: new Error('DB down') },
      );

      // 行为契约：迁移前后一致——consume 永不抛，调用方对话流程不受影响
      await expect(service.consume('t_001', 1000)).resolves.toBeUndefined();
      // 阶段0 B-3 既有业务指标仍在（未因迁移丢失）
      expect(metrics.recordBillingConsume).toHaveBeenCalledWith('fail');
      // 可观测性契约：这才是本次迁移带来的东西
      expect(
        errorSemanticsCount('best_effort', 'billing.consume', 'fail'),
      ).toBe(1);
      // 死信落账：运维可据死信补扣（这是 bestEffort 与degrade 的分水岭）
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0].op).toBe('billing.consume');
      expect(deadLetters[0].tenantId).toBe('t_001');
      expect(deadLetters[0].error).toContain('DB down');
    });

    it('扣减成功：走 ok 指标且不产生死信（反向信号：ok 与 fail 必须区分）', async () => {
      const { service, metrics } = createBilling({
        tenantId: 't_001',
        enabled: 1,
        freeChatCount: 5,
        balance: 0,
        planType: 'prepaid',
      });

      await service.consume('t_001', 1000);

      expect(metrics.recordBillingConsume).toHaveBeenCalledWith('ok');
      expect(errorSemanticsCount('best_effort', 'billing.consume', 'ok')).toBe(
        1,
      );
      // 反测信号：若迁移写错成恒定 fail，fail 计数会变成 1 而非 0
      expect(
        errorSemanticsCount('best_effort', 'billing.consume', 'fail'),
      ).toBe(0);
      expect(deadLetters).toHaveLength(0);
    });
  });

  // ──────────────────────────────────────────────────────────
  // 2. bridge.healthCheck → degrade
  // ──────────────────────────────────────────────────────────
  describe('bridge.healthCheck（ServiceClient 可达性探针）', () => {
    function createClient(behavior: () => Promise<unknown>): {
      client: ServiceClient;
      get: jest.Mock;
    } {
      const get = jest.fn(behavior);
      const client = new ServiceClient({
        get: (key: string, dflt?: unknown) =>
          key === 'BACKEND_BASE_URL' ? 'http://backend' : dflt,
      } as unknown as ConfigService);
      const slot = client as unknown as Record<string, unknown>;
      slot.httpClient = { get, request: jest.fn() };
      slot.baseUrl = 'http://backend';
      slot.timeout = 1000;
      return { client, get };
    }

    it('后端不可达：返回 reachable:false（行为不变）+ degrade 观测到 fail', async () => {
      const { client, get } = createClient(() =>
        Promise.reject(new Error('ECONNREFUSED 127.0.0.1:8080')),
      );

      const result = await client.healthCheck();

      // 行为契约：迁移前后一致——探针如实报告不可达，且回传真实错误串
      expect(result.reachable).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(typeof result.latencyMs).toBe('number');
      expect(get).toHaveBeenCalledTimes(1);
      // 可观测性契约
      expect(errorSemanticsCount('degrade', 'bridge.healthCheck', 'fail')).toBe(
        1,
      );
      // 反测信号：degrade 不写死信（与 bestEffort 分界），若错写死信则此断言变红
      expect(deadLetters).toHaveLength(0);
    });

    it('后端可达：返回 reachable:true（不含 error）+ degrade 观测到 ok', async () => {
      const { client } = createClient(() => Promise.resolve({ status: 200 }));

      const result = await client.healthCheck();

      expect(result.reachable).toBe(true);
      expect(result.error).toBeUndefined();
      expect(errorSemanticsCount('degrade', 'bridge.healthCheck', 'ok')).toBe(
        1,
      );
      expect(errorSemanticsCount('degrade', 'bridge.healthCheck', 'fail')).toBe(
        0,
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // 3/4/5. weekly_plan.* → degrade + bestEffort
  // ──────────────────────────────────────────────────────────
  describe('weekly_plan（WeeklyPlanService cron/LLM/推送）', () => {
    function createWeekly(opts: {
      llmError?: boolean;
      pushError?: boolean;
      cronEnabled?: boolean;
      dataSourceError?: boolean;
      rows?: Array<{ title: string; content: string; created_at: string }>;
    }): {
      service: WeeklyPlanService;
      push: { push: jest.Mock };
      chatSync: jest.Mock;
    } {
      const query = opts.dataSourceError
        ? jest.fn().mockRejectedValue(new Error('t_push_log 无 tenant_id 列'))
        : jest.fn().mockResolvedValue(opts.rows ?? []);
      const dataSource = { query } as unknown as DataSource;
      const chatSync = jest.fn(
        opts.llmError
          ? () => {
              throw new Error('llm down');
            }
          : () =>
              Promise.resolve({
                content: '1. 五粮液补货 —— 库存预警 → 立即盘点下单',
                prompt_tokens: 10,
                completion_tokens: 20,
              }),
      );
      const router = {
        route: jest.fn().mockReturnValue({
          providerName: 'glm',
          provider: { chatSync },
          reason: 'mock',
        }),
      } as unknown as ProviderRouterService;
      const aiConfigService = {
        getResolvedConfig: jest.fn().mockResolvedValue({ provider: 'glm' }),
      } as unknown as AiConfigService;
      const push = {
        push: opts.pushError
          ? jest.fn().mockRejectedValue(new Error('t_push_log 写入失败'))
          : jest.fn().mockResolvedValue(true),
      } as unknown as { push: jest.Mock } & ProactivePushService;
      const config = {
        get: jest.fn((key: string) =>
          key === 'WEEKLY_PLAN_CRON_ENABLED' && opts.cronEnabled
            ? 'true'
            : 'false',
        ),
      } as unknown as ConfigService;

      const service = new WeeklyPlanService(
        dataSource,
        aiConfigService,
        router,
        push,
        config,
      );
      return { service, push, chatSync };
    }

    const ROWS = [
      {
        title: '应收提醒',
        content: 'x',
        created_at: '2026-09-03 09:00:00',
      },
    ];

    it('LLM 失败：降级为真实信号清单（行为不变）+ degrade 观测到 fail', async () => {
      const { service } = createWeekly({ llmError: true, rows: ROWS });

      const result = await service.buildWeeklyPlan('t_001');

      // 行为契约：与迁移前逐字一致
      expect(result.signals).toBe(1);
      expect(result.plan).toContain('1 条主动提醒');
      // 可观测性契约
      expect(errorSemanticsCount('degrade', 'weekly_plan.llm', 'fail')).toBe(1);
      // 反测信号：degrade 不落死信
      expect(deadLetters).toHaveLength(0);
    });

    it('LLM 成功：走 ok 指标且不产生死信', async () => {
      const { service, push } = createWeekly({ rows: ROWS });

      const result = await service.buildWeeklyPlan('t_001');

      expect(result.plan).toContain('五粮液补货');
      expect(errorSemanticsCount('degrade', 'weekly_plan.llm', 'ok')).toBe(1);
      // 推送成功路径也走 bestEffort ok
      expect(errorSemanticsCount('best_effort', 'weekly_plan.push', 'ok')).toBe(
        1,
      );
      expect(deadLetters).toHaveLength(0);
      expect(push.push).toHaveBeenCalledTimes(1);
    });

    it('推送失败：不抛且仍返回已生成的计划（行为不变）+ 落死信 + best_effort fail', async () => {
      const { service } = createWeekly({ pushError: true, rows: ROWS });

      // 行为契约：迁移前后一致——推送失败不阻塞返回，计划正文照常送达
      const result = await service.buildWeeklyPlan('t_001');
      expect(result.plan).toContain('五粮液补货');
      // 可观测性契约：审计留痕缺失必落死信
      expect(
        errorSemanticsCount('best_effort', 'weekly_plan.push', 'fail'),
      ).toBe(1);
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0].op).toBe('weekly_plan.push');
      expect(deadLetters[0].error).toContain('t_push_log 写入失败');
      // LLM 成功不应被推送失败牵连计数
      expect(errorSemanticsCount('degrade', 'weekly_plan.llm', 'ok')).toBe(1);
    });

    it('cron 触发失败（信号查询报错）：不抛（cron 不中断）+ degrade 观测到 fail', async () => {
      const { service } = createWeekly({
        cronEnabled: true,
        dataSourceError: true,
      });

      // 行为契约：迁移前后一致——cron 捕获失败后正常结束
      await expect(service.handleWeeklyCron()).resolves.toBeUndefined();
      // 可观测性契约
      expect(errorSemanticsCount('degrade', 'weekly_plan.cron', 'fail')).toBe(
        1,
      );
    });

    it('cron 正常执行：走 ok 指标（反向信号：fail 必须为 0）', async () => {
      const { service, push } = createWeekly({ cronEnabled: true, rows: ROWS });

      await service.handleWeeklyCron();

      expect(errorSemanticsCount('degrade', 'weekly_plan.cron', 'ok')).toBe(1);
      expect(errorSemanticsCount('degrade', 'weekly_plan.cron', 'fail')).toBe(
        0,
      );
      expect(push.push).toHaveBeenCalledWith(
        'default',
        'weekly-plan',
        expect.objectContaining({ title: '本周经营计划（AI 规划）' }),
      );
    });
  });

  // ──────────────────────────────────────────────────────────
  // 6/7. agent.step / agent.experience_capture → bestEffort
  // ──────────────────────────────────────────────────────────
  describe('agent.step + agent.experience_capture（TaskRunnerService）', () => {
    function makeRepo() {
      const store = new Map<number, Record<string, unknown>>();
      let nextId = 1;
      return {
        store,
        save: jest.fn((entity: Record<string, unknown>) => {
          const id = (entity.id as number | undefined) ?? nextId++;
          const saved = { ...entity, id };
          store.set(id, saved);
          return saved;
        }),
        findOne: jest.fn(
          ({ where }: { where: { id: number; tenantId: string } }) =>
            ([...store.values()].find(
              (e) => e.id === where.id && e.tenantId === where.tenantId,
            ) as never) ?? null,
        ),
        find: jest.fn(({ where }: { where: { tenantId: string } }) =>
          [...store.values()].filter((e) => e.tenantId === where.tenantId),
        ),
        // 阶段 3-A：savePlan 改为条件 UPDATE（WHERE 带 tenantId + state），
        // 桩必须与真实 SQL 语义一致（口径对齐 task-runner.service.spec.ts）：
        // criteria 带 state 且库内不符 ⇒ 命中 0 行（affected:0），由调用方判冲突。
        // 不能图省事恒返回 {affected:1}，否则「并发覆盖」在测试里永远不红。
        update: jest.fn(
          (
            criteria: { id: number; tenantId: string; state?: string },
            patch: Record<string, unknown>,
          ): { affected: number } => {
            const e = store.get(criteria.id);
            if (!e || e.tenantId !== criteria.tenantId) {
              return { affected: 0 };
            }
            if (criteria.state !== undefined && e.state !== criteria.state) {
              return { affected: 0 };
            }
            store.set(criteria.id, { ...e, ...patch });
            return { affected: 1 };
          },
        ),
        create: jest.fn((e: Record<string, unknown>) => e),
      };
    }

    function makeStep(o: Partial<PlanStep> = {}): PlanStep {
      return {
        id: 's1',
        label: '查询库存',
        type: 'tool',
        tool: 'queryInventory',
        args: { sku: 'WLJ' },
        status: 'pending',
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
        ...o,
      };
    }

    /** capture 抛错的TaskRunner（用于经验回流失败路径） */
    function makeRunner(
      overrides: { capture?: { captureTask: jest.Mock } } = {},
    ): {
      runner: TaskRunnerService;
      capture: { captureTask: jest.Mock };
    } {
      const repo = makeRepo();
      const executor = {
        executeToolCall: jest.fn().mockResolvedValue({
          success: true,
          data: { items: [] },
        }),
      };
      const registry = {
        get: jest.fn().mockReturnValue({
          risk: 'medium',
          needsReview: false,
          isWriteOperation: false,
        }),
        toToolDefinitionsForCategories: jest.fn().mockReturnValue([]),
      };
      const confirmation = {
        create: jest.fn().mockResolvedValue({ confirmationId: 'wg_tok' }),
      };
      const selfHeal = {
        heal: jest.fn().mockResolvedValue({
          ok: true,
          result: { success: true, data: { ok: 1 } },
          healLog: [],
          gaveUp: false,
        }),
      };
      const planner = {
        fillStepArgs: jest.fn().mockResolvedValue({ sku: 'WLJ' }),
      };
      const capture = {
        captureTask: jest.fn().mockResolvedValue(undefined),
        ...overrides.capture,
      };
      const metrics = {
        recordRequest: jest.fn(),
        recordDuration: jest.fn(),
        recordTokens: jest.fn(),
        recordAgentIterations: jest.fn(),
      };
      const auditLogger = { logAiCall: jest.fn() };
      const router = {
        chatWithFallback: jest.fn(),
        getSystemScope: jest.fn(() => 'mgmt'),
      };
      const knowledgeRules = { getRulesContext: jest.fn(() => undefined) };
      const aiConfigService = {
        getResolvedConfig: jest.fn().mockResolvedValue({
          provider: 'glm',
          providerConfig: {},
          model: 'glm-4-flash',
          temperature: 0.3,
          maxTokens: 2048,
          systemPrompt: null,
          source: 'platform',
        }),
      };

      const runner = new TaskRunnerService(
        repo as never,
        executor as never,
        registry as never,
        confirmation as never,
        selfHeal as never,
        planner as never,
        capture as never,
        metrics as never,
        auditLogger as never,
        router as never,
        aiConfigService as never,
        knowledgeRules as never,
      );
      return { runner, capture };
    }

    async function collect(
      gen: AsyncGenerator<unknown>,
    ): Promise<Array<Record<string, unknown>>> {
      const events: Array<Record<string, unknown>> = [];
      for await (const e of gen) events.push(e as Record<string, unknown>);
      return events;
    }

    it('步骤执行抛错：单步容错不中断（行为不变）+ 落死信 + best_effort fail', async () => {
      const { runner } = makeRunner();
      const plan = await runner.createPlan({
        tenantId: 't1',
        goal: '查五粮液库存',
        steps: [
          makeStep(),
          makeStep({
            id: 'end',
            type: 'end',
            tool: undefined,
            label: '完成',
          }),
        ],
        createdBy: 'u1',
      });

      // 让 executor 抛错（模拟步骤执行真相失败）
      const slot = runner as unknown as {
        executor: { executeToolCall: jest.Mock };
      };
      slot.executor.executeToolCall.mockRejectedValue(
        new Error('工具执行炸了'),
      );

      const events = await collect(
        runner.run(plan.id, plan.tenantId, { tenantId: 't1' }),
      );

      // 行为契约：迁移前后一致——单步容错，计划不中断，失败步如实记 failed
      const stepEvents = events.filter((e) => e.type === 'agent_step');
      expect(
        stepEvents.some(
          (e) => e.status === 'failed' && e.detail === '工具执行炸了',
        ),
      ).toBe(true);
      // 可观测性契约：失败真相必落死信（这是 bestEffort 的核心价值）
      expect(errorSemanticsCount('best_effort', 'agent.step', 'fail')).toBe(1);
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0].op).toBe('agent.step');
      expect(deadLetters[0].tenantId).toBe('t1');
      expect(deadLetters[0].error).toContain('工具执行炸了');
    });

    it('经验回流抛错：计划收尾不中断（行为不变）+ 落死信 + best_effort fail', async () => {
      // 迁移前此处是 `void captureTask()` + try/catch：async 拒绝根本不会被
      // 那个 catch 捕获（Promise 被丢弃在虚空），失败完全无痕。
      const { runner } = makeRunner({
        capture: {
          captureTask: jest.fn().mockRejectedValue(new Error('ai_db 不可用')),
        },
      });
      const plan = await runner.createPlan({
        tenantId: 't1',
        goal: '查库存',
        steps: [
          makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
        ],
        createdBy: 'u1',
      });

      const events = await collect(
        runner.run(plan.id, plan.tenantId, { tenantId: 't1' }),
      );

      // 行为契约：经验回流失败不影响 done 事件（迁移前后一致）
      expect(events.some((e) => e.type === 'done')).toBe(true);
      // 可观测性契约：进化飞轮断链必须被记录（迁移前是零信号）
      expect(
        errorSemanticsCount('best_effort', 'agent.experience_capture', 'fail'),
      ).toBe(1);
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0].op).toBe('agent.experience_capture');
      expect(deadLetters[0].error).toContain('ai_db 不可用');
    });

    it('计划全成功：经验回流走 ok 且无死信（反向信号：fail 必须为 0）', async () => {
      const { runner, capture } = makeRunner();
      const plan = await runner.createPlan({
        tenantId: 't1',
        goal: '查库存',
        steps: [
          makeStep({ id: 'end', type: 'end', tool: undefined, label: '完成' }),
        ],
        createdBy: 'u1',
      });

      await collect(runner.run(plan.id, plan.tenantId, { tenantId: 't1' }));

      expect(capture.captureTask).toHaveBeenCalledTimes(1);
      expect(
        errorSemanticsCount('best_effort', 'agent.experience_capture', 'ok'),
      ).toBe(1);
      expect(
        errorSemanticsCount('best_effort', 'agent.experience_capture', 'fail'),
      ).toBe(0);
      expect(deadLetters).toHaveLength(0);
      // 无步骤失败 → agent.step 不应有计数
      expect(errorSemanticsCount('best_effort', 'agent.step', 'fail')).toBe(0);
    });
  });
});
