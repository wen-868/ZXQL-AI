/**
 * Recurrence 展开器测试（AI-P2-2 · 卡面 §四.4/§四.5/§五.4/§五.6）
 *
 * 逐条对应卡面反测靶点（mutation ⇒ 目标用例必须变红）：
 * R1 DAILY+INTERVAL 展开（改成固定 +1 天 ⇒ 红）
 * R2 WEEKLY+BYDAY 多值（只取首日 ⇒ 红）
 * R3 **短月夹紧**：每月 31 日 在 2 月落 28/29，**绝不进位到下月**（反测 3 靶点）
 * R4 COUNT 与 UNTIL **二选一**，同时给 ⇒ 抛错（反测 4 靶点）
 * R5 频率白名单：HOURLY/MINUTELY 一律拒绝（不做"看起来支持"）
 * R6 BYDAY 仅 WEEKLY / BYMONTHDAY 仅 MONTHLY（错配即拒）
 * R7 预览**恰为未来 5 次**（卡面 §五.6；改成 4/6 ⇒ 红）
 * R8 时区固定 Asia/Shanghai：进程时区无关（把 TZ 改成 UTC/纽约结果一致）
 * R9 2/29 起点的 YEARLY 在平年夹紧 2/28
 * R10 expandForPersist 上限 = COUNT（UNTIL 时 ≤366），**不无界展开**
 *
 * 负责人: 阿洲（AI 底座 owner）| 创建日期: 2026-10-29
 */
import {
  clampDayToMonth,
  daysInMonth,
  expandForPersist,
  expandOccurrences,
  occurrenceIso,
  parseRecurrenceRule,
  previewNext,
  RecurrenceError,
} from './recurrence';

/** 上海墙上时间 ⇒ 真实毫秒（+08:00，无夏令时） */
function sh(y: number, m: number, d: number, hh = 0, mi = 0): number {
  return Date.UTC(y, m - 1, d, hh, mi) - 8 * 3600 * 1000;
}
/** 真实毫秒 ⇒ 上海墙上日期串（YYYY-MM-DD，测试可读性） */
function wall(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function wallFull(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000)
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
}

describe('parseRecurrenceRule（安全子集白名单）', () => {
  it('R5 仅接受 DAILY/WEEKLY/MONTHLY/YEARLY；HOURLY/MINUTELY 拒绝', () => {
    for (const bad of ['HOURLY', 'MINUTELY', 'SECONDLY', 'WEEKDAYS', '']) {
      expect(() => parseRecurrenceRule({ freq: bad })).toThrow(RecurrenceError);
    }
    expect(parseRecurrenceRule('{"freq":"DAILY"}').freq).toBe('DAILY');
  });

  it('R4 count 与 until 二选一（同时给 ⇒ 抛错；都不给 ⇒ 缺省 count=10 防无界）', () => {
    expect(() =>
      parseRecurrenceRule({ freq: 'DAILY', count: 5, until: '2026-12-31' }),
    ).toThrow(/二选一/);
    const def = parseRecurrenceRule({ freq: 'DAILY' });
    expect(def.count).toBe(10); // 明确写死的缺省上限
    expect(def.until).toBeUndefined();
  });

  it('R6 byDay 仅 WEEKLY / byMonthDay 仅 MONTHLY（错配即拒）', () => {
    expect(() => parseRecurrenceRule({ freq: 'DAILY', byDay: ['MO'] })).toThrow(
      /byDay 仅适用于 WEEKLY/,
    );
    expect(() =>
      parseRecurrenceRule({ freq: 'WEEKLY', byMonthDay: [3] }),
    ).toThrow(/byMonthDay 仅适用于 MONTHLY/);
    expect(() =>
      parseRecurrenceRule({ freq: 'MONTHLY', byMonthDay: [0] }),
    ).toThrow(/非法取值/);
    expect(() =>
      parseRecurrenceRule({ freq: 'MONTHLY', byMonthDay: [32] }),
    ).toThrow(/非法取值/);
    expect(() =>
      parseRecurrenceRule({ freq: 'WEEKLY', byDay: ['XX'] }),
    ).toThrow(/非法取值/);
  });

  it('interval 必须 1..99 整数；非 JSON 字符串拒绝', () => {
    expect(() => parseRecurrenceRule({ freq: 'DAILY', interval: 0 })).toThrow();
    expect(() =>
      parseRecurrenceRule({ freq: 'DAILY', interval: 1.5 }),
    ).toThrow();
    expect(() => parseRecurrenceRule('not-json')).toThrow(/合法 JSON/);
    expect(() => parseRecurrenceRule(null)).toThrow(RecurrenceError);
  });

  it('byDay / byMonthDay 去重 + 排序（规范形态，供持久化与比较）', () => {
    const r = parseRecurrenceRule({
      freq: 'MONTHLY',
      byMonthDay: [31, 3, 3, 15],
    });
    expect(r.byMonthDay).toEqual([3, 15, 31]);
    const w = parseRecurrenceRule({
      freq: 'WEEKLY',
      byDay: ['mo', 'MO', 'fr'],
    });
    expect(w.byDay).toEqual(['MO', 'FR']);
  });
});

