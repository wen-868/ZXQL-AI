/**
 * AuditLogger 单元测试
 *
 * 覆盖（2026-09-26 苏然）：
 * 1. 取证埋点 lane / categories 落库（方案 12.4）
 * 2. categories 空数组归一为 null（避免污染「跨域占比」统计口径）
 * 3. 未传 lane/categories 时落 null（历史调用方不受影响）
 * 4. 工具执行车道固定为 tool，业务域取工具自身 category
 * 5. Provider 降级元数据并入 tool_calls（event=provider_fallback）
 * 6. AUDIT_MASK_MESSAGE=true 时对手机号与长数字做 PII 掩码
 * 7. best-effort：落库抛错不向调用方传播
 *
 * 负责人: 苏然 | 创建日期: 2026-09-26
 */
import { AuditLogger } from './audit-logger';
import { AiAuditLogEntity } from '../database/entities/ai-audit-log.entity';
import type { ModelPrice } from '../tenant/ai-config.service';
import { ToolExecutionRecord } from '../tools/tool.interface';
import {
  errorSemanticsCount,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
  type DeadLetterRecord,
} from '../common/error-semantics';

interface Harness {
  logger: AuditLogger;
  /** 已 save 的审计实体 */
  saved: AiAuditLogEntity[];
  /** upsertDailyUsage 传给 dataSource.query 的参数列表 */
  usageParams: unknown[][];
  /** upsertDailyUsage 的 SQL 原文（R101-AI-03 断言三列是否写入/累加） */
  usageSql: string[];
  /** 单价桩返回值（null = 未配置） */
  price: ModelPrice | null;
  /** 单价查询抛错（模拟库故障） */
  failPrice: boolean;
  /** getModelPrice 收到的 (provider, model) */
  priceLookups: Array<[string, string]>;
  /** 让 save 抛错（用于 best-effort 验证） */
  failSave: boolean;
}

function createHarness(): Harness {
  const saved: AiAuditLogEntity[] = [];
  const usageParams: unknown[][] = [];
  const usageSql: string[] = [];
  const priceLookups: Array<[string, string]> = [];
  const harness: Harness = {
    logger: undefined as unknown as AuditLogger,
    saved,
    usageParams,
    usageSql,
    price: null,
    failPrice: false,
    priceLookups,
    failSave: false,
  };

  const auditLogRepo = {
    create: (data: Partial<AiAuditLogEntity>) => data as AiAuditLogEntity,
    save: (entity: AiAuditLogEntity) => {
      if (harness.failSave) {
        return Promise.reject(new Error('ai_db down'));
      }
      saved.push(entity);
      return Promise.resolve(entity);
    },
  };
  const dataSource = {
    query: (sql: string, params: unknown[]) => {
      usageSql.push(sql);
      usageParams.push(params);
      return Promise.resolve([]);
    },
  };
  const aiConfigService = {
    getModelPrice: (provider: string, model: string) => {
      priceLookups.push([provider, model]);
      if (harness.failPrice) {
        return Promise.reject(new Error('price table down'));
      }
      return Promise.resolve(harness.price);
    },
  };

  harness.logger = new AuditLogger(
    auditLogRepo as never,
    dataSource as never,
    aiConfigService as never,
  );
  return harness;
}

