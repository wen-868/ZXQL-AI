/**
 * bestEffort「永不抛」契约测试（阶段1-批次 P1-C 收尾）
 *
 * 目的：给「void bestEffort(...) 这种不 await 的调用方」提供测试保护。
 *
 * 背景：P1-C 把 src/bridge/audit-logger.ts 的 fireAndForget(fn, ctx) 迁移成
 * `void bestEffort(fn, ctx)`（见 audit-logger.ts:537）。注意 `void` ——
 * 调用方既不 await 也不挂 .catch。这建立了隐式依赖：
 *   若 bestEffort 冒抛 → 审计写入失败从「静默降级」升级为 Node unhandledRejection，
 *   在部分配置下会直接打挂进程。
 * 而在补本文件之前，没有任何测试守护这条契约：测试全绿不能证明它成立。
 *
 * 为什么单独一个文件（而不是追加到 error-semantics.spec.ts）：
 *   1. error-semantics.spec.ts 里已有的 bestEffort 用例是「顺带」覆盖，用的是
 *      `.resolves.toBeUndefined()` —— 该写法只能证明「最终 resolve 了 undefined」，
 *      无法区分「resolve 得早」与「先reject 后被谁吞了」，也不是本契约要求的
 *      显式捕获写法；契约守卫应当独立成文件、断言方式统一。
 *   2. 与既有姊妹文件 error-semantics.degrade-contract.spec.ts 命名/结构对齐，
 *      便于按「某次迁移的契约」检索。
 *
 * 断言方式约定（重要，不要降级为 not.toThrow）：
 *   一律用「显式布尔标记 + try/catch」。理由：若将来有人给 bestEffort 加了
 *   setTimeout / 微任务延迟的冒抛，await + try/catch 能稳定捕获到真实逃逸，
 *   而 not.toThrow 这类写法在异步链上可能测不到。
 *
 * 另外补了一条 P0 回归测试组：messageOf()曾对「循环引用 + 自定义 toString 抛异常」
 * 的抛出物二次抛出，导致 bestEffort 冒泡（已修复，见 error-semantics.ts 的 messageOf）。
 *该组用例必须用非 Error 抛出物，故整文件关闭 prefer-promise-reject-errors。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-07
 */
/* eslint-disable @typescript-eslint/prefer-promise-reject-errors --
 * 本文件刻意构造非 Error 抛出物（字符串/ 循环引用对象 + 抛异常的 toString），
 * 用来验证 bestEffort / messageOf 对畸形抛出物的兼容与兜底行为。
 * 该规则在此处与测试意图直接冲突，故整文件关闭。 */
import { Logger } from '@nestjs/common';
import {
  bestEffort,
  CriticalOperationError,
  errorSemanticsCount,
  mustSucceed,
  resetErrorSemanticsMetrics,
  setDefaultDeadLetterSink,
  type DeadLetterRecord,
  type DeadLetterSink,
} from './error-semantics';

/**
 * 捕获 bestEffort 的逃逸异常。
 *
 * 用显式布尔标记而非 `not.toThrow()`：本函数的返回值直接就是「有没有冒抛」的
 * 判定依据，调用方只需断言 escaped === false。若探针本身写错（例如忘了 await），
 * 下方「探针自检」用例会立刻变红。
 */
async function captureEscape(run: () => Promise<unknown>): Promise<boolean> {
  let escaped = false;
  try {
    await run();
  } catch {
    escaped = true;
  }
  return escaped;
}

