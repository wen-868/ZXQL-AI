/**
 * InvocationGuardService — 三通道统一工具调用保护（AI-P2-4-TOOL-INVOCATION-GUARD-01）
 *
 * 统一语义（chat/agent/graph 经 ToolExecutor 共用本 guard，不再各留 timeout）：
 * 1. 超时预算与 timer 生命周期：每次尝试独立预算（TOOL_TIMEOUT_MS，默认 60s），
 *    race 落定 finally clearTimeout（必要时 unref），零悬空 timer；
 * 2. 错误分类：timeout / transient / permanent / rejected / unavailable；
 * 3. 最大尝试次数与退避：读工具 transient 有界重试（默认共 3 次，硬上限 3；
 *    退避 300ms 指数 ×2，硬上限 5s），均可 env 配置；
 * 4. 写工具默认零自动重试：唯一例外=确认链注入（allowConfirm）且显式稳定幂等键
 *    （idempotencyKey）且 transient（非 timeout）时最多补试 1 次——超时状态未知
 *    时绝不重发写请求，禁止超时/重试造成重复副作用；
 * 5. 超时和失败后的友好降级结果（用户可见文案区分超时/服务不可用/业务失败）；
 * 6. 熔断与指标由调用方（ToolExecutor）按本 guard 的最终结论统一记账。
 *
 * 负责人: 阿洲（AI协助）| 创建日期: 2026-11-04
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ToolResult } from './tool.interface';

/** 工具错误分类 */
export type ToolErrorClass =
  'timeout' | 'transient' | 'permanent' | 'rejected' | 'unavailable';

export const TOOL_ERROR_CLASSES: readonly ToolErrorClass[] = [
  'timeout',
  'transient',
  'permanent',
  'rejected',
  'unavailable',
];

/** 单次尝试记录（审计/指标用，不含凭据与 body） */
export interface ToolGuardAttempt {
  attempt: number;
  errorClass: ToolErrorClass | null;
  durationMs: number;
}

/** guard 最终结论 */
export interface ToolGuardOutcome {
  result: ToolResult;
  /** 最终失败类别；成功为 null */
  errorClass: ToolErrorClass | null;
  /** 实际尝试次数（≥1） */
  attempts: number;
  attemptsLog: ToolGuardAttempt[];
  /** 本次调用所属通道（审计标签） */
  channel: 'chat' | 'agent' | 'graph';
}

export interface ToolGuardOptions {
  toolName: string;
  isWriteOperation: boolean;
  channel: 'chat' | 'agent' | 'graph';
  tenantId: string;
  /**
   * 写重试唯一开关：仅当「确认链注入（allowConfirm）+ 显式稳定幂等键」时为 true。
   * 即使为 true，也只对 transient 补试 1 次，timeout 永不重试。
   */
  writeRetryAllowed?: boolean;
  /** 执行一次工具调用（attempt 从 1 开始） */
  invoke: (attempt: number) => Promise<ToolResult>;
}

/** 尝试预算超时（内部标记，用于可靠分类） */
class ToolTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(`工具 ${toolName} 执行超时（${timeoutMs}ms 预算）`);
    this.name = 'ToolTimeoutError';
  }
}

/** 尝试次数与退避硬上限（防止 env 误配放大风险） */
const HARD_MAX_ATTEMPTS = 3;
const HARD_BACKOFF_CAP_MS = 5000;
const DEFAULT_TIMEOUT_MS = 60000;

@Injectable()
export class InvocationGuardService {
  private readonly configService?: ConfigService;
  private readonly defaultTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  /**
   * configService 可选（测试注入桩）；生产路径免 DI：直接读 process.env，
   * ToolExecutor 以字段默认实例持有（ToolsModule 无需注册，语义与 env 可配置性不变）。
   */
  constructor(configService?: ConfigService) {
    this.configService = configService;
    this.defaultTimeoutMs = this.num('TOOL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.min(
      this.num('TOOL_RETRY_MAX_ATTEMPTS', 3),
      HARD_MAX_ATTEMPTS,
    );
    this.backoffMs = Math.min(
      this.num('TOOL_RETRY_BACKOFF_MS', 300),
      HARD_BACKOFF_CAP_MS,
    );
  }

  /** 兜底实例（旧 5 参构造的 ToolExecutor 复用统一语义） */
  static withDefaultConfig(): InvocationGuardService {
    return new InvocationGuardService(undefined);
  }

  getTimeoutMs(): number {
    return this.defaultTimeoutMs;
  }

  getMaxAttempts(): number {
    return this.maxAttempts;
  }

  getBackoffMs(): number {
    return this.backoffMs;
  }

