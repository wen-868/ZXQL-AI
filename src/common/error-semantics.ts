/**
 * 三级错误处理语义基础设施（阶段1-批次1）
 *
 * 背景：全库 96 处 catch 块统一使用「catch + logger.warn + return 降级值」反模式，
 * 不分场合地覆盖了三类语义完全不同的操作，造成「虚假成功」缺陷
 * （如计费失败漏计费、写步骤令牌挂起失败却标记 success）。
 *
 * 本文件提供三个语义明确的处理函数，供后续批次把 catch 点批量迁移过来：
 *
 * | 函数          | 语义                     | 失败后行为                          | 典型场景                                   |
 * | ------------- | ------------------------ | ----------------------------------- | ------------------------------------------ |
 * | degrade       | 旁路增强失败可降级       | logger.warn + 指标 + 返回 fallback  | 记忆召回 / RAG / 规则注入 / 向量装载       |
 * | mustSucceed   | 写路径真相失败必须上抛   | logger.error + 指标 + throw         | 写令牌注册 / 计划步骤挂起 / 计费真相       |
 * | bestEffort    | 可最终一致的旁路         | logger.error + 指标 + 写死信        | 计费落账 / 审计 / 用量上报 / 推送          |
 *
 * 错误码体系沿用 ai-errors.ts 的 AI_ERRORS；本文件新增 AI_014（关键操作失败）
 * 作为 mustSucceed 未显式指定错误码时的默认码。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-07
 */
import { HttpException, Logger } from '@nestjs/common';
import { aiError, aiErrorHttp, type AiErrorCode } from './ai-errors';

/** 三级语义级别（同时作为指标 label） */
export type ErrorSemanticsLevel = 'degrade' | 'must_succeed' | 'best_effort';

/** 单次语义处理的上下文 */
export interface ErrCtx {
  /** 操作名，用于日志与指标 label，建议 `模块.动作`，如 `billing.consume` */
  op: string;
  /** 租户 ID（多租户隔离定位用） */
  tenantId?: string;
  /** 补充说明（如 key、订单号），进入日志与死信 */
  detail?: string;
  /**
   * mustSucceed 专用：抛出时使用的 AI 错误码，缺省 AI_014（关键操作失败）。
   * degrade / bestEffort 忽略该字段。
   */
  code?: AiErrorCode;
  /**
   * bestEffort 专用：本次死信的接收回调；未传时回落到全局默认
   * （见 setDefaultDeadLetterSink）。degrade / mustSucceed 忽略该字段。
   */
  deadLetter?: DeadLetterSink;
}

/** 死信记录 */
export interface DeadLetterRecord {
  /** 失败的操作名 */
  op: string;
  /** 租户 ID */
  tenantId?: string;
  /** 补充说明 */
  detail?: string;
  /** 错误消息 */
  error: string;
  /** 错误堆栈（便于复盘，可能为空） */
  stack?: string;
  /** 语义级别，恒为 best_effort */
  level: ErrorSemanticsLevel;
  /** 失败发生时间（ISO 8601） */
  at: string;
}

/**
 * 死信接收回调。
 * 第一阶段实现：仅 logger.error + 指标 + 回调；回调由调用方/全局默认提供。
 * TODO(阶段1-批次2)：接入真正的持久队列（Redis Stream / DB 死信表）实现重放，
 * 当前实现不具备进程重启后的可恢复能力，请勿视为最终形态。
 */
export type DeadLetterSink = (record: DeadLetterRecord) => void | Promise<void>;

/** 指标单条快照：ai_error_semantics_total{level,op,result} */
export interface ErrorSemanticsMetric {
  level: ErrorSemanticsLevel;
  op: string;
  result: 'ok' | 'fail';
  value: number;
}

const logger = new Logger('ErrorSemantics');

/** 计数器：key = `${level}|${op}|${result}` */
const counters = new Map<string, number>();

/** 全局默认死信接收方（由启动阶段 setDefaultDeadLetterSink 注册） */
let defaultDeadLetterSink: DeadLetterSink | null = null;

