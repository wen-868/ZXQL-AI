/**
 * UnitConverterService — 单位换算服务（R70-14 智能价格填充引擎）
 *
 * 核心规则（docs/ai-base/智享AI助手-写入操作规范.md 第四章）：
 * 单价永远以最小单位（瓶）为基准。用户说"箱"只换算数量，单价始终是瓶单价。
 *
 * 换算公式：
 *   总瓶数 = 箱数(boxQty) × 换算比(boxRatio) + 瓶数(bottleQty)
 *
 * 边界规则：
 * 1. boxRatio 未配置时默认按 1 处理（1箱=1瓶，即箱=瓶）
 * 2. boxQty 与 bottleQty 均为空时视为数量为 0（由调用方决定是否拦截）
 * 3. 数量必须为非负整数，负数/非数字直接判定无效
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import { Injectable } from '@nestjs/common';

/** 单位换算输入 */
export interface UnitConversionInput {
  /** 箱数（可选，与 bottleQty 组合使用） */
  boxQty?: number;
  /** 瓶数（可选，与 boxQty 组合使用） */
  bottleQty?: number;
  /** 换算比（1箱=N瓶，未配置时默认1） */
  boxRatio?: number;
}

/** 单位换算结果 */
export interface UnitConversionResult {
  /** 换算后的总瓶数 */
  totalBottleQty: number;
  /** 是否有效（数量非法时 false） */
  valid: boolean;
  /** 错误信息（无效时携带） */
  error?: string;
}

@Injectable()
export class UnitConverterService {
  /**
   * 箱+瓶 → 总瓶数
   *
   * 示例：
   * - "100箱" + boxRatio=6 → 600瓶
   * - "50瓶" → 50瓶
   * - "20件" + boxRatio=6 → 120瓶
   *
   * @param input 单位换算输入
   * @returns 换算结果（valid=false 时 totalBottleQty 恒为 0）
   */
  toBottleQty(input: UnitConversionInput): UnitConversionResult {
    const boxQty = input.boxQty ?? 0;
    const bottleQty = input.bottleQty ?? 0;

    // 数量必须为非负有限数字
    if (!this.isValidQty(boxQty) || !this.isValidQty(bottleQty)) {
      return {
        totalBottleQty: 0,
        valid: false,
        error: '数量必须为非负整数',
      };
    }

    // boxRatio 未配置或非法时默认 1（1箱=1瓶，兼容无换算比商品）
    const boxRatio =
      typeof input.boxRatio === 'number' && input.boxRatio > 0
        ? input.boxRatio
        : 1;

    const totalBottleQty = boxQty * boxRatio + bottleQty;

    if (totalBottleQty <= 0) {
      return {
        totalBottleQty: 0,
        valid: false,
        error: '箱数和瓶数不能同时为0',
      };
    }

    return { totalBottleQty, valid: true };
  }

  /**
   * 判断数量是否为有效的非负数字
   * 整数或小数均可（如 0.5 箱），但必须 ≥ 0 且为有限值
   */
  private isValidQty(value: number): boolean {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  }
}
