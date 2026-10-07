/**
 * 三级错误处理语义单元测试（阶段1-批次1）
 *
 * 覆盖：
 * - degrade：失败返回 fallback / 成功返回真值 / 指标计数
 * - mustSucceed：失败确实抛出 CriticalOperationError（含错误码）/ 成功返回真值
 * - bestEffort：失败不抛 / 死信被写入 / 成功不写死信
 *
 * 负责人: AI底座 | 创建日期: 2026-10-07
 */
import { HttpException, Logger } from '@nestjs/common';
import {
  bestEffort,
  CriticalOperationError,
  degrade,
  errorSemanticsCount,
  getErrorSemanticsMetrics,
  mustSucceed,
  renderErrorSemantics,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
  type DeadLetterRecord,
} from './error-semantics';

describe('三级错误处理语义', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorSemanticsMetrics();
    setDefaultDeadLetterSink(null);
    // 静音日志输出，避免污染单测结果；保留 spy 引用用于断言（避免 unbound-method）
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('degrade — 旁路增强失败可降级', () => {
    it('失败时返回 fallback 且不抛', async () => {
      const out = await degrade<string[]>(
        () => Promise.reject(new Error('redis down')),
        [],
        { op: 'memory.recall', tenantId: 't_001' },
      );

      expect(out).toEqual([]);
      // 降级语义必须落 warn（而不是 error），且不得向上抛
      expect(warnSpy).toHaveBeenCalled();
      expect(errorSemanticsCount('degrade', 'memory.recall', 'fail')).toBe(1);
    });

    it('成功时返回真实值（不被 fallback 覆盖）', async () => {
      const out = await degrade(
        () => Promise.resolve(['命中片段A']),
        [] as string[],
        {
          op: 'rag.retrieve',
          tenantId: 't_001',
        },
      );

      expect(out).toEqual(['命中片段A']);
      expect(errorSemanticsCount('degrade', 'rag.retrieve', 'ok')).toBe(1);
      expect(errorSemanticsCount('degrade', 'rag.retrieve', 'fail')).toBe(0);
    });

    it('指标按 op/result 累加且可渲染为 Prometheus 文本', async () => {
      const fail = (): Promise<number> =>
        Promise.reject(new Error('vector load fail'));
      await degrade(fail, 0, { op: 'vector.load' });
      await degrade(fail, 0, { op: 'vector.load' });
      await degrade(() => Promise.resolve(1), 0, { op: 'vector.load' });

      expect(errorSemanticsCount('degrade', 'vector.load', 'fail')).toBe(2);
      expect(errorSemanticsCount('degrade', 'vector.load', 'ok')).toBe(1);
      expect(getErrorSemanticsMetrics()).toHaveLength(2);
      expect(renderErrorSemantics()).toContain(
        'ai_error_semantics_total{level="degrade",op="vector.load",result="fail"} 2',
      );
    });
  });

  describe('mustSucceed — 写路径真相失败必须上抛', () => {
    it('失败时确实抛出 CriticalOperationError（而非返回默认值）', async () => {
      const boom = (): Promise<string> =>
        Promise.reject(new Error('token register failed'));

      // 反测锚点：若实现退化成 catch+warn+return，此 await 会 resolve 而非 reject，
      // 断言 immediately 变红（见反测记录）
      await expect(
        mustSucceed(boom, { op: 'writeToken.register', tenantId: 't_001' }),
      ).rejects.toBeInstanceOf(CriticalOperationError);

      expect(
        errorSemanticsCount('must_succeed', 'writeToken.register', 'fail'),
      ).toBe(1);
    });

    it('成功时返回真实值且只记 ok', async () => {
      const out = await mustSucceed(() => Promise.resolve('tok_abc'), {
        op: 'writeToken.register',
      });

      expect(out).toBe('tok_abc');
      expect(
        errorSemanticsCount('must_succeed', 'writeToken.register', 'ok'),
      ).toBe(1);
      expect(
        errorSemanticsCount('must_succeed', 'writeToken.register', 'fail'),
      ).toBe(0);
    });

    it('抛出的异常携带正确错误码与 HTTP 状态', async () => {
      const boom = (): Promise<void> =>
        Promise.reject(new Error('deduct failed'));

      // 未指定 code：默认 AI_014 关键操作失败（500）
      const errDefault = await mustSucceed(boom, {
        op: 'billing.deduct',
      }).catch((e: unknown) => e);
      expect(errDefault).toBeInstanceOf(CriticalOperationError);
      expect((errDefault as CriticalOperationError).code).toBe('AI_014');
      expect((errDefault as CriticalOperationError).getStatus()).toBe(500);

      // 指定 code：按调用方语义上抛
      const errCustom = await mustSucceed(boom, {
        op: 'planStep.suspend',
        code: 'AI_011',
        detail: 'step=3',
      }).catch((e: unknown) => e);
      expect(errCustom).toBeInstanceOf(CriticalOperationError);
      expect((errCustom as CriticalOperationError).code).toBe('AI_011');
      expect((errCustom as CriticalOperationError).getStatus()).toBe(428);
    });

    it('原始异常已是 HttpException 时原样透传（不二次包装丢码）', async () => {
      const original = new HttpException(
        { code: 'AI_012', message: '令牌不匹配' },
        409,
      );

      const thrown = await mustSucceed(() => Promise.reject(original), {
        op: 'writeToken.verify',
      }).catch((e: unknown) => e);

      expect(thrown).toBe(original);
      expect(thrown).not.toBeInstanceOf(CriticalOperationError);
    });
  });

  describe('bestEffort — 可最终一致的旁路', () => {
    it('失败不抛且写入死信（ctx.deadLetter 优先）', async () => {
      const captured: DeadLetterRecord[] = [];

      await expect(
        bestEffort(() => Promise.reject(new Error('audit sink 500')), {
          op: 'audit.append',
          tenantId: 't_001',
          detail: 'trace=abc',
          deadLetter: (r) => {
            captured.push(r);
          },
        }),
      ).resolves.toBeUndefined();

      expect(captured).toHaveLength(1);
      expect(captured[0].op).toBe('audit.append');
      expect(captured[0].tenantId).toBe('t_001');
      expect(captured[0].detail).toBe('trace=abc');
      expect(captured[0].error).toContain('audit sink 500');
      expect(captured[0].level).toBe('best_effort');
      expect(captured[0].at).toBeDefined();
      expect(errorSemanticsCount('best_effort', 'audit.append', 'fail')).toBe(
        1,
      );
    });

    it('未传 ctx.deadLetter 时回落到全局默认 sink', async () => {
      const captured: DeadLetterRecord[] = [];
      setDefaultDeadLetterSink((r) => {
        captured.push(r);
      });

      await bestEffort(() => Promise.reject(new Error('usage report fail')), {
        op: 'usage.report',
      });

      expect(captured).toHaveLength(1);
      expect(captured[0].op).toBe('usage.report');
    });

    it('成功时不写死信且只记 ok', async () => {
      const captured: DeadLetterRecord[] = [];
      setDefaultDeadLetterSink((r) => {
        captured.push(r);
      });

      await bestEffort(() => Promise.resolve(), { op: 'billing.post' });

      expect(captured).toHaveLength(0);
      expect(errorSemanticsCount('best_effort', 'billing.post', 'ok')).toBe(1);
      expect(errorSemanticsCount('best_effort', 'billing.post', 'fail')).toBe(
        0,
      );
    });

    it('无死信接收方时仍不抛（仅落日志与指标）', async () => {
      await expect(
        bestEffort(() => Promise.reject(new Error('no sink')), {
          op: 'notify.push',
        }),
      ).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalled();
      expect(errorSemanticsCount('best_effort', 'notify.push', 'fail')).toBe(1);
    });

    it('死信 sink 自身抛错也不向上冒泡（不阻断主流程）', async () => {
      await expect(
        bestEffort(() => Promise.reject(new Error('primary fail')), {
          op: 'audit.append',
          deadLetter: () => {
            throw new Error('sink down');
          },
        }),
      ).resolves.toBeUndefined();

      expect(errorSemanticsCount('best_effort', 'audit.append', 'fail')).toBe(
        1,
      );
    });
  });

  // P1-C 追加（裁定采纳）：AuditLogger.fireAndForget 等调用方是 `void bestEffort(...)`——
  // 既不 await 也不挂 .catch。bestEffort 任一路径抛出去，都会变成 unhandled
  // rejection 直接打挂进程。这里把「永不抛」契约钉死，优先级高于其他语义用例。
  describe('bestEffort 永不抛契约（不 await 调用方兜底）', () => {
    it('sink 异步 reject → 仍不抛（否则 void 调用变 unhandled rejection）', async () => {
      await expect(
        bestEffort(() => Promise.reject(new Error('primary fail')), {
          op: 'audit.logAiCall',
          tenantId: 't_001',
          deadLetter: () => Promise.reject(new Error('sink async down')),
        }),
      ).resolves.toBeUndefined();

      expect(
        errorSemanticsCount('best_effort', 'audit.logAiCall', 'fail'),
      ).toBe(1);
    });

    it('op 抛 + sink 抛同时发生 → 仍不抛，且死信写入失败留 error 日志', async () => {
      await expect(
        bestEffort(() => Promise.reject(new Error('op fail')), {
          op: 'audit.logToolExecution',
          tenantId: 't_002',
          deadLetter: () => Promise.reject(new Error('sink fail')),
        }),
      ).resolves.toBeUndefined();

      expect(
        errorSemanticsCount('best_effort', 'audit.logToolExecution', 'fail'),
      ).toBe(1);
      // 死信写不进去也必须留痕，否则记录丢失连排查入口都没有
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('死信写入失败'),
      );
    });
  });
});