  private num(key: string, fallback: number): number {
    // NaN/非数字/<=0 防护（P0 返工回归口径：env 配坏不得即时超时或放大的重试）
    const raw = this.configService?.get<string>(key) ?? process.env[key];
    const v = Number(raw ?? String(fallback));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /**
   * 错误分类（消息字符串规则，含中英文与常见网络/HTTP 形态）
   *
   * 优先级：timeout → rejected → unavailable → transient → permanent（未知归 transient，
   * 读工具可吃一次有界重试；写工具不重试故无放大风险）。
   */
  classify(message: unknown): ToolErrorClass {
    const s =
      typeof message === 'string'
        ? message
        : message instanceof Error
          ? message.message
          : '';
    if (
      /\btimeout\b|timed?\s*out|超时|ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError/i.test(
        s,
      )
    ) {
      return 'timeout';
    }
    if (
      /AI_010|越权|权限|被拒绝|已被拒绝|幂等键|rejected|forbidden|unauthorized|401|403/i.test(
        s,
      )
    ) {
      return 'rejected';
    }
    if (
      /ECONNREFUSED|EAI_AGAIN|服务不可用|服务暂时|熔断|HTTP 503\b|503 Service/i.test(
        s,
      )
    ) {
      return 'unavailable';
    }
    if (
      /ECONNRESET|ENOTFOUND|EPIPE|HTTP 5\d\d|HTTP 502\b|HTTP 504\b|\b429\b|rate.?limit|网络|network/i.test(
        s,
      )
    ) {
      return 'transient';
    }
    if (
      /HTTP 4\d\d|参数校验|校验失败|参数解析|参数错误|invalid|400|404|409|conflict/i.test(
        s,
      )
    ) {
      return 'permanent';
    }
    return 'transient';
  }

  /** 是否可重试：仅 transient；写工具需 writeRetryAllowed 且最多补试 1 次 */
  private retryable(
    cls: ToolErrorClass,
    attempt: number,
    opts: ToolGuardOptions,
  ): boolean {
    if (cls !== 'transient') return false;
    if (opts.isWriteOperation) {
      return !!opts.writeRetryAllowed && attempt < 2;
    }
    return attempt < this.maxAttempts;
  }

  /** 单次尝试超时预算：race 落定（完成/超时/异常均经 finally）即清除 timer */
  private withTimeout<T>(p: Promise<T>, toolName: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolTimeoutError(toolName, this.defaultTimeoutMs)),
        this.defaultTimeoutMs,
      );
      // 兜底：不让学生 timer 拖住进程退出（clearTimeout 为主，见 finally）
      timer.unref?.();
    });
    return Promise.race([p, budget]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  /** 退避 sleeper：指数 ×2，硬上限封顶；unref 防拖进程 */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref?.();
    });
  }

  /** 失败友好降级（用户可见文案区分超时/服务不可用/业务失败） */
  private degrade(
    opts: ToolGuardOptions,
    cls: ToolErrorClass,
    lastError: string,
    attempts: number,
  ): ToolResult {
    const writeUnknown =
      opts.isWriteOperation && cls === 'timeout'
        ? '；执行超时后状态未知，请勿重复提交，请先人工核实是否已生效'
        : '';
    const byClass: Record<
      ToolErrorClass,
      { error: string; suggestion: string }
    > = {
      timeout: {
        error: `工具 ${opts.toolName} 执行超时（预算 ${this.defaultTimeoutMs}ms）${writeUnknown}`,
        suggestion: '请稍后重试或简化请求；写操作请先人工核实结果再决定下一步',
      },
      transient: {
        error: `工具 ${opts.toolName} 调用出现临时故障（已尝试 ${attempts} 次）：${lastError}`,
        suggestion: '服务波动，请稍后重试',
      },
      permanent: {
        error: `工具 ${opts.toolName} 调用被业务规则拒绝：${lastError}`,
        suggestion: '请检查参数或业务前提是否正确（此类错误重试无效）',
      },
      rejected: {
        error: `工具 ${opts.toolName} 请求被拒绝：${lastError}`,
        suggestion: '请确认权限或数据归属；如需继续请联系管理员',
      },
      unavailable: {
        error: `工具 ${opts.toolName} 依赖的服务当前不可用：${lastError}`,
        suggestion: '服务恢复后自动可用；可稍后重试',
      },
    };
    return { success: false, ...byClass[cls] };
  }

  /**
   * 统一执行：超时预算 + 分类 + 有界重试 + 退避 + 降级
   *
   * 永不抛异常；所有 timer/退避 sleeper 在 finally/触发后清理。
   * 重试口径：仅「抛异常且分类为 transient」的有界重试；success=false 的业务
   * 失败属权威答复，不重试（保留原始语义，只补分类/尝试数）。
   */
  async run(opts: ToolGuardOptions): Promise<ToolGuardOutcome> {
    const attemptsLog: ToolGuardAttempt[] = [];
    let lastError = '';
    for (let attempt = 1; ; attempt += 1) {
      const t0 = Date.now();
      try {
        const outcome = await this.withTimeout(
          opts.invoke(attempt),
          opts.toolName,
        );
        const durationMs = Date.now() - t0;
        const finalCls: ToolErrorClass | null = outcome.success
          ? null
          : this.classify(outcome.error ?? '');
        attemptsLog.push({ attempt, errorClass: finalCls, durationMs });
        return {
          result: outcome.success
            ? outcome
            : { ...outcome, error: outcome.error ?? '未知错误' },
          errorClass: finalCls,
          attempts: attempt,
          attemptsLog,
          channel: opts.channel,
        };
      } catch (err) {
        const cls: ToolErrorClass =
          err instanceof ToolTimeoutError
            ? 'timeout'
            : this.classify(err instanceof Error ? err.message : err);
        const durationMs = Date.now() - t0;
        attemptsLog.push({ attempt, errorClass: cls, durationMs });
        lastError = err instanceof Error ? err.message : String(err);
        if (
          attempt >= HARD_MAX_ATTEMPTS ||
          !this.retryable(cls, attempt, opts)
        ) {
          return {
            result: this.degrade(opts, cls, lastError, attempt),
            errorClass: cls,
            attempts: attempt,
            attemptsLog,
            channel: opts.channel,
          };
        }
        await this.sleep(
          Math.min(this.backoffMs * 2 ** (attempt - 1), HARD_BACKOFF_CAP_MS),
        );
      }
    }
  }
}
