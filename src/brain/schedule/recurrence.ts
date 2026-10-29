/**
 * Recurrence 展开器（AI-P2-2 §四.4/§四.5）—— **唯一实现**
 *
 * 为什么必须单一来源：卡面 §五.7「禁止平行实现」。人工 API 与 AI 工具**都**只能调用
 * `ScheduleDomainService`，而预览（未来 5 次）与落库（展开 occurrence）都由**本文件**
 * 计算 ⇒ 硬验收 6「AI 与人工对同一输入得到相同 preview」由结构保证，不靠两处对齐。
 *
 * ── 安全子集（卡面 §四.4）────────────────────────────────────────────
 * FREQ：DAILY | WEEKLY | MONTHLY | YEARLY（其余一律拒绝）
 * INTERVAL：正整数（缺省 1）
 * BYDAY：WEEKLY 专用（MO,TU,WE,TH,FR,SA,SU；可多值）
 * BYMONTHDAY：MONTHLY 专用（1..31，可多值）
 * COUNT 与 UNTIL：**二选一**（同时给 ⇒ 校验失败；都不给 ⇒ 默认 COUNT=10 防无界）
 * 时区：**固定 Asia/Shanghai**（不读服务器时区、不接受入参时区）
 *
 * ── 短月规则（卡面 §五.4/反测 3）──────────────────────────────────────
 * BYMONTHDAY/MONTHLY 在短月：29/30/31 落在**当月最后一天**（2026-02-28、2026-04-30…）
 * ⇒ 用 `clampDayToMonth` 单向夹紧，**绝不进位到下月 1 号**（那会让「每月 31 日」
 *   在 2 月变成 3 月 3 日，语义错且与人工日历不一致）
 *
 * ── 30/31 与 29 的差别（易错点，明确写死）──────────────────────────────
 * - `BYMONTHDAY=31` 在 30 天月 ⇒ 落 30 号；在 2 月 ⇒ 落 28/29 号
 * - `BYMONTHDAY=30` 在 2 月 ⇒ 落 28/29 号；在 31 天月 ⇒ **仍是 30 号**（不夹紧）
 * ⇒ 夹紧只发生在"目标日 > 当月天数"时，绝不在"目标日 ≤ 当月天数"时改动。
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-28
 */

/** 支持的四类频率（其余一律拒绝，不做"看起来支持"的假实现） */
export type RecurrenceFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

/** 星期缩写（BYDAY 取值域，顺序与 Date.getUTCDay 对应） */
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** 订阅规则（解析后的**规范形态**） */
export interface RecurrenceRule {
  freq: RecurrenceFreq;
  interval: number;
  /** WEEKLY 专用；缺省 = 取 DTSTART 的星期几 */
  byDay?: Weekday[];
  /** MONTHLY 专用；缺省 = 取 DTSTART 的日 */
  byMonthDay?: number[];
  /** COUNT / UNTIL **二选一**（都已规范化：COUNT 缺省 10，UNTIL 为毫秒时间戳） */
  count?: number;
  until?: number;
}

/** 来自外部（工具入参 / HTTP body）的**未受信**规则：fre-可以错误、interval 可缺省 */
export interface RecurrenceRuleInput {
  freq?: unknown;
  interval?: unknown;
  byDay?: unknown[];
  byMonthDay?: unknown[];
  count?: unknown;
  until?: unknown;
}

/** 未受信 raw 输入的联合（字符串或任意对象都要被本函数拒或规范） */
export type RecurrenceRuleRaw =
  string | Partial<RecurrenceRuleInput> | RecurrenceRule | null | undefined;

/** 校验失败（携带可读原因，供工具/HTTP 直接回给调用方） */
export class RecurrenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceError';
  }
}

/** Asia/Shanghai 固定偏移（+08:00，无夏令时；中国 1991 年后不再实行） */
const SH_OFFSET_MS = 8 * 60 * 60 * 1000;
/** COUNT 缺省上限（COUNT/UNTIL 都不给时防无界展开） */
const DEFAULT_COUNT = 10;

