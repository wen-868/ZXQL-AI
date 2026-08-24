/**
 * ai_db 脱敏工具（P1-1）
 *
 * 依据：权威文档 26.6.1 跨租户脱敏聚合三步：
 * 1. 字段级遮蔽：PII（手机/身份证/金额精确值）抹除，仅保留类型与量级
 * 2. input_hash 去标识：以输入指纹去重，去除可直接识别上下文（客户名/单号）
 * 3. 行业归并（在聚合层执行，按 行业×任务类型 沉淀模式）
 *
 * 本模块负责字段级遮蔽 + 输入指纹，均为确定性字符串/数值处理（非正则字段抽取）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { createHash } from 'crypto';

/** 需完全遮蔽的标识类字段键（精确匹配，避免误伤 tool_name 等） */
const IDENTITY_KEYS = [
  'name',
  'customername',
  'customer',
  'supplier',
  'suppliername',
  'orderno',
  'billno',
  'returnno',
  'sourceno',
  'storename',
  'productname',
  'skuname',
  'remark',
];

/** 手机号字段键 */
const PHONE_KEYS = ['phone', 'mobile', 'tel'];

/** 金额字段键（仅保留量级） */
const MONEY_KEYS = [
  'price',
  'amount',
  'money',
  'total',
  'cost',
  'fee',
  'limit',
  'unitPrice',
  'newPrice',
];

/**
 * 递归脱敏 JSON 值：
 * - 标识字段 → '***'
 * - 手机字段 → 138****0000
 * - 金额字段 → 保留量级（百/千位取整）
 * - 其他字符串 → 截断超长
 */
export function sanitizeJson(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 500 ? `${value.slice(0, 500)}…[截断]` : value;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJson(item, depth + 1));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(record)) {
      const lower = key.toLowerCase();
      if (PHONE_KEYS.some((k) => lower.includes(k))) {
        out[key] = maskPhone(String(val));
      } else if (MONEY_KEYS.some((k) => lower.includes(k))) {
        out[key] = maskAmount(val);
      } else if (IDENTITY_KEYS.includes(lower)) {
        out[key] = '***';
      } else {
        out[key] = sanitizeJson(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/** 手机号遮蔽：13800000000 → 138****0000（非 11 位数字原样返回） */
export function maskPhone(text: string): string {
  const digits = text.replace(/\D/g, '');
  if (digits.length !== 11) {
    return '***';
  }
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

/** 金额量级化：>10000 千位取整；>100 百位取整；否则原样（保留"量级"而非精确值） */
export function maskAmount(value: unknown): unknown {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return value;
  }
  const abs = Math.abs(n);
  if (abs >= 10000) {
    return Math.round(n / 1000) * 1000;
  }
  if (abs >= 100) {
    return Math.round(n / 100) * 100;
  }
  return n;
}

/** 输入脱敏指纹：MD5(输入)，去重聚合且不可还原 */
export function hashInput(input: string): string {
  return createHash('md5')
    .update(input ?? '')
    .digest('hex');
}

/** 工具调用链路 → 脱敏轨迹 JSON 字符串（采集用） */
export function toTrajectory(
  toolCalls: Array<Record<string, unknown>> | undefined,
): string | null {
  if (!toolCalls || toolCalls.length === 0) {
    return null;
  }
  return JSON.stringify(sanitizeJson(toolCalls));
}
