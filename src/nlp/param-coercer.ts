/**
 * Param Coercer — LLM 参数自纠错（精准度优化）
 *
 * LLM function calling 常见问题：数字传成字符串（"10" 而非 10）、
 * 布尔传成 "true"/"是"、枚举大小写/口语化。本模块在工具 parseArgs
 * 前做宽松归一化，减少"参数类型错误"类失败。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-17
 */

/**
 * 将任意值按目标类型宽松转换
 *
 * - number：数字/数字字符串/中文数字 → number；无法转换返回原值
 * - boolean："true"/"false"/"是"/"否"/"1"/"0"/true/false → boolean
 * - string：原样
 */
export function coerceParam<T>(
  value: unknown,
  type: 'number' | 'boolean' | 'string',
): T | undefined {
  if (value === undefined || value === null) return undefined;

  if (type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value as T;
    if (typeof value === 'string') {
      const n = Number(value.trim());
      if (Number.isFinite(n)) return n as T;
      // 中文数字
      const CN: Record<string, number> = {
        一: 1,
        二: 2,
        两: 2,
        三: 3,
        四: 4,
        五: 5,
        六: 6,
        七: 7,
        八: 8,
        九: 9,
        十: 10,
      };
      if (value.trim() in CN) return CN[value.trim()] as T;
    }
    return value as T; // 保持原值，让调用方校验
  }

  if (type === 'boolean') {
    if (typeof value === 'boolean') return value as T;
    if (typeof value === 'string') {
      const t = value.trim().toLowerCase();
      if (['true', '1', '是', 'yes', '要'].includes(t)) return true as T;
      if (['false', '0', '否', 'no', '不要'].includes(t)) return false as T;
    }
    return value as T;
  }

  return value as T;
}

/**
 * 宽松数字：能转 number 就转，否则 undefined
 * （供 boxQty/bottleQty 等"非负整数"字段使用，避免字符串被拒）
 */
export function toPositiveInt(value: unknown): number | undefined {
  const n = coerceParam<number>(value, 'number');
  if (typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/** 宽松非负整数（可为 0，如 minAmount/totalCount） */
export function toNonNegativeInt(value: unknown): number | undefined {
  const n = coerceParam<number>(value, 'number');
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/** 宽松非负数（金额等，可为小数） */
export function toNonNegativeNumber(value: unknown): number | undefined {
  const n = coerceParam<number>(value, 'number');
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return n;
}