/** fire-and-forget 走微任务链，用宏任务确保落库已完成 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function makeToolRecord(
  over: Partial<ToolExecutionRecord> = {},
): ToolExecutionRecord {
  return {
    toolName: 'checkInventory',
    category: 'inventory',
    isWriteOperation: false,
    success: true,
    durationMs: 12,
    args: { productName: '五粮液' },
    context: { tenantId: 't1', userId: 'u1', sessionId: 's1' },
    ...over,
  };
}

describe('AuditLogger', () => {
  it('logAiCall：lane 与 categories 一并落库（取证埋点）', async () => {
    const { logger, saved } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      userId: 'u1',
      lane: 'chat',
      categories: ['inventory', 'order'],
      promptTokens: 10,
      completionTokens: 20,
      success: true,
    });
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].lane).toBe('chat');
    expect(saved[0].categories).toEqual(['inventory', 'order']);
  });

  it('logAiCall：categories 为空数组 → 归一为 null（不污染跨域统计）', async () => {
    const { logger, saved } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      lane: 'chat',
      categories: [],
      promptTokens: 0,
      completionTokens: 0,
      success: true,
    });
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].categories).toBeNull();
  });

  // P0-014 重做闭环守卫：唯一索引视每个 NULL 互不相同，用量行若带 NULL 的
  // provider/model 不会被唯一键去重，表会重新按请求数膨胀；且 014 第 6 步已把两列
  // 改为 NOT NULL DEFAULT 'unknown'，传 NULL 会被数据库直接拒绝。
  // 写入侧必须落哨兵值 'unknown' —— 这条断言防的是「改回传 null」与「改回落空串」
  // 两类回归：哨兵必须与库默认值、迁移回填值三处完全一致。
  it('upsertDailyUsage：provider/model 为 null 时落哨兵值 unknown（唯一键可去重且列非空）', async () => {
    const { logger, usageParams } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      lane: 'chat',
      promptTokens: 1,
      completionTokens: 2,
      success: true,
    });
    await flush();

    expect(usageParams).toHaveLength(1);
    const p = usageParams[0];
    // 入参顺序（R101-AI-03 起）：tenantId, statDate, chat, tool, prompt, completion,
    // total, prompt_cost, completion_cost, total_cost, provider, model
    expect(p[10]).toBe('unknown');
    expect(p[11]).toBe('unknown');
  });

  it('logAiCall：未传 lane/categories → 落 null（历史调用方不受影响）', async () => {
    const { logger, saved } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      promptTokens: 0,
      completionTokens: 0,
      success: true,
    });
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].lane).toBeNull();
    expect(saved[0].categories).toBeNull();
  });

  it('logToolExecution：车道固定 tool，业务域取工具 category', async () => {
    const { logger, saved } = createHarness();

    logger.logToolExecution(makeToolRecord());
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].lane).toBe('tool');
    expect(saved[0].categories).toEqual(['inventory']);
    expect(saved[0].intent).toBe('tool_execution');
  });

  it('logToolExecution：工具无 category → categories 落 null', async () => {
    const { logger, saved } = createHarness();

    logger.logToolExecution(makeToolRecord({ category: undefined }));
    await flush();

    expect(saved).toHaveLength(1);
    expect(saved[0].categories).toBeNull();
  });

  it('logAiCall：Provider 降级元数据并入 tool_calls（event=provider_fallback）', async () => {
    const { logger, saved } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      lane: 'chat',
      promptTokens: 1,
      completionTokens: 2,
      success: true,
      fallback: {
        used: true,
        from: 'glm',
        to: 'deepseek',
        reason: 'timeout',
        attempts: ['glm', 'deepseek'],
        latencyMs: 3000,
      },
    });
    await flush();

    const calls = saved[0].toolCalls ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('provider_fallback');
    expect(calls[0].from).toBe('glm');
    expect(calls[0].to).toBe('deepseek');
  });

  it('logAiCall：AUDIT_MASK_MESSAGE=true 时对手机号与长数字做掩码', async () => {
    const prev = process.env.AUDIT_MASK_MESSAGE;
    process.env.AUDIT_MASK_MESSAGE = 'true';
    try {
      const { logger, saved } = createHarness();

      logger.logAiCall({
        tenantId: 't1',
        lane: 'chat',
        userMessage: '联系 13812345678，证件 123456789012345678',
        promptTokens: 0,
        completionTokens: 0,
        success: true,
      });
      await flush();

      expect(saved[0].userMessage).toContain('138****78');
      expect(saved[0].userMessage).not.toContain('13812345678');
      expect(saved[0].userMessage).not.toContain('123456789012345678');
    } finally {
      if (prev === undefined) {
        delete process.env.AUDIT_MASK_MESSAGE;
      } else {
        process.env.AUDIT_MASK_MESSAGE = prev;
      }
    }
  });

  // P2 返工回归（验收意见）：默认值本身必须有信号——此前仅测"显式开启时
  // 生效"，默认关闭时掩码整体失效而无任何用例变红
  it('logAiCall：AUDIT_MASK_MESSAGE 未设置时掩码默认生效（默认开）', async () => {
    const prev = process.env.AUDIT_MASK_MESSAGE;
    delete process.env.AUDIT_MASK_MESSAGE;
    try {
      const { logger, saved } = createHarness();

      logger.logAiCall({
        tenantId: 't1',
        lane: 'chat',
        userMessage: '联系 13812345678',
        promptTokens: 0,
        completionTokens: 0,
        success: true,
      });
      await flush();

      expect(saved[0].userMessage).toContain('138****78');
      expect(saved[0].userMessage).not.toContain('13812345678');
    } finally {
      if (prev === undefined) {
        delete process.env.AUDIT_MASK_MESSAGE;
      } else {
        process.env.AUDIT_MASK_MESSAGE = prev;
      }
    }
  });

  it('logAiCall：AUDIT_MASK_MESSAGE=false 显式关闭时不掩码（保留排障口）', async () => {
    const prev = process.env.AUDIT_MASK_MESSAGE;
    process.env.AUDIT_MASK_MESSAGE = 'false';
    try {
      const { logger, saved } = createHarness();

      logger.logAiCall({
        tenantId: 't1',
        lane: 'chat',
        userMessage: '联系 13812345678',
        promptTokens: 0,
        completionTokens: 0,
        success: true,
      });
      await flush();

      expect(saved[0].userMessage).toContain('13812345678');
    } finally {
      if (prev === undefined) {
        delete process.env.AUDIT_MASK_MESSAGE;
      } else {
        process.env.AUDIT_MASK_MESSAGE = prev;
      }
    }
  });

  it('best-effort：落库失败不向调用方抛出，且中断后续日用量汇总', async () => {
    const { logger, saved, usageParams } = createHarness();
    saved.length = 0; // 仅作对照基线
    const failing = createHarness();
    failing.failSave = true;

    expect(() =>
      failing.logger.logAiCall({
        tenantId: 't1',
        lane: 'chat',
        promptTokens: 0,
        completionTokens: 0,
        success: true,
      }),
    ).not.toThrow();
    await flush();

    expect(failing.saved).toHaveLength(0);
    expect(failing.usageParams).toHaveLength(0);

    // 对照：正常路径同一调用会落库并触发一次日用量 UPSERT
    logger.logAiCall({
      tenantId: 't1',
      lane: 'chat',
      promptTokens: 0,
      completionTokens: 0,
      success: true,
    });
    await flush();
    expect(saved).toHaveLength(1);
    expect(usageParams).toHaveLength(1);
  });
});

// P1-C 追加（裁定 2）：审计主流水此前 fire-and-forget + logger.warn 静默吞掉，
// 取证链断点无任何可观测手段。收编后三条主流水失败必须落死信 + 指标，且不阻塞。
describe('P1-C AuditLogger 主流水 bestEffort 死信', () => {
  beforeEach(() => resetErrorSemanticsMetrics());
  afterEach(() => setDefaultDeadLetterSink(null));

  it('logAiCall 落库失败 → 写死信 + 计 fail，且不向调用方抛出', async () => {
    const deadLetters: DeadLetterRecord[] = [];
    setDefaultDeadLetterSink((r) => {
      deadLetters.push(r);
    });
    const h = createHarness();
    h.failSave = true;
    const logger = h.logger;

    expect(() =>
      logger.logAiCall({
        tenantId: 't1',
        lane: 'chat',
        promptTokens: 1,
        completionTokens: 2,
        success: true,
      }),
    ).not.toThrow();
    await flush();

    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].op).toBe('audit.logAiCall');
    expect(deadLetters[0].tenantId).toBe('t1');
    expect(deadLetters[0].level).toBe('best_effort');
    expect(deadLetters[0].error).toContain('ai_db down');
    expect(deadLetters[0].detail).toContain('lane=chat');
    expect(errorSemanticsCount('best_effort', 'audit.logAiCall', 'fail')).toBe(
      1,
    );
  });

  it('logToolExecution 落库失败 → 写死信，且不向调用方抛出', async () => {
    const deadLetters: DeadLetterRecord[] = [];
    setDefaultDeadLetterSink((r) => {
      deadLetters.push(r);
    });
    const h = createHarness();
    h.failSave = true;
    const logger = h.logger;

    expect(() => logger.logToolExecution(makeToolRecord())).not.toThrow();
    await flush();

    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].op).toBe('audit.logToolExecution');
    expect(deadLetters[0].detail).toContain('tool=checkInventory');
  });

  it('logWriteGuardEvent 落库失败 → 写死信，且不向调用方抛出', async () => {
    const deadLetters: DeadLetterRecord[] = [];
    setDefaultDeadLetterSink((r) => {
      deadLetters.push(r);
    });
    const h = createHarness();
    h.failSave = true;
    const logger = h.logger;

    expect(() =>
      logger.logWriteGuardEvent({
        tenantId: 't1',
        event: 'pending',
        token: 'wg_***',
        toolName: 'createSalesOrder',
        docType: 'sales_order_create',
        risk: 'medium',
        needsReview: false,
        operationLabel: '创建销售单',
      }),
    ).not.toThrow();
    await flush();

    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].op).toBe('audit.logWriteGuardEvent');
    expect(deadLetters[0].detail).toContain('event=pending');
  });

  it('主流水成功 → 不写死信（死信只在失败路径出现）', async () => {
    const deadLetters: DeadLetterRecord[] = [];
    setDefaultDeadLetterSink((r) => {
      deadLetters.push(r);
    });
    const { logger } = createHarness();

    logger.logAiCall({
      tenantId: 't1',
      lane: 'chat',
      promptTokens: 1,
      completionTokens: 2,
      success: true,
    });
    await flush();

    expect(deadLetters).toHaveLength(0);
    expect(errorSemanticsCount('best_effort', 'audit.logAiCall', 'ok')).toBe(1);
  });
});

/**
 * R101-AI-03：费用三列写入（P1-2）反测
 *
 * 规格（业主裁定「甲方案」）：
 * - UPSERT 的 INSERT 列表与 ON DUPLICATE KEY UPDATE **都必须**含
 *   `prompt_cost` / `completion_cost` / `total_cost`，且 ODKU 为**累加**（不是覆盖）；
 * - 单价只复用 `AiConfigService.getModelPrice(provider, model)`（库里配置）；
 * - **未配置单价 ⇒ 不计费**（三列 0），不得静默按 0 写入后宣称已计费。
 *
 * 反测方向：从 SQL/参数里回退三列 ⇒ 本文件断言变红（原始输出见回传卡）。
 */