/**
 * 把"上海墙上时间"当作 UTC 来运算的辅助：**统一在 UTC 域做日历算术**
 *
 * 技巧：把真实时刻 +8h 后用 UTC getter 读取 ⇒ 得到上海墙上时间各分量；
 * 写回时再 -8h ⇒ 还原成真实时刻。全程无夏令时分支（上海无 DST），
 * 且**不依赖进程时区**（服务器在 UTC 或任意时区结果一致）。
 */
function toWall(ms: number): Date {
  return new Date(ms + SH_OFFSET_MS);
}
function fromWall(wall: Date): number {
  return wall.getTime() - SH_OFFSET_MS;
}

/** 某年某月的天数（month 为 1..12） */
export function daysInMonth(year: number, month: number): number {
  // 下月第 0 天 = 本月最后一天（UTC 域，无时区干扰）
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 短月夹紧：目标日 > 当月天数 ⇒ 取当月最后一天（**绝不进位**） */
export function clampDayToMonth(
  year: number,
  month: number,
  day: number,
): number {
  const last = daysInMonth(year, month);
  return Math.min(day, last);
}

/**
 * 解析原始规则 ⇒ 规范形态；非法一律抛 RecurrenceError
 *
 * 🔴 入参类型是 `Partial<RecurrenceRule>`（而非 RecurrenceRule）：本函数职责就是
 * **校验未受信输入**（AI 工具入参 / HTTP body 都是自由 JSON），interval 等字段
 * 正是由它补默认值与拒绝非法值；若强约束成完整规则类型，等于"调用方先自己校验"，
 * 与本文件"唯一实现"的口径矛盾。
 */
export function parseRecurrenceRule(raw: RecurrenceRuleRaw): RecurrenceRule {
  if (raw === null || raw === undefined || raw === '') {
    throw new RecurrenceError(
      'recurrenceRule 不能为空（单次日程请不传该参数）',
    );
  }
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new RecurrenceError('recurrenceRule 不是合法 JSON');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new RecurrenceError('recurrenceRule 必须是对象');
  }
  const o = obj as Record<string, unknown>;

  // ── FREQ（只接受四类；不做"其他值当 DAILY"的静默兜底）──
  const freqRaw = String((o.freq as string | undefined) ?? '').toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freqRaw)) {
    throw new RecurrenceError(
      `不支持的频率 ${String(o.freq)}（仅 DAILY/WEEKLY/MONTHLY/YEARLY）`,
    );
  }
  const freq = freqRaw as RecurrenceFreq;

  // ── INTERVAL（正整数）──
  const interval = o.interval === undefined ? 1 : Number(o.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 99) {
    throw new RecurrenceError('interval 必须是 1..99 的整数');
  }

  // ── COUNT / UNTIL 二选一（同时给 ⇒ 显式失败，卡面反测 4）──
  const hasCount = o.count !== undefined && o.count !== null;
  const hasUntil = o.until !== undefined && o.until !== null;
  if (hasCount && hasUntil) {
    throw new RecurrenceError('count 与 until 只能二选一（同时给出即非法）');
  }
  let count: number | undefined;
  let until: number | undefined;
  if (hasCount) {
    count = Number(o.count);
    if (!Number.isInteger(count) || count < 1 || count > 366) {
      throw new RecurrenceError('count 必须是 1..366 的整数');
    }
  } else if (hasUntil) {
    const t =
      typeof o.until === 'number' ? o.until : Date.parse(String(o.until));
    if (!Number.isFinite(t)) {
      throw new RecurrenceError('until 不是合法时间');
    }
    until = t;
  } else {
    // 都不给 ⇒ 缺省 COUNT，防无界（明确写死，不靠"调用方自觉"）
    count = DEFAULT_COUNT;
  }

  // ── BYDAY（仅 WEEKLY；取值域校验）──
  let byDay: Weekday[] | undefined;
  if (o.byDay !== undefined && o.byDay !== null) {
    if (freq !== 'WEEKLY') {
      throw new RecurrenceError('byDay 仅适用于 WEEKLY');
    }
    const arr = Array.isArray(o.byDay) ? o.byDay : [o.byDay];
    const parsed = arr.map((d) => String(d).toUpperCase());
    for (const d of parsed) {
      if (!WEEKDAYS.includes(d as Weekday)) {
        throw new RecurrenceError(`byDay 非法取值 ${d}（仅 MO..SU）`);
      }
    }
    byDay = [...new Set(parsed)] as Weekday[];
    if (byDay.length === 0) throw new RecurrenceError('byDay 不能为空数组');
  }

  // ── BYMONTHDAY（仅 MONTHLY；1..31）──
  let byMonthDay: number[] | undefined;
  if (o.byMonthDay !== undefined && o.byMonthDay !== null) {
    if (freq !== 'MONTHLY') {
      throw new RecurrenceError('byMonthDay 仅适用于 MONTHLY');
    }
    const arr = Array.isArray(o.byMonthDay) ? o.byMonthDay : [o.byMonthDay];
    const parsed = arr.map((d) => Number(d));
    for (const d of parsed) {
      if (!Number.isInteger(d) || d < 1 || d > 31) {
        throw new RecurrenceError(`byMonthDay 非法取值 ${d}（仅 1..31）`);
      }
    }
    byMonthDay = [...new Set(parsed)].sort((a, b) => a - b);
  }

  return { freq, interval, byDay, byMonthDay, count, until };
}

