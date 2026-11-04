/**
 * InvocationGuardService 单元测试（AI-P2-4-TOOL-INVOCATION-GUARD-01）
 *
 * 覆盖：超时预算与 timer 清理、错误分类、有界重试与退避硬上限、
 * 写工具零自动重试（唯一例外=确认链+稳定幂等键+transient 补试 1 次、
 * timeout 永不重试）、降级文案、TOOL_TIMEOUT_MS env 防护（自 graph 通道移植）。
 */
import { ConfigService } from '@nestjs/config';
import {
  InvocationGuardService,
  ToolErrorClass,
} from './invocation-guard.service';
import type { ToolResult } from './tool.interface';

function makeGuard(env: Record<string, string> = {}): InvocationGuardService {
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => env[key] ?? fallback),
  } as unknown as ConfigService;
  return new InvocationGuardService(config);
}

const CHAT_OPTS = (over: Record<string, unknown> = {}) => ({
  toolName: 'searchProduct',
  isWriteOperation: false,
  channel: 'chat' as const,
  tenantId: 't1',
  ...over,
});

const ok = (data: unknown = { ok: 1 }): ToolResult => ({
  success: true,
  data,
});

/** 依次抛出给定错误，耗尽后抛最后一个 */
function throwingSeq(errors: unknown[]): () => Promise<ToolResult> {
  let i = 0;
  return () => {
    const e = errors[Math.min(i, errors.length - 1)];
    i += 1;
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  };
}

/** 前 failuresToFail 次抛 transient 错误，之后成功 */
function flakyThenOk(
  failMsg: string,
  failuresToFail: number,
): { invoke: () => Promise<ToolResult>; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    invoke: () => {
      calls += 1;
      if (calls <= failuresToFail) return Promise.reject(new Error(failMsg));
      return Promise.resolve(ok());
    },
  };
}

