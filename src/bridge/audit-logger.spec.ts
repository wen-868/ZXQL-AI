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
import { ToolExecutionRecord } from '../tools/tool.interface';

interface Harness {
  logger: AuditLogger;
  /** 已 save 的审计实体 */
  saved: AiAuditLogEntity[];
  /** upsertDailyUsage 传给 dataSource.query 的参数列表 */
  usageParams: unknown[][];
  /** 让 save 抛错（用于 best-effort 验证） */
  failSave: boolean;
}

function createHarness(): Harness {
  const saved: AiAuditLogEntity[] = [];
  const usageParams: unknown[][] = [];
  const harness: Harness = {
    logger: undefined as unknown as AuditLogger,
    saved,
    usageParams,
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
    query: (_sql: string, params: unknown[]) => {
      usageParams.push(params);
      return Promise.resolve([]);
    },
  };

  harness.logger = new AuditLogger(auditLogRepo as never, dataSource as never);
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