describe('R101-AI-03 费用三列（t_ai_usage_daily）', () => {
  const PRICE: ModelPrice = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptPrice: 0.001,
    completionPrice: 0.002,
    currency: 'CNY',
    effectiveFrom: new Date('2026-07-01T00:00:00+08:00'),
  };

  it('已配置单价：INSERT 写三列 + ODKU 三列均累加（不是覆盖）', async () => {
    const h = createHarness();
    h.price = PRICE;

    h.logger.logAiCall({
      tenantId: 't1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 1000,
      completionTokens: 500,
      success: true,
    });
    await flush();

    const sql = h.usageSql[0];
    // INSERT 列清单
    expect(sql).toContain('prompt_cost, completion_cost, total_cost');
    // ODKU 必须是累加（累加项三列各有），不得覆盖
    expect(sql).toContain('prompt_cost = prompt_cost + VALUES(prompt_cost)');
    expect(sql).toContain(
      'completion_cost = completion_cost + VALUES(completion_cost)',
    );
    expect(sql).toContain('total_cost = total_cost + VALUES(total_cost)');
    // 参数：单价 × tokens / 1000（元/千Token），4 位舍入
    const params = h.usageParams[0];
    expect(params.slice(7, 10)).toEqual([0.001, 0.001, 0.002]);
    // total = prompt + completion（库内自洽）
    expect(params[9]).toBe((params[7] as number) + (params[8] as number));
    // 单价只从库里配置取（provider/model 与调用一致）
    expect(h.priceLookups).toEqual([['deepseek', 'deepseek-chat']]);
  });

  it('舍入口径：与 DECIMAL(12,4) 对齐，total = round4(prompt+completion)', async () => {
    const h = createHarness();
    h.price = { ...PRICE, promptPrice: 0.001, completionPrice: 0.002 };

    h.logger.logAiCall({
      tenantId: 't1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 333,
      completionTokens: 777,
      success: true,
    });
    await flush();

    // 0.001*333/1000 = 0.000333 → 0.0003；0.002*777/1000 = 0.001554 → 0.0016
    const params = h.usageParams[0];
    expect(params.slice(7, 10)).toEqual([0.0003, 0.0016, 0.0019]);
  });

  it('未配置单价 ⇒ 不计费（三列 0），且确实查过价（不是静默按 0 计费）', async () => {
    const h = createHarness();
    h.price = null; // 未配置

    h.logger.logAiCall({
      tenantId: 't1',
      provider: 'glm',
      model: 'glm-4-flash',
      promptTokens: 1000,
      completionTokens: 1000,
      success: true,
    });
    await flush();

    expect(h.usageParams[0].slice(7, 10)).toEqual([0, 0, 0]);
    expect(h.priceLookups).toEqual([['glm', 'glm-4-flash']]);
  });

  it('显式配置 0 元 ⇒ 计费 0（与未配置可区分：查价命中）', async () => {
    const h = createHarness();
    h.price = { ...PRICE, promptPrice: 0, completionPrice: 0 };

    h.logger.logAiCall({
      tenantId: 't1',
      provider: 'ollama',
      model: 'qwen2.5:7b',
      promptTokens: 1000,
      completionTokens: 1000,
      success: true,
    });
    await flush();

    expect(h.usageParams[0].slice(7, 10)).toEqual([0, 0, 0]);
    expect(h.priceLookups).toHaveLength(1);
  });

  it('工具执行（无 token）⇒ 不查价，三列 0，用量计数照常落库', async () => {
    const h = createHarness();
    h.logger.logToolExecution(makeToolRecord());
    await flush();

    expect(h.priceLookups).toHaveLength(0);
    const params = h.usageParams[0];
    expect(params.slice(7, 10)).toEqual([0, 0, 0]);
    expect(params[4]).toBe(0); // prompt_tokens
    expect(params[3]).toBe(1); // tool_call_count 仍 +1
  });

  it('查价异常 ⇒ 按未配置处理（0），但用量行仍落库（不因旁路失败丢计数）', async () => {
    const h = createHarness();
    h.failPrice = true;

    h.logger.logAiCall({
      tenantId: 't1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptTokens: 100,
      completionTokens: 100,
      success: true,
    });
    await flush();

    expect(h.usageSql).toHaveLength(1); // 用量行照写
    expect(h.usageParams[0].slice(7, 10)).toEqual([0, 0, 0]);
    expect(h.saved).toHaveLength(1); // 审计主流水不受影响
  });
});