/**
 * 从 DTSTART 起展开 occurrence（返回**真实时刻**毫秒数组，升序，最多 limit 个）
 *
 * @param startMs  系列起点（真实时刻毫秒）
 * @param rule     已解析规则
 * @param limit    最多返回个数（预览固定 5；落库按规则上限）
 * @param afterMs  只返回 **严格晚于** 该时刻的 occurrence（用于"从某点继续展开"）
 */
export function expandOccurrences(
  startMs: number,
  rule: RecurrenceRule,
  limit: number,
  afterMs?: number,
): number[] {
  if (limit <= 0) return [];
  const out: number[] = [];
  const startWall = toWall(startMs);
  const startY = startWall.getUTCFullYear();
  const startM = startWall.getUTCMonth() + 1; // 1..12
  const startD = startWall.getUTCDate();
  const startH = startWall.getUTCHours();
  const startMi = startWall.getUTCMinutes();
  const startS = startWall.getUTCSeconds();
  const startMsPart = startWall.getUTCMilliseconds();
  /** 按"上海墙上时间"拼回真实时刻 */
  const mk = (y: number, m: number, d: number): number =>
    fromWall(
      new Date(Date.UTC(y, m - 1, d, startH, startMi, startS, startMsPart)),
    );

  /** 是否已达 COUNT/UNTIL 上限（按**已产出数**与**上界时刻**双判） */
  let produced = 0;
  const stopped = (candidate: number): boolean =>
    rule.until !== undefined && candidate > rule.until;

  const push = (ms: number): boolean => {
    if (rule.until !== undefined && ms > rule.until) return true;
    // 🔴 COUNT 的语义是"自 DTSTART 起第 N 次"⇒ afterMs 过滤掉的 occurrence **同样计入** produced
    //    （否则 from-some-point 续展开会把系列延长成 >N 次，与人工日历不一致）
    produced += 1;
    if (afterMs === undefined || ms > afterMs) out.push(ms);
    return rule.count !== undefined && produced >= rule.count;
  };

  if (rule.freq === 'DAILY') {
    // 逐日推进：用 UTC 域日历加法（跨月/跨年自动正确）
    let y = startY;
    let m = startM;
    let d = startD;
    for (let i = 0; i < 366 * 4 && out.length < limit; i += 1) {
      const ms = mk(y, m, d);
      if (stopped(ms)) break;
      if (push(ms)) break;
      // +interval 天
      const next = new Date(Date.UTC(y, m - 1, d + rule.interval));
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
      d = next.getUTCDate();
      if (out.length >= limit) break;
    }
    return out;
  }

  if (rule.freq === 'WEEKLY') {
    // BYDAY 缺省 = DTSTART 星期几
    const startDow = startWall.getUTCDay();
    const dowSet = rule.byDay
      ? new Set(rule.byDay.map((d) => WEEKDAYS.indexOf(d)))
      : new Set([startDow]);
    // 以"DTSTART 所在周的周日"为锚，按周步进 interval
    let anchorY = startY;
    let anchorM = startM;
    let anchorD = startD - startDow; // 回退到本周周日
    for (let w = 0; w < 400 && out.length < limit; w += 1) {
      const weekStart = new Date(Date.UTC(anchorY, anchorM - 1, anchorD));
      for (const dow of [...dowSet].sort((a, b) => a - b)) {
        const day = new Date(
          Date.UTC(
            weekStart.getUTCFullYear(),
            weekStart.getUTCMonth(),
            weekStart.getUTCDate() + dow,
          ),
        );
        const ms = mk(
          day.getUTCFullYear(),
          day.getUTCMonth() + 1,
          day.getUTCDate(),
        );
        // 不得早于 DTSTART
        if (ms < startMs) continue;
        if (stopped(ms)) return out;
        if (push(ms)) return out;
        if (out.length >= limit) return out;
      }
      // 下一周（step = interval 周）
      const nextWeek = new Date(
        Date.UTC(
          weekStart.getUTCFullYear(),
          weekStart.getUTCMonth(),
          weekStart.getUTCDate() + 7 * rule.interval,
        ),
      );
      anchorY = nextWeek.getUTCFullYear();
      anchorM = nextWeek.getUTCMonth() + 1;
      anchorD = nextWeek.getUTCDate();
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    // BYMONTHDAY 缺省 = DTSTART 的日
    const daySet = rule.byMonthDay ?? [startD];
    let y = startY;
    let m = startM;
    for (let k = 0; k < 200 && out.length < limit; k += 1) {
      for (const targetDay of daySet) {
        // 🔴 短月夹紧：29/30/31 在短月落当月最后一天，绝无进位
        const d = clampDayToMonth(y, m, targetDay);
        const ms = mk(y, m, d);
        if (ms < startMs) continue;
        if (stopped(ms)) return out;
        if (push(ms)) return out;
        if (out.length >= limit) return out;
      }
      // +interval 月（用 UTC 日历加法，自动跨年）
      const next = new Date(Date.UTC(y, m - 1 + rule.interval, 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
    }
    return out;
  }

  // YEARLY：按年推进；2/29 起点的平年夹紧到 2/28
  let y = startY;
  for (let k = 0; k < 100 && out.length < limit; k += 1) {
    const d = clampDayToMonth(y, startM, startD);
    const ms = mk(y, startM, d);
    if (ms >= startMs) {
      if (stopped(ms)) return out;
      if (push(ms)) return out;
      if (out.length >= limit) return out;
    }
    y += rule.interval;
  }
  return out;
}

/**
 * 预览：从 `startMs` 起未来 `n` 次（卡面 §五.6 固定 n=5，人工与 AI 同源）
 * @param n 缺省 5（**不读调用方任意值**：卡面要求"恰为未来 5 次"）
 */
export function previewNext(
  startMs: number,
  rule: RecurrenceRule,
  n = 5,
): number[] {
  return expandOccurrences(startMs, rule, n);
}

/** 规则上限内可落库的 occurrence（COUNT 或 UNTIL 决定上限） */
export function expandForPersist(
  startMs: number,
  rule: RecurrenceRule,
): number[] {
  const cap = rule.count !== undefined ? rule.count : 366;
  return expandOccurrences(startMs, rule, Math.min(cap, 366));
}

/** 规范化输出（给工具/HTTP 的预览结果，ISO 字符串） */
export function occurrenceIso(list: number[]): string[] {
  return list.map((ms) => new Date(ms).toISOString());
}
