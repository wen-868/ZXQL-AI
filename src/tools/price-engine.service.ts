/**
 * PriceEngineService — 智能价格填充引擎（R70-14）
 *
 * 核心规则（docs/ai-base/智享AI助手-写入操作规范.md 第三章）：
 * 1. 价格优先级：用户指定价 > 合同价 > 客户类型对应价
 * 2. 客户类型 → 价格等级映射：
 *    - WHOLESALE（批发客户）→ wholesalePrice（批发价）
 *    - CASH（散客/零售）→ retailPrice（零售价）
 *    - VIP（VIP客户）→ vipPrice（VIP价，缺省时用零售价九折）
 *    - 未分类/新客户 → retailPrice（默认零售价）
 * 3. 价格安全校验（只提示不拦截）：
 *    - 售价 < 进价(costPrice) → ⚠️ 警告
 *    - 售价 < 最低限价(minPrice) → ⚠️ 警告
 *    - 售价 = 0 → 🚫 阻止执行
 * 4. 价格来源标注：预览中标注"已自动应用批发客户价格"等来源说明
 *
 * 本服务为独立可复用引擎，供 createSalesOrder / createPurchaseOrder
 * 等写操作工具注入使用，统一价格填充逻辑，避免各工具重复实现。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import { Injectable } from '@nestjs/common';

/** 商品价格信息（来自 searchProduct 工具返回的 productInfo） */
export interface ProductPriceInfo {
  /** 箱瓶换算比（1箱=N瓶） */
  boxRatio?: number;
  /** 零售价（每瓶） */
  retailPrice?: number;
  /** 批发价（每瓶） */
  wholesalePrice?: number;
  /** 门店价（每瓶） */
  storePrice?: number;
  /** VIP价（每瓶，可选） */
  vipPrice?: number;
  /** 进价/采购价（每瓶） */
  costPrice?: number;
  /** 最低限价（每瓶，可选） */
  minPrice?: number;
}

/** 价格解析结果 */
export interface PriceResolution {
  /** 最终采用的单价（始终是瓶单价） */
  unitPrice: number;
  /** 价格来源标注（预览展示用，如"已自动应用批发客户价格"） */
  priceSource: string;
  /** 警告信息（低于进价/最低限价时生成，不阻止执行） */
  warning?: string;
  /** 是否被阻止（零价格或无价格信息时 true） */
  blocked: boolean;
  /** 阻止原因（blocked=true 时携带） */
  error?: string;
}

/** 销售价格解析输入 */
export interface SalesPriceInput {
  /** 用户指定价（最高优先级，可选） */
  userUnitPrice?: number;
  /** 购买总数量（瓶，可选）：用于判断用户给的是单价还是总价 */
  totalQty?: number;
  /** 合同价（次优先级，可选） */
  contractPrice?: number;
  /** 客户类型（WHOLESALE/CASH/VIP，决定价格等级） */
  customerType?: string;
  /** 商品价格信息（从 searchProduct 获取） */
  productInfo?: ProductPriceInfo;
  /** 商品名称（用于警告/错误文案） */
  skuName?: string;
}

/** 采购进价解析输入 */
export interface PurchasePriceInput {
  /** 用户指定价（最高优先级，可选） */
  userUnitPrice?: number;
  /** 商品价格信息（从 searchProduct 获取，含系统默认进价） */
  productInfo?: ProductPriceInfo;
  /** 商品名称（用于警告/错误文案） */
  skuName?: string;
}

/** 销售客户类型常量 */
export const SALES_CUSTOMER_TYPES = ['WHOLESALE', 'CASH', 'VIP'] as const;

@Injectable()
export class PriceEngineService {
  /**
   * 解析销售单价
   *
   * 优先级：用户指定价 > 合同价 > 客户类型对应价
   *
   * @param input 销售价格解析输入
   * @returns 解析结果（blocked=true 时 unitPrice 恒为 0）
   */
  resolveSalesPrice(input: SalesPriceInput): PriceResolution {
    const skuName = input.skuName ?? `商品`;

    // ── 1. 用户指定价优先 ──
    if (input.userUnitPrice !== undefined) {
      if (this.isValidPositivePrice(input.userUnitPrice)) {
        // 价格语义判断：用户给的价格明显是"总价"（>= 系统单价×数量×0.7）时自动折算为单价
        const totalQty = input.totalQty;
        const systemUnit =
          input.productInfo?.retailPrice ??
          input.productInfo?.wholesalePrice ??
          input.productInfo?.storePrice;
        if (
          totalQty !== undefined &&
          totalQty > 1 &&
          systemUnit !== undefined &&
          systemUnit > 0 &&
          input.userUnitPrice >= systemUnit * totalQty * 0.7
        ) {
          const derivedUnit = input.userUnitPrice / totalQty;
          return this.buildResolution({
            unitPrice: derivedUnit,
            priceSource: '用户总价÷数量',
            input,
            skuName,
            warning: `识别为总价 ${input.userUnitPrice} 元，按 ${totalQty} 瓶折算单价 ${derivedUnit.toFixed(2)} 元/瓶`,
          });
        }
        return this.buildResolution({
          unitPrice: input.userUnitPrice,
          priceSource: '用户指定价',
          input,
          skuName,
        });
      }
      // 用户明确指定了价格但为0或非法 → 阻止执行（金额不能为0）
      return {
        unitPrice: 0,
        priceSource: '零价格',
        blocked: true,
        error: `${skuName} 单价为0或非法，无法执行`,
      };
    }

    // ── 2. 合同价次之 ──
    if (this.isValidPositivePrice(input.contractPrice)) {
      return this.buildResolution({
        unitPrice: input.contractPrice,
        priceSource: '已自动应用合同价格',
        input,
        skuName,
      });
    }

    // ── 3. 按客户类型自动匹配 ──
    const matched = this.matchByCustomerType(
      input.customerType,
      input.productInfo,
    );
    if (matched) {
      return this.buildResolution({
        unitPrice: matched.price,
        priceSource: matched.source,
        input,
        skuName,
      });
    }

    // ── 4. 无可用价格 ──
    return {
      unitPrice: 0,
      priceSource: '无价格',
      blocked: true,
      error: `${skuName} 无可用价格信息，请通过 searchProduct 获取或手动指定 unitPrice`,
    };
  }