/** 让微任务 + 下一个宏任务队列都排空，用于观察延迟冒抛与 unhandledRejection */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('bestEffort 永不抛契约（void 调用方不得依赖 await 兜底）', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    resetErrorSemanticsMetrics();
    setDefaultDeadLetterSink(null);
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('用例 1：op 同步抛异常', () => {
    it('不冒泡，且死信被调用并记录到该 op', async () => {
      const captured: DeadLetterRecord[] = [];
      const sink: DeadLetterSink = (r) => {
        captured.push(r);
      };

      const escaped = await captureEscape(() =>
        bestEffort(
          () => {
            throw new Error('audit repo save 同步失败');
          },
          { op: 'audit.append', tenantId: 't_001', deadLetter: sink },
        ),
      );

      expect(escaped).toBe(false);
      // 死信必须真的落，且落到正确的 op 上（否则「静默丢弃」也算通过）
      expect(captured).toHaveLength(1);
      expect(captured[0].op).toBe('audit.append');
      expect(captured[0].tenantId).toBe('t_001');
      expect(captured[0].error).toContain('audit repo save 同步失败');
      expect(captured[0].level).toBe('best_effort');
    });

    it('op 同步抛时错误指标被记为 fail（不是静默）', async () => {
      await captureEscape(() =>
        bestEffort(
          () => {
            throw new Error('sync boom');
          },
          { op: 'audit.syncFail', deadLetter: () => undefined },
        ),
      );

      // 与用例 5（正常路径记 ok、死信不写）成对，二者共同证明指标不是恒定值
      expect(count('best_effort', 'audit.syncFail', 'fail')).toBe(1);
      expect(count('best_effort', 'audit.syncFail', 'ok')).toBe(0);
    });
  });

  describe('用例 2：op 返回 rejected Promise（异步抛）', () => {
    it('不冒泡，且死信被调用并记录到该 op', async () => {
      const captured: DeadLetterRecord[] = [];
      const sink: DeadLetterSink = (r) => {
        captured.push(r);
      };

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('db连接池耗尽')), {
          op: 'audit.asyncFail',
          tenantId: 't_002',
          detail: 'lane=chat',
          deadLetter: sink,
        }),
      );

      expect(escaped).toBe(false);
      expect(captured).toHaveLength(1);
      expect(captured[0].op).toBe('audit.asyncFail');
      expect(captured[0].detail).toBe('lane=chat');
      expect(captured[0].error).toContain('db连接池耗尽');
      // 栈信息必须被保留，否则死信无法用于复盘
      expect(typeof captured[0].stack).toBe('string');
      expect(count('best_effort', 'audit.asyncFail', 'fail')).toBe(1);
    });

    it('未传 ctx.deadLetter 时回落到全局默认 sink 且仍不冒泡', async () => {
      const captured: DeadLetterRecord[] = [];
      setDefaultDeadLetterSink((r) => {
        captured.push(r);
      });

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('default sink 路径')), {
          op: 'audit.defaultSink',
        }),
      );

      expect(escaped).toBe(false);
      expect(captured).toHaveLength(1);
      expect(captured[0].op).toBe('audit.defaultSink');
    });

    it('ctx.deadLetter 优先于全局默认 sink', async () => {
      const viaCtx: DeadLetterRecord[] = [];
      const viaDefault: DeadLetterRecord[] = [];
      setDefaultDeadLetterSink((r) => {
        viaDefault.push(r);
      });

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('both')), {
          op: 'audit.priority',
          deadLetter: (r) => {
            viaCtx.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      expect(viaCtx).toHaveLength(1);
      expect(viaDefault).toHaveLength(0);
    });

    it('两者都缺失时也不冒泡（仅落日志与指标）', async () => {
      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('no sink at all')), {
          op: 'audit.noSink',
        }),
      );

      expect(escaped).toBe(false);
      expect(count('best_effort', 'audit.noSink', 'fail')).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('用例 3：死信 sink 自身同步抛异常', () => {
    it('bestEffort 仍不冒泡（不因 sink 失败而冒泡）', async () => {
      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('primary fail')), {
          op: 'audit.sinkSyncThrow',
          deadLetter: () => {
            throw new Error('sink 同步失败');
          },
        }),
      );

      expect(escaped).toBe(false);
    });

    it('sink 同步抛时留 error 日志（记录丢失必须可排查）', async () => {
      await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('primary fail')), {
          op: 'audit.sinkSyncThrowLog',
          deadLetter: () => {
            throw new Error('sink 同步失败');
          },
        }),
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('死信写入失败'),
      );
    });
  });

  describe('用例 4：死信 sink 返回 rejected Promise（异步失败）', () => {
    it('bestEffort 仍不冒泡（不因 sink 失败而冒泡）', async () => {
      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('primary fail')), {
          op: 'audit.sinkAsyncThrow',
          tenantId: 't_003',
          deadLetter: () => Promise.reject(new Error('sink 异步失败')),
        }),
      );

      expect(escaped).toBe(false);
      expect(count('best_effort', 'audit.sinkAsyncThrow', 'fail')).toBe(1);
    });

    it('op 抛 + sink 异步抛叠加时仍不冒泡，且 sink 失败留痕', async () => {
      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('op fail')), {
          op: 'audit.bothThrow',
          deadLetter: () => Promise.reject(new Error('sink fail')),
        }),
      );

      expect(escaped).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('死信写入失败'),
      );
    });
  });

  describe('用例 5：正常路径', () => {
    it('不冒泡，且死信不应被调用（防「什么都记死信」的恒真实现）', async () => {
      const viaCtx: DeadLetterRecord[] = [];
      const viaDefault: DeadLetterRecord[] = [];
      setDefaultDeadLetterSink((r) => {
        viaDefault.push(r);
      });

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.resolve(), {
          op: 'audit.ok',
          tenantId: 't_004',
          deadLetter: (r) => {
            viaCtx.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      // 反向断言：成功路径绝不能写死信。若实现退化成「无论成败都写死信」，
      // 这两条会立刻变红 —— 这是本用例存在的意义。
      expect(viaCtx).toHaveLength(0);
      expect(viaDefault).toHaveLength(0);
      expect(count('best_effort', 'audit.ok', 'ok')).toBe(1);
      expect(count('best_effort', 'audit.ok', 'fail')).toBe(0);
    });

    it('op 抛非 Error 值（字符串）时也不冒泡', async () => {
      const captured: DeadLetterRecord[] = [];

      const escaped = await captureEscape(() =>
        //刻意用非Error 抛出物：验证 messageOf 对非 Error 的兼容路径

        bestEffort(() => Promise.reject('裸字符串失败'), {
          op: 'audit.stringThrow',
          deadLetter: (r) => {
            captured.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      expect(captured).toHaveLength(1);
      expect(captured[0].error).toContain('裸字符串失败');
    });
  });

  describe('用例 6：返回值契约', () => {
    it('成功路径 resolve 成 undefined（不是「是否成功」之类的有意义的值）', async () => {
      // 编译期即证明返回类型是 Promise<void>（若改成 Promise<boolean> 此行报错）
      const pending: Promise<void> = bestEffort(() => Promise.resolve(), {
        op: 'audit.return.ok',
      });
      const raw: unknown = await pending;

      expect(raw).toBeUndefined();
    });

    it('失败路径同样 resolve 成 undefined（不是 reject、也不是 true/false）', async () => {
      const captured: DeadLetterRecord[] = [];
      const pending: Promise<void> = bestEffort(
        () => Promise.reject(new Error('fail path')),
        {
          op: 'audit.return.fail',
          deadLetter: (r) => {
            captured.push(r);
          },
        },
      );
      const raw: unknown = await pending;

      expect(raw).toBeUndefined();
      expect(captured).toHaveLength(1);
    });

    it('死信 sink 失败路径同样 resolve 成 undefined', async () => {
      const pending: Promise<void> = bestEffort(
        () => Promise.reject(new Error('primary')),
        {
          op: 'audit.return.sinkFail',
          deadLetter: () => Promise.reject(new Error('sink fail')),
        },
      );
      const raw: unknown = await pending;

      expect(raw).toBeUndefined();
    });
  });

  describe('用例 7：真实调用形态 —— void bestEffort(...) 不得产生逃逸 rejection', () => {
    /**
     * 这是 P1-C 迁移实际使用的形态（audit-logger.ts:537 `void bestEffort(fn, ctx)`）：
     * 不 await、不挂 .catch。
     *
     * 探针选型说明（踩坑记录）：本用例**不能**用
     *   process.on('unhandledRejection', ...) 来测。实测 Jest 会自行拦截
     *   unhandledRejection 并直接把该用例判失败，监听器根本不会被调用 ——
     *   那样写出来的「无rejection」断言是零信号恒真（对照组会变红，但变红原因
     *   是 Jest 报错而非探针捕获）。
     * 改为「取bestEffort 返回的 promise 并挂 then(成功, 失败) 观察者」：
     * 这不改变被测调用点的形态（依然不 await、不挂.catch，逃逸仍会成立），
     * 但能让失败被记录下来并可断言。
     */

    /** 观察一个「不被await」的 promise 是否逃逸 reject */
    function watch(promise: Promise<unknown>): {
      escaped: () => boolean;
      settled: () => Promise<void>;
    } {
      let rejected = false;
      promise.then(
        () => undefined,
        () => {
          rejected = true;
        },
      );
      return {
        escaped: () => rejected,
        settled: flushAsync,
      };
    }

    it('void 调用 + op 失败 + sink 失败：bestEffort 的 promise 不得reject', async () => {
      // 关键：这里刻意不 await、不挂 .catch，完全复刻 audit-logger 的调用形态
      const spy = watch(
        bestEffort(() => Promise.reject(new Error('void 路径主失败')), {
          op: 'audit.voidPath',
          tenantId: 't_005',
          deadLetter: () => Promise.reject(new Error('void 路径死信失败')),
        }),
      );

      await spy.settled();

      expect(spy.escaped()).toBe(false);
      expect(count('best_effort', 'audit.voidPath', 'fail')).toBe(1);
    });

    it('void 调用 + op 成功：同样不得 reject', async () => {
      const spy = watch(
        bestEffort(() => Promise.resolve(), { op: 'audit.voidOk' }),
      );

      await spy.settled();

      expect(spy.escaped()).toBe(false);
    });

    it('对照自检：watch 探针对真的 reject 必须能观测到（零信号防护）', async () => {
      // 若这条变红，说明 watch 探针坏了，上面两条的 escaped===false 是恒真的。
      // 禁止删除本条。
      const spy = watch(Promise.reject(new Error('对照组：故意 reject')));

      await spy.settled();

      expect(spy.escaped()).toBe(true);
    });
  });

  describe('P0：messageOf 恶意抛出物（P0 缺陷的直接回归测试）', () => {
    /**
     * 缺陷：messageOf 的 `catch { return String(error) }` 不在 try 保护内 ——
     * catch 块本身不是保护边界。String(error) 会调 error.toString()，
     * 而 toString 是用户代码，可以抛。
     *
     * 触发三条件（须同时满足）：
     *   ① 抛出的不是 Error 实例、也不是字符串（否则走 instanceof /typeof 提前返回）
     *   ② 值循环引用      → JSON.stringify 抛 TypeError
     *   ③ toString() 抛   → String(error) 也抛
     *
     * 现实影响：当前审计路径抛的是 TypeORM 的 Error 实例，故暂不触发；
     * 但一旦某个 op 包装了抛非 Error 值的第三方 SDK，「静默降级」会升级为
     * unhandledRejection —— 而 audit-logger.ts:537 的 `void bestEffort(fn, ctx)`
     * 正是不 await 不挂 catch 的高危形态。
     */

    /** 构造「循环引用 + toString 抛异常」的恶意抛出物 */
    function makeUnserializable(): unknown {
      const value: Record<string, unknown> = {
        toString(): string {
          throw new Error('toString boom');
        },
      };
      value.self = value; // 循环引用
      return value;
    }

    it('op 抛「循环引用 + toString 抛」：bestEffort 不冒泡（修复前变红）', async () => {
      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(makeUnserializable()), {
          op: 'audit.unserializable',
          tenantId: 't_006',
          deadLetter: () => undefined,
        }),
      );

      // 修复前此行为 true（messageOf 二次抛出穿透 bestEffort）
      expect(escaped).toBe(false);
      expect(count('best_effort', 'audit.unserializable', 'fail')).toBe(1);
    });

    /**
     * 精确定位 messageOf：死信记录的 error 字段就是 messageOf 的返回值本身，
     * 因此断言该字段内容即可直接验证 messageOf 产出了兜底串而非抛异常。
     */
    it('messageOf 对「循环引用 + toString 抛」返回可辨识兜底串（修复前变红）', async () => {
      const captured: DeadLetterRecord[] = [];

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(makeUnserializable()), {
          op: 'audit.fallbackText',
          deadLetter: (r) => {
            captured.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      // 死信必须真的写了，且 error 字段是「看得出是异常」的兜底文案
      expect(captured).toHaveLength(1);
      const msg: string = captured[0].error;
      // 非空串，且明确指向「不可序列化」，便于人工排查时识别
      expect(msg).not.toBe('');
      expect(msg).toContain('不可序列化');
    });

    it('toString 正常但循环引用：兜底走 String(error) 而非固定文案（不回归）', async () => {
      const captured: DeadLetterRecord[] = [];
      // 循环引用但 toString 可用 → JSON.stringify 抛，String(error) 成功
      const circular: Record<string, unknown> = {
        tag: 'circular-but-printable',
      };
      circular.self = circular;

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(circular), {
          op: 'audit.circularPrintable',
          deadLetter: (r) => {
            captured.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      expect(captured).toHaveLength(1);
      // String(circular) === '[object Object]'，不是那条不可序列化兜底文案
      expect(captured[0].error).toBe('[object Object]');
    });

    it('Error 实例仍走 error.message（修复不得改变正常路径）', async () => {
      const captured: DeadLetterRecord[] = [];

      const escaped = await captureEscape(() =>
        bestEffort(() => Promise.reject(new Error('正常 Error 信息')), {
          op: 'audit.normalError',
          deadLetter: (r) => {
            captured.push(r);
          },
        }),
      );

      expect(escaped).toBe(false);
      expect(captured[0].error).toBe('正常 Error 信息');
    });

    it('mustSucceed 路径（toCriticalError 也调 messageOf）：必须抛 CriticalOperationError', async () => {
      // 必须Succeed 的语义是「失败必上抛 CriticalOperationError」。
      // 修复前：toCriticalError 内的 messageOf 二次抛出，导致冒出来的
      // 是 toString 的原始 Error 而非 CriticalOperationError → 本条变红。
      // 修复后：messageOf 返回兜底串，包装出正确的 CriticalOperationError。
      let thrown: unknown = null;
      try {
        await mustSucceed(() => Promise.reject(makeUnserializable()), {
          op: 'billing.unserializable',
          tenantId: 't_007',
        });
      } catch (e: unknown) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(CriticalOperationError);
      // 且detail 里能看出兜底文案（证明 messageOf 真的产出了串）
      // 注意：detail 在 getResponse() 里，.message 是固定的「关键操作失败」
      const body: unknown = (thrown as CriticalOperationError).getResponse();
      const detailText: string =
        typeof body === 'object' && body !== null && 'detail' in body
          ? String((body as { detail?: unknown }).detail)
          : '';
      expect(detailText).toContain('不可序列化');
    });

    it('对照组：普通 Error 经 mustSucceed 仍携带原始信息（不回归）', async () => {
      const thrown: unknown = await mustSucceed(
        () => Promise.reject(new Error('扣费失败真相')),
        { op: 'billing.normal' },
      ).catch((e: unknown) => e);

      expect(thrown).toBeInstanceOf(CriticalOperationError);
      const body: unknown = (thrown as CriticalOperationError).getResponse();
      const detailText: string =
        typeof body === 'object' && body !== null && 'detail' in body
          ? String((body as { detail?: unknown }).detail)
          : '';
      expect(detailText).toContain('扣费失败真相');
    });
  });

  describe('探针自检（保证上述「不冒泡」断言不是零信号）', () => {
    it('captureEscape 对真实抛出的函数能返回 true', async () => {
      const escaped = await captureEscape(() =>
        Promise.reject(new Error('探针自检：应当被捕获')),
      );

      expect(escaped).toBe(true);
    });

    it('captureEscape 对正常返回的函数返回 false', async () => {
      const escaped = await captureEscape(() => Promise.resolve());

      expect(escaped).toBe(false);
    });

    it('errorSemanticsCount 对未见过的 op 返回 0（不是恒真）', () => {
      expect(count('best_effort', '从未出现过的 op', 'fail')).toBe(0);
      expect(count('best_effort', '从未出现过的 op', 'ok')).toBe(0);
    });
  });
});

/**
 * 指标计数的局部短别名，仅为让用例行宽可控。
 * 语义完全等同于 errorSemanticsCount，不做任何包装或改写。
 */
function count(
  level: 'degrade' | 'must_succeed' | 'best_effort',
  op: string,
  result: 'ok' | 'fail',
): number {
  return errorSemanticsCount(level, op, result);
}