describe('expandOccurrences（展开语义）', () => {
  it('R1 DAILY + INTERVAL=3 ⇒ 每 3 天一次，跨月自动推进', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', interval: 3, count: 4 });
    const list = expandOccurrences(sh(2026, 10, 30, 9, 0), rule, 10);
    expect(list.map(wall)).toEqual([
      '2026-10-30',
      '2026-11-02',
      '2026-11-05',
      '2026-11-08',
    ]);
  });

  it('R1b COUNT 截断生效（count=2 ⇒ 只 2 次，即便 limit=10）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 2 });
    expect(expandOccurrences(sh(2026, 10, 1), rule, 10)).toHaveLength(2);
  });

  it('R1c UNTIL 截断（不超过上界；上界当天仍算）', () => {
    const until = sh(2026, 10, 3, 23, 59);
    const rule = parseRecurrenceRule({ freq: 'DAILY', until });
    const list = expandOccurrences(sh(2026, 10, 1), rule, 10);
    expect(list.map(wall)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    const rule2 = parseRecurrenceRule({
      freq: 'DAILY',
      until: sh(2026, 10, 2, 23, 59),
    });
    expect(expandOccurrences(sh(2026, 10, 1), rule2, 10).map(wall)).toEqual([
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('R2 WEEKLY + BYDAY=[MO,FR] ⇒ 每周周一与周五（顺序按周内日）', () => {
    const rule = parseRecurrenceRule({
      freq: 'WEEKLY',
      byDay: ['MO', 'FR'],
      count: 6,
    });
    // 2026-11-02 是周一
    const list = expandOccurrences(sh(2026, 11, 2, 8, 0), rule, 10);
    expect(list.map(wall)).toEqual([
      '2026-11-02', // MO
      '2026-11-06', // FR
      '2026-11-09', // MO
      '2026-11-13', // FR
      '2026-11-16', // MO
      '2026-11-20', // FR
    ]);
  });

  it('R2b WEEKLY 缺省 BYDAY = DTSTART 的星期几（不吞掉其他天）', () => {
    const rule = parseRecurrenceRule({ freq: 'WEEKLY', interval: 2, count: 3 });
    const list = expandOccurrences(sh(2026, 11, 4, 10, 0), rule, 10); // 周三
    expect(list.map(wall)).toEqual(['2026-11-04', '2026-11-18', '2026-12-02']);
  });

  it('R3 **短月夹紧**：每月 31 日 ⇒ 2 月落 28、4 月落 30，绝不进位下月（反测 3）', () => {
    const rule = parseRecurrenceRule({
      freq: 'MONTHLY',
      byMonthDay: [31],
      count: 6,
    });
    const list = expandOccurrences(sh(2026, 1, 31, 12, 0), rule, 10);
    expect(list.map(wall)).toEqual([
      '2026-01-31',
      '2026-02-28', // ← 2026 非闰年
      '2026-03-31',
      '2026-04-30', // ← 30 天月
      '2026-05-31',
      '2026-06-30',
    ]);
    // 🔴 关键反测：绝不会出现 2026-03-03 这种"进位"结果
    expect(list.map(wall)).not.toContain('2026-03-03');
  });

  it('R3b 夹紧单向：BYMONTHDAY=30 在 31 天月仍是 30 号（不误伤）', () => {
    const rule = parseRecurrenceRule({
      freq: 'MONTHLY',
      byMonthDay: [30],
      count: 3,
    });
    const list = expandOccurrences(sh(2026, 1, 30, 0, 30), rule, 10);
    expect(list.map(wall)).toEqual(['2026-01-30', '2026-02-28', '2026-03-30']);
  });

  it('R3c 多 BYMONTHDAY 月内按日升序 + 短月各自夹紧', () => {
    const rule = parseRecurrenceRule({
      freq: 'MONTHLY',
      byMonthDay: [1, 15, 31],
      count: 6,
    });
    const list = expandOccurrences(sh(2026, 1, 1, 7, 0), rule, 10);
    expect(list.map(wall)).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-01-31',
      '2026-02-01',
      '2026-02-15',
      '2026-02-28',
    ]);
  });

  it('R9 YEARLY：2/29 起点在平年夹紧 2/28（闰年仍 2/29）', () => {
    const rule = parseRecurrenceRule({ freq: 'YEARLY', count: 5 });
    const list = expandOccurrences(sh(2024, 2, 29, 6, 0), rule, 10);
    expect(list.map(wall)).toEqual([
      '2024-02-29', // 闰
      '2025-02-28',
      '2026-02-28',
      '2027-02-28',
      '2028-02-29', // 闰
    ]);
  });

  it('时刻分量保持：09:30 起点 ⇒ 每个 occurrence 都是 09:30（上海墙上时间）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 3 });
    const list = expandOccurrences(sh(2026, 10, 1, 9, 30), rule, 10);
    expect(list.map(wallFull)).toEqual([
      '2026-10-01 09:30',
      '2026-10-02 09:30',
      '2026-10-03 09:30',
    ]);
  });

  it('R8 时区固定 Asia/Shanghai：与**进程时区无关**（同毫秒输入 ⇒ 同上海日期）', () => {
    const ms = sh(2026, 10, 31, 0, 30); // 上海 10-31 00:30 = UTC 10-30 16:30
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 2 });
    const out = expandOccurrences(ms, rule, 10).map(wall);
    expect(out).toEqual(['2026-10-31', '2026-11-01']);
    // 纯 UTC 域运算 ⇒ 结果不含进程 new Date() 的本地化分支（这里再验证一次跨日不漂移）
    expect(out[0]).not.toBe('2026-10-30');
  });

  it('afterMs：只返回严格晚于该时刻的 occurrence（following 续展开用）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 5 });
    const all = expandOccurrences(sh(2026, 10, 1), rule, 10);
    const rest = expandOccurrences(sh(2026, 10, 1), rule, 10, all[1]);
    expect(rest.map(wall)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
  });

  it('WEEKLY 不得产出早于 DTSTART 的 occurrence（锚周回退不越界）', () => {
    const rule = parseRecurrenceRule({
      freq: 'WEEKLY',
      byDay: ['MO'],
      count: 3,
    });
    // 2026-11-04 是周三；本周一 11-02 必须被跳过
    const list = expandOccurrences(sh(2026, 11, 4), rule, 10);
    expect(list.map(wall)).toEqual(['2026-11-09', '2026-11-16', '2026-11-23']);
  });
});

