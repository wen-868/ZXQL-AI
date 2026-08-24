/**
 * R70-14 智能价格填充引擎单元测试
 *
 * 测试覆盖：
 * 1. UnitConverterService — 箱→瓶换算 + 边界校验
 * 2. PriceEngineService.resolveSalesPrice — 价格优先级 + 客户类型匹配 + 安全校验
 * 3. PriceEngineService.resolvePurchasePrice — 采购进价填充
 *
 * 验收标准覆盖：
 * - 批发客户自动匹配批发价 ✅
 * - "100箱"自动换算为600瓶 ✅
 * - 低于进货价时生成警告 ✅
 * - 价格来源标注"已自动应用批发客户价格" ✅
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-02
 */
import { PriceEngineService } from './price-engine.service';
import { UnitConverterService } from './unit-converter.service';

describe('R70-14 智能价格填充引擎', () => {
  // ── 1. UnitConverterService ──
  describe('UnitConverterService', () => {
    let converter: UnitConverterService;

    beforeAll(() => {
      converter = new UnitConverterService();
    });

    it('"100箱" + boxRatio=6 应换算为600瓶', () => {
      const result = converter.toBottleQty({ boxQty: 100, boxRatio: 6 });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(600);
    });

    it('"50瓶" 应换算为50瓶（瓶数不换算）', () => {
      const result = converter.toBottleQty({ bottleQty: 50 });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(50);
    });

    it('"20件" + boxRatio=6 应换算为120瓶', () => {
      const result = converter.toBottleQty({ boxQty: 20, boxRatio: 6 });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(120);
    });

    it('箱+瓶组合：3箱6瓶 + boxRatio=12 应换算为42瓶', () => {
      const result = converter.toBottleQty({
        boxQty: 3,
        bottleQty: 6,
        boxRatio: 12,
      });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(42);
    });

    it('boxRatio 缺失时默认按1处理（1箱=1瓶）', () => {
      const result = converter.toBottleQty({ boxQty: 10 });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(10);
    });

    it('boxRatio 为0或负数时默认按1处理', () => {
      const result = converter.toBottleQty({ boxQty: 10, boxRatio: 0 });
      expect(result.valid).toBe(true);
      expect(result.totalBottleQty).toBe(10);
    });

    it('箱数和瓶数同时为0应判定无效', () => {
      const result = converter.toBottleQty({ boxQty: 0, bottleQty: 0 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('0');
    });

    it('负数量应判定无效', () => {
      const result = converter.toBottleQty({ boxQty: -1 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('非负');
    });
  });

  // ── 2. PriceEngineService.resolveSalesPrice ──
  describe('PriceEngineService.resolveSalesPrice', () => {
    let engine: PriceEngineService;

    beforeAll(() => {
      engine = new PriceEngineService();
    });

    const productInfo = {
      boxRatio: 6,
      retailPrice: 1200,
      wholesalePrice: 980,
      storePrice: 1100,
      costPrice: 850,
    };

    it('批发客户自动匹配批发价，并标注价格来源（验收标准）', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'WHOLESALE',
        productInfo,
        skuName: '五粮液',
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(980);
      expect(result.priceSource).toContain('批发');
    });

    it('零售客户自动匹配零售价', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'CASH',
        productInfo,
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1200);
      expect(result.priceSource).toContain('零售');
    });

    it('VIP客户优先使用VIP价', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'VIP',
        productInfo: { ...productInfo, vipPrice: 1050 },
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1050);
      expect(result.priceSource).toContain('VIP');
    });

    it('VIP客户无VIP价时使用零售价九折', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'VIP',
        productInfo,
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1080); // 1200 * 0.9
      expect(result.priceSource).toContain('九折');
    });

    it('用户指定价 > 客户类型对应价（用户指定价优先）', () => {
      const result = engine.resolveSalesPrice({
        userUnitPrice: 1100,
        customerType: 'WHOLESALE',
        productInfo,
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1100);
      expect(result.priceSource).toBe('用户指定价');
    });

    it('合同价 > 客户类型对应价（合同价次之）', () => {
      const result = engine.resolveSalesPrice({
        contractPrice: 1000,
        customerType: 'WHOLESALE',
        productInfo,
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1000);
      expect(result.priceSource).toContain('合同');
    });

    it('批发价未设置时降级为零售价', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'WHOLESALE',
        productInfo: { ...productInfo, wholesalePrice: 0 },
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1200);
      expect(result.priceSource).toContain('降级');
    });

    it('零售价未设置时降级为门店价', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'CASH',
        productInfo: { ...productInfo, retailPrice: 0 },
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(1100);
      expect(result.priceSource).toContain('降级');
    });

    it('低于进价时生成警告但不阻止执行（验收标准）', () => {
      const result = engine.resolveSalesPrice({
        userUnitPrice: 800,
        customerType: 'WHOLESALE',
        productInfo,
        skuName: '五粮液',
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(800);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('低于进价');
      expect(result.warning).toContain('850');
    });

    it('低于最低限价时生成警告但不阻止执行', () => {
      const result = engine.resolveSalesPrice({
        userUnitPrice: 900,
        customerType: 'WHOLESALE',
        productInfo: { ...productInfo, minPrice: 950 },
      });
      expect(result.blocked).toBe(false);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('最低限价');
    });

    it('零价格阻止执行', () => {
      const result = engine.resolveSalesPrice({
        userUnitPrice: 0,
        customerType: 'CASH',
        productInfo,
      });
      expect(result.blocked).toBe(true);
      expect(result.error).toContain('0');
    });

    it('无可用价格信息时阻止执行', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'CASH',
        productInfo: {
          boxRatio: 6,
          retailPrice: 0,
          storePrice: 0,
          costPrice: 850,
        },
      });
      expect(result.blocked).toBe(true);
      expect(result.error).toContain('无可用价格');
    });

    it('无商品价格信息且无用户指定价时阻止执行', () => {
      const result = engine.resolveSalesPrice({
        customerType: 'CASH',
        productInfo: undefined,
      });
      expect(result.blocked).toBe(true);
      expect(result.error).toContain('无可用价格');
    });
  });

  // ── 3. PriceEngineService.resolvePurchasePrice ──
  describe('PriceEngineService.resolvePurchasePrice', () => {
    let engine: PriceEngineService;

    beforeAll(() => {
      engine = new PriceEngineService();
    });

    const productInfo = {
      boxRatio: 6,
      retailPrice: 1200,
      wholesalePrice: 980,
      costPrice: 830,
    };

    it('用户指定进价优先于系统默认进价', () => {
      const result = engine.resolvePurchasePrice({
        userUnitPrice: 850,
        productInfo,
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(850);
      expect(result.priceSource).toBe('用户指定价');
    });

    it('未指定进价时使用系统默认进价', () => {
      const result = engine.resolvePurchasePrice({ productInfo });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(830);
      expect(result.priceSource).toBe('系统默认进价');
    });

    it('进价低于系统进价仅提示不拦截（正常议价）', () => {
      const result = engine.resolvePurchasePrice({
        userUnitPrice: 800,
        productInfo,
        skuName: '五粮液',
      });
      expect(result.blocked).toBe(false);
      expect(result.unitPrice).toBe(800);
      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('低于进价');
    });

    it('无进价信息时阻止执行', () => {
      const result = engine.resolvePurchasePrice({
        productInfo: undefined,
      });
      expect(result.blocked).toBe(true);
      expect(result.error).toContain('无进价');
    });
  });
});
describe('PriceEngineService（智能价格填充）', () => {
  let engine: PriceEngineService;

  beforeEach(() => {
    engine = new PriceEngineService();
  });

  it('用户价格明显为总价时自动折算为单价', () => {
    const res = engine.resolveSalesPrice({
      userUnitPrice: 11490,
      totalQty: 60,
      customerType: 'CASH',
      productInfo: { retailPrice: 191.5, boxRatio: 6 },
      skuName: '五粮液',
    });
    // 11490 = 191.5 * 60 → 视为总价 → 单价 191.5
    expect(res.priceSource).toBe('用户总价÷数量');
    expect(res.unitPrice).toBeCloseTo(191.5, 1);
    expect(res.warning).toContain('总价');
  });

  it('单价在合理范围时不误判（保持用户指定价）', () => {
    const res = engine.resolveSalesPrice({
      userUnitPrice: 200,
      totalQty: 60,
      customerType: 'CASH',
      productInfo: { retailPrice: 191.5 },
      skuName: '五粮液',
    });
    expect(res.priceSource).toBe('用户指定价');
    expect(res.unitPrice).toBe(200);
  });
});