/** mustSucceed 默认错误码：AI_014 关键操作失败（500） */
const DEFAULT_CRITICAL_CODE: AiErrorCode = 'AI_014';

/**
 * 注册全局默认死信接收方。
 * 第一阶段实现见 DeadLetterSink 注释：尚未接持久队列，注册方需自行保证可靠性。
 */
export function setDefaultDeadLetterSink(sink: DeadLetterSink | null): void {
  defaultDeadLetterSink = sink;
}

/** 读取当前指标快照（供测试断言与运维排查） */
export function getErrorSemanticsMetrics(): ErrorSemanticsMetric[] {
  const out: ErrorSemanticsMetric[] = [];
  for (const [key, value] of counters) {
    const [level, op, result] = key.split('|');
    out.push({
      level: level as ErrorSemanticsLevel,
      op,
      result: result as 'ok' | 'fail',
      value,
    });
  }
  return out;
}

/** 按条件读取计数值（不存在返回 0） */
export function errorSemanticsCount(
  level: ErrorSemanticsLevel,
  op: string,
  result: 'ok' | 'fail',
): number {
  return counters.get(`${level}|${op}|${result}`) ?? 0;
}

/** 渲染 Prometheus text format（ai_error_semantics_total{level,op,result}） */
export function renderErrorSemantics(): string {
  return getErrorSemanticsMetrics()
    .map(
      (m) =>
        `ai_error_semantics_total{level="${m.level}",op="${m.op}",result="${m.result}"} ${m.value}`,
    )
    .join('\n');
}

/** 清空计数器（仅供测试） */
export function resetErrorSemanticsMetrics(): void {
  counters.clear();
}

/**
 * 语义一：旁路增强失败可降级。
 *
 * 适用：记忆召回 / RAG 检索 / 规则注入 / 向量装载等「有则更好、无则可用」的旁路。
 * 失败 → logger.warn + 指标(fail) + 返回 fallback；绝不向上抛。
 */
export async function degrade<T>(
  op: () => Promise<T>,
  fallback: T,
  ctx: ErrCtx,
): Promise<T> {
  try {
    const value = await op();
    record('degrade', ctx.op, 'ok');
    return value;
  } catch (error) {
    record('degrade', ctx.op, 'fail');
    logger.warn(
      `[degrade] 旁路失败已降级 op=${ctx.op} tenant=${ctx.tenantId ?? '-'} ` +
        `detail=${ctx.detail ?? '-'} err=${messageOf(error)}`,
    );
    return fallback;
  }
}

/**
 * 语义二：写路径真相失败必须上抛。
 *
 * 适用：写令牌注册 / 计划步骤挂起 / 计费真相 / 隐私操作回执等
 * 「失败即真相缺失」的操作。失败 → logger.error + 指标(fail) + throw。
 *
 * 硬约束：本函数内部严禁 catch 后返回默认值/undefined——那会把失败伪装成成功。
 * 未被修改的原始异常若是 HttpException 则原样上抛，其余统一包装为
 * CriticalOperationError（携带 AI 错误码）。
 */
export async function mustSucceed<T>(
  op: () => Promise<T>,
  ctx: ErrCtx,
): Promise<T> {
  try {
    const value = await op();
    record('must_succeed', ctx.op, 'ok');
    return value;
  } catch (error) {
    record('must_succeed', ctx.op, 'fail');
    logger.error(
      `[mustSucceed] 关键写路径失败，向上抛出 op=${ctx.op} tenant=${
        ctx.tenantId ?? '-'
      } detail=${ctx.detail ?? '-'} err=${messageOf(error)}`,
      error instanceof Error ? error.stack : undefined,
    );
    throw toCriticalError(error, ctx);
  }
}

/**
 * 语义三：可最终一致的旁路。
 *
 * 适用：计费落账 / 审计流水 / 用量上报 / 消息推送等「失败可后补」的操作。
 * 失败 → logger.error + 指标(fail) + 写死信；不抛、不阻断主流程。
 * 死信优先用 ctx.deadLetter，其次全局默认；两者都缺失时只落日志与指标。
 */
