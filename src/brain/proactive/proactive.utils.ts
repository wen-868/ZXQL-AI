/**
 * 主动能力模块 — 公共工具函数
 *
 * 用于将数据库行（Row = Record<string, unknown>）字段安全转换为强类型值。
 * 数据库返回的 DECIMAL/INT 可能是 number 或 string（mysql2 配置不同），
 * 统一经过 toNumber/toText 转换，避免类型断言出错。
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-02
 */

/**
 * 安全转换为数字
 *
 * @param value    原始值（number / string / null / undefined）
 * @param fallback 转换失败时的兜底值，默认 0
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * 安全转换为字符串
 *
 * @param value    原始值
 * @param fallback 转换失败时的兜底值，默认空字符串
 */
export function toText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    return value;
  }
  // number / boolean / bigint 均为安全的 base type，String() 不触发 no-base-to-string
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  // Date 使用自定义 toString，保留输出（toDateText 会单独按 ISO 日期处理）
  if (value instanceof Date) {
    return value.toString();
  }
  // 普通对象/函数/symbol 无展示价值，直接兜底
  return fallback;
}

/**
 * 安全转换为日期字符串（YYYY-MM-DD 格式，供推送内容展示）
 *
 * 数据库 DATETIME/DATE 字段可能是 Date 对象或字符串，统一转为日期部分。
 *
 * @param value 原始值
 * @returns 日期字符串（如 2026-07-15），无法解析时返回 fallback
 */
export function toDateText(value: unknown, fallback = ''): string {
  const text = toText(value);
  if (!text) {
    return fallback;
  }
  // Date 对象转 ISO 字符串后取日期部分
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  // 字符串："2026-07-15T00:00:00.000Z" 或 "2026-07-15 00:00:00"
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : fallback;
}

/**
 * 将金额数字格式化为千分位字符串（如 18500 → "18,500"）
 *
 * @param value 金额数值
 */
export function toMoneyText(value: number): string {
  const rounded = Math.round(value);
  const negative = rounded < 0;
  const abs = Math.abs(rounded).toString();
  const parts: string[] = [];
  for (let i = abs.length; i > 0; i -= 3) {
    parts.unshift(abs.slice(Math.max(0, i - 3), i));
  }
  return (negative ? '-' : '') + parts.join(',');
}