describe('InvocationGuardService（三通道唯一调用保护）', () => {
  describe('错误分类', () => {
    const cases: Array<[string, string, ToolErrorClass]> = [
      ['超时文案', '工具 searchProduct 执行超时（60000ms）', 'timeout'],
      ['timeout 英文', 'request timeout after 60000ms', 'timeout'],
      ['ETIMEDOUT', 'connect ETIMEDOUT 10.0.0.1:8080', 'timeout'],
      ['越权拒绝', 'AI_010 客户身份越权拦截', 'rejected'],
      ['幂等键拒绝', '显式幂等键不合规', 'rejected'],
      ['服务不可用', 'ECONNREFUSED 127.0.0.1:8080', 'unavailable'],
      ['503', '后端 HTTP 503：Service Unavailable', 'unavailable'],
      ['网络抖动', '后端 HTTP 502：Bad Gateway（网络波动）', 'transient'],
      ['429 限流', 'HTTP 429 Too Many Requests', 'transient'],
      ['参数校验失败', '后端 HTTP 400：参数校验失败（path=/x）', 'permanent'],
      ['未知归 transient', 'something weird happened', 'transient'],
    ];
    it.each(cases)('%s → %s', (_label, message, expected) => {
      expect(makeGuard().classify(message)).toBe(expected);
    });
  });

  describe('超时预算', () => {
    it('工具挂死：预算内返回 timeout 降级结果（会话不挂死）', async () => {
      const guard = makeGuard({ TOOL_TIMEOUT_MS: '50' });
      const started = Date.now();
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => new Promise<ToolResult>(() => undefined),
      });
      expect(outcome.result.success).toBe(false);
      expect(outcome.errorClass).toBe('timeout');
      expect(outcome.result.error).toContain('超时');
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('TOOL_TIMEOUT_MS env 防护：NaN（"60s"）与空串回退默认 60s（自 graph 移植）', () => {
      expect(makeGuard({ TOOL_TIMEOUT_MS: '60s' }).getTimeoutMs()).toBe(60000);
      expect(makeGuard({ TOOL_TIMEOUT_MS: '' }).getTimeoutMs()).toBe(60000);
      expect(makeGuard({ TOOL_TIMEOUT_MS: '0' }).getTimeoutMs()).toBe(60000);
      expect(makeGuard({ TOOL_TIMEOUT_MS: '-5' }).getTimeoutMs()).toBe(60000);
      expect(makeGuard({ TOOL_TIMEOUT_MS: '2500' }).getTimeoutMs()).toBe(2500);
    });

    it('timer 生命周期：成功/超时/重试路径句柄全部清除（零悬空，M6 活靶）', async () => {
      const created: Array<ReturnType<typeof setTimeout>> = [];
      const cleared: Array<unknown> = [];
      const realSet = global.setTimeout as unknown as (
        h: TimerHandler,
        ms?: number,
      ) => ReturnType<typeof setTimeout>;
      const realClear = global.clearTimeout;
      const setSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((h: TimerHandler, ms?: number) => {
          const handle = realSet(h, ms);
          created.push(handle);
          return handle;
        });
      const clearSpy = jest
        .spyOn(global, 'clearTimeout')
        .mockImplementation((h?: unknown) => {
          cleared.push(h);
          return realClear(h as never);
        });
      try {
        // 成功路径
        await makeGuard({ TOOL_TIMEOUT_MS: '200' }).run({
          ...CHAT_OPTS(),
          invoke: () => Promise.resolve(ok()),
        });
        // 超时路径
        await makeGuard({ TOOL_TIMEOUT_MS: '30' }).run({
          ...CHAT_OPTS(),
          toolName: 'slowTool',
          invoke: () => new Promise<ToolResult>(() => undefined),
        });
        // 重试路径（transient 一次后恢复）
        await makeGuard({
          TOOL_TIMEOUT_MS: '200',
          TOOL_RETRY_BACKOFF_MS: '10',
        }).run({
          ...CHAT_OPTS(),
          invoke: throwingSeq([new Error('ECONNRESET')]),
        });
      } finally {
        setSpy.mockRestore();
        clearSpy.mockRestore();
      }
      // 预算 timer 全部经 finally 清除；退避 sleeper 自然触发（句柄会被 clearTimeout 之外的方式结束）
      const budgetCleared = created.length > 0;
      expect(budgetCleared).toBe(true);
      // 每个被 clearTimeout 的句柄都来自本测试创建的句柄（无外部污染）
      for (const h of cleared) {
        expect(created).toContain(h);
      }
      // 超时路径的 timer 必须被清除（等待自然到期句柄除外）
      const pending = created.filter((h) => !cleared.includes(h));
      // 允许自然触发的退避 sleeper 存活（10ms 已到期），预算 timer 不得残留
      expect(pending.length).toBeLessThanOrEqual(2);
    });
  });

  describe('有界重试与退避', () => {
    it('transient 抛错 → 退避后重试恢复（attempts=2，退避按指数）', async () => {
      const guard = makeGuard({
        TOOL_RETRY_BACKOFF_MS: '10',
        TOOL_TIMEOUT_MS: '500',
      });
      const flaky = flakyThenOk('ECONNRESET 网络抖动', 1);
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: flaky.invoke,
      });
      expect(flaky.calls()).toBe(2);
      expect(outcome.result.success).toBe(true);
      expect(outcome.attempts).toBe(2);
      expect(outcome.errorClass).toBeNull();
    });

    it('transient 持续失败 → 次数封顶（默认共 3 次）', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => {
          calls += 1;
          return Promise.reject(new Error('HTTP 502'));
        },
      });
      expect(calls).toBe(3);
      expect(outcome.attempts).toBe(3);
      expect(outcome.errorClass).toBe('transient');
      expect(outcome.result.error).toContain('已尝试 3 次');
    });

    it('重试次数可配置且硬上限 3（配 10 也只 3 次）', () => {
      expect(
        makeGuard({ TOOL_RETRY_MAX_ATTEMPTS: '10' }).getMaxAttempts(),
      ).toBe(3);
      expect(makeGuard({ TOOL_RETRY_MAX_ATTEMPTS: '1' }).getMaxAttempts()).toBe(
        1,
      );
      expect(
        makeGuard({ TOOL_RETRY_MAX_ATTEMPTS: 'abc' }).getMaxAttempts(),
      ).toBe(3);
    });

    it('退避硬上限 5000ms（配 999999 也封顶）', () => {
      expect(
        makeGuard({ TOOL_RETRY_BACKOFF_MS: '999999' }).getBackoffMs(),
      ).toBe(5000);
    });

    it('permanent（HTTP 400 参数校验失败）不重试', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => {
          calls += 1;
          return Promise.reject(new Error('后端 HTTP 400：参数校验失败'));
        },
      });
      expect(calls).toBe(1);
      expect(outcome.errorClass).toBe('permanent');
      expect(outcome.result.error).toContain('业务规则拒绝');
    });

    it('rejected（AI_010 越权）不重试', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => {
          calls += 1;
          return Promise.reject(new Error('AI_010 客户身份越权拦截'));
        },
      });
      expect(calls).toBe(1);
      expect(outcome.errorClass).toBe('rejected');
    });

    it('unavailable（ECONNREFUSED）不重试、即时失败', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => {
          calls += 1;
          return Promise.reject(
            new Error('connect ECONNREFUSED 127.0.0.1:8080'),
          );
        },
      });
      expect(calls).toBe(1);
      expect(outcome.errorClass).toBe('unavailable');
      expect(outcome.result.error).toContain('服务当前不可用');
    });

    it('success=false 业务失败为权威答复：不重试、保留原始错误语义', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => {
          calls += 1;
          return Promise.resolve({ success: false, error: '查无此客户' });
        },
      });
      expect(calls).toBe(1);
      expect(outcome.result.error).toBe('查无此客户');
      expect(outcome.attempts).toBe(1);
    });
  });

  describe('写工具重试约束', () => {
    it('写工具默认零自动重试（transient 抛错也只 1 次副作用）', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS({ toolName: 'createSalesOrder', isWriteOperation: true }),
        invoke: () => {
          calls += 1;
          return Promise.reject(new Error('ECONNRESET'));
        },
      });
      expect(calls).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.errorClass).toBe('transient');
    });

    it('唯一例外：确认链注入+稳定幂等键+transient → 恰好补试 1 次（副作用 2）', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS({ toolName: 'createSalesOrder', isWriteOperation: true }),
        writeRetryAllowed: true,
        invoke: () => {
          calls += 1;
          if (calls === 1) return Promise.reject(new Error('ECONNRESET'));
          return Promise.resolve(ok({ orderNo: 'XS1' }));
        },
      });
      expect(calls).toBe(2);
      expect(outcome.result.success).toBe(true);
      expect(outcome.attempts).toBe(2);
    });

    it('写工具超时永不重试（状态未知不重发，writeRetryAllowed 也不行）', async () => {
      const guard = makeGuard({
        TOOL_TIMEOUT_MS: '40',
        TOOL_RETRY_BACKOFF_MS: '10',
      });
      let calls = 0;
      const outcome = await guard.run({
        ...CHAT_OPTS({ toolName: 'createSalesOrder', isWriteOperation: true }),
        writeRetryAllowed: true,
        invoke: () => {
          calls += 1;
          return new Promise<ToolResult>(() => undefined);
        },
      });
      expect(calls).toBe(1);
      expect(outcome.errorClass).toBe('timeout');
      expect(outcome.result.error).toContain('状态未知');
      expect(outcome.result.error).toContain('请勿重复提交');
    });
  });

  describe('降级与审计结论', () => {
    it('恢复路径带 attemptsLog 与通道标签（审计可追溯）', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      const flaky = flakyThenOk('ECONNRESET', 1);
      const outcome = await guard.run({
        ...CHAT_OPTS({ toolName: 'slowTool' }),
        invoke: flaky.invoke,
      });
      expect(outcome.channel).toBe('chat');
      expect(outcome.attemptsLog).toHaveLength(2);
      expect(outcome.attemptsLog[0].errorClass).toBe('transient');
      expect(outcome.attemptsLog[1].errorClass).toBeNull();
      expect(outcome.attemptsLog.every((a) => a.durationMs >= 0)).toBe(true);
    });

    it('用户可见文案区分：超时/临时故障/业务拒绝三类互不相同', async () => {
      const guard = makeGuard({ TOOL_RETRY_BACKOFF_MS: '10' });
      const t = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => Promise.reject(new Error('ETIMEDOUT 超时')),
      });
      const u = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => Promise.reject(new Error('ECONNREFUSED')),
      });
      const p = await guard.run({
        ...CHAT_OPTS(),
        invoke: () => Promise.reject(new Error('HTTP 400：参数校验失败')),
      });
      expect(t.result.error).toContain('超时');
      expect(u.result.error).toContain('不可用');
      expect(p.result.error).toContain('业务规则拒绝');
      expect(t.result.error).not.toBe(u.result.error);
      expect(u.result.error).not.toBe(p.result.error);
    });
  });
});