  /**
   * 解析采购进价
   *
   * 优先级：用户指定价 > 系统默认进价(costPrice)
   * 采购场景：进价低于系统进价属正常议价，仅提示不拦截。
   *
   * @param input 采购进价解析输入
   * @returns 解析结果（blocked=true 时 unitPrice 恒为 0）
   */
  resolvePurchasePrice(input: PurchasePriceInput): PriceResolution {
    const skuName = input.skuName ?? `商品`;

    // ── 1. 用户指定价优先 ──
    if (input.userUnitPrice !== undefined) {
      if (this.isValidPositivePrice(input.userUnitPrice)) {
        return this.buildResolution({
          unitPrice: input.userUnitPrice,
          priceSource: '用户指定价',
          input,
          skuName,
        });
      }
      // 用户明确指定了价格但为0或非法 → 阻止执行
      return {
        unitPrice: 0,
        priceSource: '零价格',
        blocked: true,
        error: `${skuName} 单价为0或非法，无法执行`,
      };
    }

    // ── 2. 使用系统默认进价 ──
    const costPrice = input.productInfo?.costPrice;
    if (this.isValidPositivePrice(costPrice)) {
      return this.buildResolution({
        unitPrice: costPrice,
        priceSource: '系统默认进价',
        input,
        skuName,
      });
    }

    // ── 3. 无可用进价 ──
    return {
      unitPrice: 0,
      priceSource: '无价格',
      blocked: true,
      error: `${skuName} 无进价信息，请通过 searchProduct 获取或手动指定 unitPrice`,
    };
  }

  // ── 私有方法 ──

  /** 判断是否为有效的正价格（>0 且为有限数字） */
  private isValidPositivePrice(price: number | undefined): price is number {
    return typeof price === 'number' && Number.isFinite(price) && price > 0;
  }

  /**
   * 按客户类型匹配价格等级
   *
   * @param customerType 客户类型（WHOLESALE/CASH/VIP）
   * @param productInfo  商品价格信息
   * @returns 匹配结果（无匹配时返回 null）
   */
  private matchByCustomerType(
    customerType: string | undefined,
    productInfo: ProductPriceInfo | undefined,
  ): { price: number; source: string } | null {
    if (!productInfo) {
      return null;
    }

    switch (customerType) {
      case 'WHOLESALE':
        // 批发客户优先批发价，缺省降级零售价
        if (this.isValidPositivePrice(productInfo.wholesalePrice)) {
          return {
            price: productInfo.wholesalePrice,
            source: '已自动应用批发客户价格',
          };
        }
        if (this.isValidPositivePrice(productInfo.retailPrice)) {
          return {
            price: productInfo.retailPrice,
            source: '批发价未设置，已降级为零售价',
          };
        }
        return null;

      case 'VIP':
        // VIP客户优先VIP价，缺省用零售价九折
        if (this.isValidPositivePrice(productInfo.vipPrice)) {
          return {
            price: productInfo.vipPrice,
            source: '已自动应用VIP客户价格',
          };
        }
        if (this.isValidPositivePrice(productInfo.retailPrice)) {
          const vipPrice =
            Math.round(productInfo.retailPrice * 0.9 * 100) / 100;
          return {
            price: vipPrice,
            source: '已自动应用VIP客户价格（零售价九折）',
          };
        }
        return null;

      case 'CASH':
      default:
        // 零售客户优先零售价，缺省降级门店价
        if (this.isValidPositivePrice(productInfo.retailPrice)) {
          return {
            price: productInfo.retailPrice,
            source: '已自动应用零售价格',
          };
        }
        if (this.isValidPositivePrice(productInfo.storePrice)) {
          return {
            price: productInfo.storePrice,
            source: '零售价未设置，已降级为门店价',
          };
        }
        return null;
    }
  }

  /** 构建解析结果：统一执行价格安全校验 */
  private buildResolution(options: {
    unitPrice: number;
    priceSource: string;
    input: SalesPriceInput | PurchasePriceInput;
    skuName: string;
    warning?: string;
  }): PriceResolution {
    const { unitPrice, priceSource, input, skuName, warning } = options;

    // 零价格：阻止执行（金额不能为0）
    if (unitPrice <= 0) {
      return {
        unitPrice: 0,
        priceSource: '零价格',
        blocked: true,
        error: `${skuName} 单价为0，无法执行`,
      };
    }

    const resolution: PriceResolution = {
      unitPrice,
      priceSource,
      blocked: false,
      warning,
    };

    // 低于进价 → 警告（不拦截）
    const costPrice = input.productInfo?.costPrice;
    if (this.isValidPositivePrice(costPrice) && unitPrice < costPrice) {
      resolution.warning = `${skuName} 的单价 ${unitPrice} 低于进价 ${costPrice}，可能造成亏损`;
    }

    // 低于最低限价 → 警告（不拦截）
    const minPrice = input.productInfo?.minPrice;
    if (this.isValidPositivePrice(minPrice) && unitPrice < minPrice) {
      resolution.warning =
        (resolution.warning ? resolution.warning + '；' : '') +
        `${skuName} 的单价 ${unitPrice} 低于最低限价 ${minPrice}`;
    }

    return resolution;
  }
}