export async function bestEffort(
  op: () => Promise<void>,
  ctx: ErrCtx,
): Promise<void> {
  try {
    await op();
    record('best_effort', ctx.op, 'ok');
  } catch (error) {
    record('best_effort', ctx.op, 'fail');
    const deadLetter: DeadLetterRecord = {
      op: ctx.op,
      tenantId: ctx.tenantId,
      detail: ctx.detail,
      error: messageOf(error),
      stack: error instanceof Error ? error.stack : undefined,
      level: 'best_effort',
      at: new Date().toISOString(),
    };
    logger.error(
      `[bestEffort] 旁路失败已入死信 op=${ctx.op} tenant=${ctx.tenantId ?? '-'} ` +
        `detail=${ctx.detail ?? '-'} err=${deadLetter.error}`,
      deadLetter.stack,
    );

    const sink = ctx.deadLetter ?? defaultDeadLetterSink;
    if (!sink) {
      logger.error(
        `[bestEffort] 无死信接收方，记录仅留存日志 op=${ctx.op}（请注册 setDefaultDeadLetterSink）`,
      );
      return;
    }
    try {
      await sink(deadLetter);
    } catch (sinkError) {
      // 死信写入本身失败：只能落日志，不能再抛（bestEffort 语义要求不阻断主流程）
      logger.error(
        `[bestEffort] 死信写入失败（记录可能丢失）op=${ctx.op} err=${messageOf(
          sinkError,
        )}`,
      );
    }
  }
}

/**
 * 关键操作失败异常：携带 AI 错误码，可被 AllExceptionsFilter 直出统一错误结构。
 */
export class CriticalOperationError extends HttpException {
  /** AI 错误码 */
  readonly code: AiErrorCode;

  constructor(code: AiErrorCode = DEFAULT_CRITICAL_CODE, detail?: string) {
    super(
      aiError(code, {
        detail,
        suggestion: '该操作位于写路径真相链，失败不可降级，请检查依赖后重试',
      }),
      aiErrorHttp(code),
    );
    this.name = 'CriticalOperationError';
    this.code = code;
  }
}

/** 计数：level/op/result → +1 */
function record(
  level: ErrorSemanticsLevel,
  op: string,
  result: 'ok' | 'fail',
): void {
  const key = `${level}|${op}|${result}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/**
 * 统一取错误消息（兼容非 Error 抛出物）
 *
 * 硬约束：本函数**永不抛**。调用方 bestEffort 在其 catch 块内构造死信记录时
 * 会调本函数，toCriticalError 也调；一旦这里抛，异常会穿透 bestEffort 的
 * catch 块（catch 块本身不是保护边界），把「静默降级」升级为 unhandledRejection
 * —— 而 audit-logger 的 `void bestEffort(...)` 不 await 不挂 catch，会打挂进程。
 *
 * 不可信点有两处，都必须兜住：
 * 1. `JSON.stringify` 对循环引用抛 TypeError；
 * 2. `String(error)` 会调 `error.toString()`，那是**用户代码**，可以抛。
 * 因此兜底分支不能再裸调 String(error)，需二次兜底后返回可辨识文案
 * （不返回空串，否则记录丢失且无从判断是异常还是空值）。
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // 到这里说明 JSON.stringify 失败（循环引用 / 不可序列化）。
    // 仍先尝试 String(error)：多数不可序列化值（普通对象）走这条能拿到有用信息。
    try {
      return String(error);
    } catch {
      return '<不可序列化的异常：JSON.stringify 与 toString 均失败>';
    }
  }
}

/** 将原始异常包装为带 AI 错误码的异常（HttpException 原样透传，避免二次包装丢码） */
function toCriticalError(error: unknown, ctx: ErrCtx): HttpException {
  if (error instanceof HttpException) return error;
  const detail = [ctx.detail, messageOf(error)].filter(Boolean).join(' | ');
  return new CriticalOperationError(ctx.code ?? DEFAULT_CRITICAL_CODE, detail);
}