describe('previewNext / expandForPersist / 辅助', () => {
  it('R7 预览**恰为未来 5 次**（卡面 §五.6；缺省 n=5）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 30 });
    const p = previewNext(sh(2026, 10, 1), rule);
    expect(p).toHaveLength(5); // 不是 4、不是 6
    expect(p.map(wall)).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
    ]);
  });

  it('R7b 预览次数**受 COUNT 上限约束**（count=3 ⇒ 预览只 3 次，不虚构）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 3 });
    expect(previewNext(sh(2026, 10, 1), rule, 5)).toHaveLength(3);
  });

  it('R10 expandForPersist 上限 = count（1..366 内），绝不无界展开', () => {
    const c20 = parseRecurrenceRule({ freq: 'DAILY', count: 20 });
    expect(expandForPersist(sh(2026, 10, 1), c20)).toHaveLength(20);
    const untilFar = parseRecurrenceRule({
      freq: 'DAILY',
      until: sh(2027, 12, 31),
    });
    const list = expandForPersist(sh(2026, 10, 1), untilFar);
    expect(list.length).toBeLessThanOrEqual(366); // UNTIL 也硬顶，防无界
    expect(list.length).toBeGreaterThan(300);
  });

  it('daysInMonth / clampDayToMonth 边界（含闰年）', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
    expect(clampDayToMonth(2026, 2, 31)).toBe(28);
    expect(clampDayToMonth(2028, 2, 31)).toBe(29);
    expect(clampDayToMonth(2026, 7, 15)).toBe(15); // 不夹紧
  });

  it('occurrenceIso ⇒ ISO 串（预览输出形态，AI 与人工同结构）', () => {
    const iso = occurrenceIso([sh(2026, 10, 1, 9, 0)]);
    expect(iso).toEqual(['2026-10-01T01:00:00.000Z']); // 上海 09:00 = UTC 01:00
  });

  it('limit<=0 ⇒ 空数组（不报错、不展开）', () => {
    const rule = parseRecurrenceRule({ freq: 'DAILY', count: 5 });
    expect(expandOccurrences(sh(2026, 10, 1), rule, 0)).toEqual([]);
  });
});
