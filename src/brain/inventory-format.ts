/**
 * 库存数量「箱/基础单位」换算
 *
 * 将库存数量按商品规格自动换算为「N箱M瓶」等组合单位展示：
 * - 有规格（boxRatio > 1 且 boxUnit 存在）时：整数部分=箱数，余数=基础单位数
 * - 无规格或换算比为 1：直接输出数量+基础单位
 *
 * 规格字段来自 t_product_sku（box_ratio/box_unit/base_unit），
 * 由后端库存接口 listInventoryBalance 带出，AI 兜底摘要据此直接给出换算结果，
 * 例：数量 314、boxRatio 6、boxUnit 箱、baseUnit 瓶 → "52箱2瓶"。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */

/** 商品规格单位信息（来自 t_product_sku 的 box_ratio/box_unit/base_unit） */
export interface InventoryUnitInfo {
  boxRatio?: unknown;
  boxUnit?: unknown;
  baseUnit?: unknown;
}

/**
 * 按规格换算库存数量为「N箱M瓶」展示文本
 *
 * @param qty  库存数量（数字或数字字符串）
 * @param unit 规格单位信息（可选，缺省时仅输出数量）
 * @returns 换算后的展示文本
 */
export function formatInventoryQty(
  qty: unknown,
  unit?: InventoryUnitInfo | null,
): string {
  if (qty === null || qty === undefined) return '';
  const n = Number(qty);
  if (!Number.isFinite(n)) {
    return typeof qty === 'string' || typeof qty === 'number'
      ? String(qty)
      : '';
  }
  const baseUnit =
    typeof unit?.baseUnit === 'string' ? unit.baseUnit.trim() : '';
  const ratio = Number(unit?.boxRatio);
  const boxUnit =
    typeof unit?.boxUnit === 'string' && unit.boxUnit.trim().length > 0
      ? unit.boxUnit.trim()
      : '箱';

  // 库存量不可能为负，防御性兜底：负数按基础单位原样展示
  if (n < 0) return `${n}${baseUnit}`;

  // 有箱规格（换算比 > 1）时按「N箱M基础单位」展示
  if (Number.isFinite(ratio) && ratio > 1) {
    const boxes = Math.floor(n / ratio);
    const rest = n - boxes * ratio;
    if (boxes > 0 && rest > 0) return `${boxes}${boxUnit}${rest}${baseUnit}`;
    if (boxes > 0) return `${boxes}${boxUnit}`;
    return `${rest}${baseUnit}`;
  }

  // 无规格或换算比为 1：直接输出数量+基础单位
  return `${n}${baseUnit}`;
}
