/**
 * R70-11 商品管理 + 客户管理工具单元测试
 *
 * 测试覆盖：
 * 1. UpdateProductPriceTool — 预览模式 + 执行模式 + 参数校验 + 涨幅计算 + 错误处理
 * 2. QueryProductDetailTool — 正常查询 + 空 SKU + 空数据 + 参数校验 + 错误处理
 * 3. CreateCustomerTool — 预览模式 + 执行模式（body 字段对齐）+ 参数校验 + 错误处理
 * 4. QueryCustomerDetailTool — 正常查询 + 空数据 + 参数校验 + 错误处理
 * 5. SearchCustomerTool 回归测试（R70-09 遗留 bug 修复验证）：
 *    - CUSTOMERS 端点必须为 /api/admin/members（原 /api/admin/customers 返回 404）
 *    - 后端返回 records 字段（真实形态）必须正确解析（原用 list 字段导致永远空列表）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { UpdateProductPriceTool } from './update-product-price.tool';
import { QueryProductDetailTool } from './query-product-detail.tool';
import { CreateCustomerTool } from './create-customer.tool';
import { QueryCustomerDetailTool } from './query-customer-detail.tool';
import { SearchCustomerTool } from './search-customer.tool';
import { SearchProductTool } from './search-product.tool';
import { CreateProductTool } from './create-product.tool';

const mockContext: ToolContext = {
  tenantId: 'test-tenant',
  userId: 'test-user',
  authToken: 'test-token',
};

/** 创建模拟的 ServiceClient */
function createMockServiceClient(): {
  instance: ServiceClient;
  get: jest.Mock;
  post: jest.Mock;
  put: jest.Mock;
} {
  const get = jest.fn();
  const post = jest.fn();
  const put = jest.fn();

  const instance = {
    get,
    post,
    put,
  } as unknown as ServiceClient;

  return { instance, get, post, put };
}

describe('R70-11 商品管理 + 客户管理工具', () => {
  let mockServiceClient: ReturnType<typeof createMockServiceClient>;
  let updateProductPrice: UpdateProductPriceTool;
  let queryProductDetail: QueryProductDetailTool;
  let createCustomer: CreateCustomerTool;
  let queryCustomerDetail: QueryCustomerDetailTool;
  let searchCustomer: SearchCustomerTool;
  let searchProduct: SearchProductTool;
  let createProduct: CreateProductTool;

  beforeAll(async () => {
    mockServiceClient = createMockServiceClient();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        { provide: ServiceClient, useValue: mockServiceClient.instance },
        UpdateProductPriceTool,
        QueryProductDetailTool,
        CreateCustomerTool,
        QueryCustomerDetailTool,
        SearchCustomerTool,
        SearchProductTool,
        CreateProductTool,
      ],
    }).compile();

    updateProductPrice = module.get(UpdateProductPriceTool);
    queryProductDetail = module.get(QueryProductDetailTool);
    createCustomer = module.get(CreateCustomerTool);
    queryCustomerDetail = module.get(QueryCustomerDetailTool);
    searchCustomer = module.get(SearchCustomerTool);
    searchProduct = module.get(SearchProductTool);
    createProduct = module.get(CreateProductTool);
  });

  beforeEach(() => {
    // mockReset 清空实现，避免 mockResolvedValueOnce 跨用例残留
    mockServiceClient.get.mockReset();
    mockServiceClient.post.mockReset();
    mockServiceClient.put.mockReset();
  });

  // ── 1. UpdateProductPriceTool ──
  describe('UpdateProductPriceTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await updateProductPrice.execute(
        {
          skuId: 101,
          skuName: '五粮液 500ml',
          priceType: 'wholesalePrice',
          newPrice: 1000,
          productInfo: { skuName: '五粮液 500ml', currentPrice: 980 },
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview?.operation).toBe('修改商品价格');
      expect(mockServiceClient.put).not.toHaveBeenCalled();

      // 验证预览包含商品名/价格类型/原价/新价/涨幅
      const details = result.preview?.details as Record<string, unknown>;
      expect(details.skuId).toBe(101);
      expect(details.skuName).toBe('五粮液 500ml');
      expect(details.priceType).toBe('wholesalePrice');
      expect(details.priceTypeLabel).toBe('批发价');
      expect(details.oldPrice).toBe(980);
      expect(details.newPrice).toBe(1000);
      // (1000-980)/980 ≈ 2.04%
      expect(details.changePercent).toBe(2.04);
      expect(details.changeDirection).toBe('上调');
    });

    it('预览摘要应包含商品名、价格变化和涨幅', async () => {
      const result = await updateProductPrice.execute(
        {
          skuId: 101,
          priceType: 'retailPrice',
          newPrice: 1100,
          productInfo: { skuName: '五粮液 500ml', currentPrice: 1200 },
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview?.summary).toContain('五粮液 500ml');
      expect(result.preview?.summary).toContain('零售价');
      expect(result.preview?.summary).toContain('¥1200.00 → ¥1100.00');
    });

    it('执行模式（confirm=true）应调用 PUT 更新价格，body 为价格字段平铺', async () => {
      mockServiceClient.put.mockResolvedValue({
        skuId: 101,
        changes: [
          { priceType: 'wholesalePrice', oldValue: 980, newValue: 1000 },
        ],
      });

      const result = await updateProductPrice.execute(
        {
          skuId: 101,
          priceType: 'wholesalePrice',
          newPrice: 1000,
          productInfo: { skuName: '五粮液 500ml', currentPrice: 980 },
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.put).toHaveBeenCalledTimes(1);
      // 验证请求路径和 body 结构与后端 controller 对齐（{ [priceType]: newPrice }）
      const [path, body] = mockServiceClient.put.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toContain('/api/admin/products/101/price');
      expect(body.wholesalePrice).toBe(1000);
      expect(body.retailPrice).toBeUndefined();

      const data = result.data as { message: string; newPrice: number };
      expect(data.newPrice).toBe(1000);
      expect(data.message).toContain('五粮液 500ml');
    });

    it('skuId 非正整数应返回参数错误', async () => {
      const result = await updateProductPrice.execute(
        { skuId: -1, priceType: 'retailPrice', newPrice: 100 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('skuId');
      expect(result.suggestion).toContain('searchProduct');
    });

    it('priceType 非法应返回参数错误', async () => {
      const result = await updateProductPrice.execute(
        { skuId: 101, priceType: 'invalidPrice', newPrice: 100 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('priceType');
    });

    it('newPrice 非正数应返回参数错误', async () => {
      const result = await updateProductPrice.execute(
        { skuId: 101, priceType: 'retailPrice', newPrice: 0 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('newPrice');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.put.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await updateProductPrice.execute(
        { skuId: 101, priceType: 'retailPrice', newPrice: 100, confirm: true },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('修改价格失败');
    });
  });

  // ── 2. QueryProductDetailTool ──
  describe('QueryProductDetailTool', () => {
    it('正常查询应返回 SPU 基础信息 + SKU 多级价格/库存', async () => {
      mockServiceClient.get.mockResolvedValue({
        id: 1,
        spuCode: 'SPU20260801001',
        name: '五粮液',
        categoryName: '白酒',
        brandName: '五粮液',
        unit: '瓶',
        specs: '52度500ml',
        status: 'ON_SALE',
        saleChannels: 'BOTH',
        skus: [
          {
            id: 101,
            skuCode: 'SKU101',
            skuName: '五粮液 500ml',
            barcode: '6901234567890',
            volume: '500ml',
            packaging: '单瓶',
            baseUnit: '瓶',
            boxUnit: '箱',
            boxRatio: 6,
            temperature: 'NORMAL',
            warningThreshold: 10,
            costPrice: 800,
            retailPrice: 1200,
            wholesalePrice: 980,
            miniappPrice: 1100,
            storePrice: 1150,
            availableQty: 200,
          },
        ],
      });

      const result = await queryProductDetail.execute(
        { spuId: 1 },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        '/api/admin/products/1',
        mockContext,
      );

      const data = result.data as {
        spuId: number;
        name: string;
        categoryName: string;
        skus: Array<{
          skuId: number;
          skuName: string;
          prices: Record<string, number | null>;
          availableQty: number;
          boxRatio: number;
        }>;
      };
      expect(data.spuId).toBe(1);
      expect(data.name).toBe('五粮液');
      expect(data.categoryName).toBe('白酒');
      expect(data.skus).toHaveLength(1);
      expect(data.skus[0].skuId).toBe(101);
      expect(data.skus[0].skuName).toBe('五粮液 500ml');
      expect(data.skus[0].prices.retailPrice).toBe(1200);
      expect(data.skus[0].prices.wholesalePrice).toBe(980);
      expect(data.skus[0].prices.storePrice).toBe(1150);
      expect(data.skus[0].prices.costPrice).toBe(800);
      expect(data.skus[0].availableQty).toBe(200);
      expect(data.skus[0].boxRatio).toBe(6);
    });

    it('无 SKU 商品应返回空 skus 数组', async () => {
      mockServiceClient.get.mockResolvedValue({
        id: 2,
        spuCode: 'SPU20260801002',
        name: '新品',
        skus: [],
      });

      const result = await queryProductDetail.execute(
        { spuId: 2 },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { skus: unknown[] };
      expect(data.skus).toHaveLength(0);
    });

    it('后端返回空数据应返回错误', async () => {
      mockServiceClient.get.mockResolvedValue(null);

      const result = await queryProductDetail.execute(
        { spuId: 99 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('空数据');
    });

    it('spuId 非正整数应返回参数错误', async () => {
      const result = await queryProductDetail.execute(
        { spuId: 0 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('spuId');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.get.mockRejectedValue(
        new Error('后端 HTTP 404：商品不存在'),
      );

      const result = await queryProductDetail.execute(
        { spuId: 999 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('查询商品详情失败');
      expect(result.suggestion).toContain('spuId');
    });
  });

  // ── 3. CreateCustomerTool ──
  describe('CreateCustomerTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createCustomer.execute(
        {
          name: '兴旺超市',
          phone: '13800000000',
          customerType: 'WHOLESALE',
          settlementType: 'ACCOUNT',
          address: '解放路88号',
          remark: '周结客户',
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview?.operation).toBe('创建客户');
      expect(mockServiceClient.post).not.toHaveBeenCalled();

      // 验证预览包含客户名称/电话/类型标签/结算方式标签
      const details = result.preview?.details as Record<string, unknown>;
      expect(details.name).toBe('兴旺超市');
      expect(details.phone).toBe('13800000000');
      expect(details.customerType).toBe('WHOLESALE');
      expect(details.customerTypeLabel).toBe('批发客户');
      expect(details.settlementTypeLabel).toBe('账期结算');
      expect(details.remark).toBe('周结客户');
    });

    it('预览含 creditLimit 时应提示需人工设置', async () => {
      const result = await createCustomer.execute(
        { name: '兴旺超市', creditLimit: 5000 },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview?.details as Record<string, unknown>;
      expect(details.creditLimit).toBe(5000);
      expect(details.creditLimitNote).toContain('人工设置');
      expect(result.preview?.summary).toContain('信用额度需创建后人工设置');
    });

    it('执行模式（confirm=true）应调用 POST /api/admin/members，body 字段对齐后端', async () => {
      mockServiceClient.post.mockResolvedValue({
        memberId: 1001,
        name: '兴旺超市',
        mobile: '13800000000',
        customerType: 'WHOLESALE',
        staffId: null,
        address: '解放路88号',
        settlementType: 'ACCOUNT',
        remark: '周结客户',
      });

      const result = await createCustomer.execute(
        {
          name: '兴旺超市',
          phone: '13800000000',
          customerType: 'WHOLESALE',
          settlementType: 'ACCOUNT',
          address: '解放路88号',
          remark: '周结客户',
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledTimes(1);
      // 验证请求路径和 body 与后端 createCustomer 对齐（creditLimit 后端不支持，不发送）
      const [path, body] = mockServiceClient.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/members');
      expect(body.name).toBe('兴旺超市');
      expect(body.mobile).toBe('13800000000');
      expect(body.customerType).toBe('WHOLESALE');
      expect(body.address).toBe('解放路88号');
      expect(body.settlementType).toBe('ACCOUNT');
      expect(body.remark).toBe('周结客户');
      expect(body.creditLimit).toBeUndefined();

      const data = result.data as { memberId: number; message: string };
      expect(data.memberId).toBe(1001);
      expect(data.message).toContain('兴旺超市');
    });

    it('执行模式携带 creditLimit 时应提示未写入', async () => {
      mockServiceClient.post.mockResolvedValue({
        memberId: 1002,
        name: '兴旺超市',
        mobile: '',
        customerType: 'CASH',
        staffId: null,
        address: null,
        settlementType: 'CASH',
        remark: null,
      });

      const result = await createCustomer.execute(
        {
          name: '兴旺超市',
          phone: '13800000000',
          creditLimit: 8000,
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { note?: string; creditLimit?: unknown };
      expect(data.note).toContain('人工设置');
      expect(data.creditLimit).toBeUndefined();
    });

    it('执行时同名客户已存在应复用且不重复创建', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 10,
        records: [
          {
            memberId: 5,
            name: '兴旺超市',
            mobile: '13800000000',
            customerType: 'WHOLESALE',
          },
        ],
      });

      const result = await createCustomer.execute(
        {
          name: '兴旺超市',
          phone: '13800000000',
          customerType: 'WHOLESALE',
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        memberId: number;
        duplicate: boolean;
        message: string;
      };
      expect(data.memberId).toBe(5);
      expect(data.duplicate).toBe(true);
      expect(data.message).toContain('已存在');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('name 为空应返回参数错误', async () => {
      const result = await createCustomer.execute({ name: '  ' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('customerType 非法应返回参数错误', async () => {
      const result = await createCustomer.execute(
        { name: '兴旺超市', customerType: 'GOLD' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('customerType');
    });

    it('settlementType 非法应返回参数错误', async () => {
      const result = await createCustomer.execute(
        { name: '兴旺超市', settlementType: 'MONTHLY' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('settlementType');
    });

    it('creditLimit 为负数应返回参数错误', async () => {
      const result = await createCustomer.execute(
        { name: '兴旺超市', creditLimit: -1 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('creditLimit');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.post.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await createCustomer.execute(
        { name: '兴旺超市', phone: '13800000000', confirm: true },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('创建客户失败');
    });
  });

  // ── 4. QueryCustomerDetailTool ──
  describe('QueryCustomerDetailTool', () => {
    it('正常查询应返回客户详情完整字段（含类型/结算方式标签）', async () => {
      mockServiceClient.get.mockResolvedValue({
        memberId: 1,
        name: '红星商行',
        mobile: '13800000001',
        customerType: 'WHOLESALE',
        address: '解放路1号',
        settlementType: 'ACCOUNT',
        remark: '月结客户',
        points: 1200,
        levelCode: 'L2',
        status: 1,
        staffId: 5,
        staffName: '张三',
      });

      const result = await queryCustomerDetail.execute(
        { customerId: 1 },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        '/api/admin/members/1',
        mockContext,
      );

      const data = result.data as {
        customerId: number;
        name: string;
        customerTypeLabel: string;
        settlementTypeLabel: string;
        points: number;
        levelCode: string;
        staffName: string;
      };
      expect(data.customerId).toBe(1);
      expect(data.name).toBe('红星商行');
      expect(data.customerTypeLabel).toBe('批发客户');
      expect(data.settlementTypeLabel).toBe('账期结算');
      expect(data.points).toBe(1200);
      expect(data.levelCode).toBe('L2');
      expect(data.staffName).toBe('张三');
    });

    it('结算方式为 null 时应返回未知标签', async () => {
      mockServiceClient.get.mockResolvedValue({
        memberId: 2,
        name: '散客甲',
        mobile: '',
        customerType: 'CASH',
        address: null,
        settlementType: null,
        remark: null,
        points: 0,
        levelCode: 'L0',
        status: 1,
        staffId: null,
        staffName: null,
      });

      const result = await queryCustomerDetail.execute(
        { customerId: 2 },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { settlementTypeLabel: string };
      expect(data.settlementTypeLabel).toBe('未知');
    });

    it('后端返回空数据应返回错误', async () => {
      mockServiceClient.get.mockResolvedValue(null);

      const result = await queryCustomerDetail.execute(
        { customerId: 99 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('空数据');
    });

    it('customerId 非正整数应返回参数错误', async () => {
      const result = await queryCustomerDetail.execute(
        { customerId: 0 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('customerId');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.get.mockRejectedValue(
        new Error('后端 HTTP 404：客户不存在'),
      );

      const result = await queryCustomerDetail.execute(
        { customerId: 999 },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('查询客户详情失败');
      expect(result.suggestion).toContain('customerId');
    });
  });

  // ── 5. SearchCustomerTool 回归测试（R70-09 遗留 bug 修复验证） ──
  describe('SearchCustomerTool 回归测试', () => {
    it('调用路径必须为 /api/admin/members（CUSTOMERS 端点修复验证）', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            memberId: 1,
            name: '红星商行',
            mobile: '13800000001',
            customerType: 'WHOLESALE',
            address: '解放路1号',
            settlementType: 'ACCOUNT',
            remark: null,
            points: 100,
            levelCode: 'L2',
            status: 'ACTIVE',
            staffId: 5,
            staffName: '张三',
            totalSpent: 50000,
            arrears: 0,
          },
        ],
      });

      const result = await searchCustomer.execute(
        { keyword: '红星' },
        mockContext,
      );

      expect(result.success).toBe(true);
      // 回归断言：必须调用 /api/admin/members（原 /api/admin/customers 会 404）
      const [path] = mockServiceClient.get.mock.calls[0] as [string];
      expect(path).toContain('/api/admin/members');
      expect(path).not.toContain('/api/admin/customers');
      expect(path).toContain('keyword=');
    });

    it('后端返回 records 字段（真实形态）应正确解析', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 2,
        page: 1,
        pageSize: 20,
        records: [
          {
            memberId: 1,
            name: '红星商行',
            mobile: '13800000001',
            customerType: 'WHOLESALE',
            address: null,
            settlementType: null,
            remark: null,
            points: 100,
            levelCode: 'L2',
            status: 'ACTIVE',
            staffId: 5,
            staffName: '张三',
            totalSpent: 50000,
            arrears: 0,
          },
          {
            memberId: 2,
            name: '红运超市',
            mobile: '13800000002',
            customerType: 'CASH',
            address: null,
            settlementType: null,
            remark: null,
            points: 0,
            levelCode: 'L0',
            status: 'ACTIVE',
            staffId: null,
            staffName: null,
            totalSpent: 1200,
            arrears: 300,
          },
        ],
      });

      const result = await searchCustomer.execute(
        { keyword: '红' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        list: Array<{
          memberId: number;
          name: string;
          customerTypeLabel: string;
        }>;
        total: number;
      };
      expect(data.list).toHaveLength(2);
      expect(data.list[0].memberId).toBe(1);
      expect(data.list[0].name).toBe('红星商行');
      expect(data.list[0].customerTypeLabel).toBe('批发客户');
      expect(data.list[1].name).toBe('红运超市');
      expect(data.total).toBe(2);
    });

    it('后端返回 list 字段（旧形态）应保持兼容', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        list: [
          {
            memberId: 3,
            name: '散客乙',
            mobile: '',
            customerType: 'CASH',
            address: null,
            settlementType: null,
            remark: null,
            points: 0,
            levelCode: 'L0',
            status: 'ACTIVE',
            staffId: null,
            staffName: null,
            totalSpent: 0,
            arrears: 0,
          },
        ],
      });

      const result = await searchCustomer.execute(
        { keyword: '散客' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        list: Array<{ memberId: number; name: string }>;
      };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].memberId).toBe(3);
    });

    it('空结果应返回成功 + 空列表 + 提示信息', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      const result = await searchCustomer.execute(
        { keyword: '不存在' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: unknown[]; message: string };
      expect(data.list).toHaveLength(0);
      expect(data.message).toContain('不存在');
    });

    it('keyword 为空应返回参数错误', async () => {
      const result = await searchCustomer.execute({ keyword: '' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('keyword');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.get.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await searchCustomer.execute(
        { keyword: '红星' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('搜索客户失败');
    });
  });

  // ── 6. SearchProductTool 回归测试（records 字段兼容，与 searchCustomer 同源问题） ──
  describe('SearchProductTool 回归测试', () => {
    it('调用路径必须为 /api/admin/products', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            id: 2,
            spuCode: 'SPU_WLY_52',
            name: '五粮液 52度 500ml',
            categoryId: 1,
            categoryName: '白酒',
            brandId: null,
            brandName: null,
            unit: '瓶',
            specs: '500ml/瓶，52度',
            status: 'ON_SALE',
            // 真实后端形态：首个 SKU 字段拍平到记录顶层（无嵌套 skus）
            skuId: 2,
            skuCode: 'SKU_WLY_52',
            skuName: '五粮液 52度 500ml',
            barcode: '6901234567002',
            volume: '500ml',
            packaging: '瓶装',
            baseUnit: '瓶',
            boxUnit: '箱',
            boxRatio: 6,
            costPrice: 850,
            retailPrice: 1200,
            wholesalePrice: 980,
            miniappPrice: 1100,
            storePrice: 1150,
            availableQty: 150,
          },
        ],
      });

      const result = await searchProduct.execute(
        { keyword: '五粮液' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const [path] = mockServiceClient.get.mock.calls[0] as [string];
      expect(path).toContain('/api/admin/products');
      expect(path).toContain('keyword=');
      const data = result.data as {
        list: Array<{
          spuId: number;
          name: string;
          skus: Array<{ skuId: number; boxRatio: number }>;
        }>;
        total: number;
      };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].spuId).toBe(2);
      expect(data.list[0].name).toBe('五粮液 52度 500ml');
      expect(data.list[0].skus).toHaveLength(1);
      expect(data.list[0].skus[0].skuId).toBe(2);
      expect(data.list[0].skus[0].boxRatio).toBe(6);
      expect(data.total).toBe(1);
    });

    it('空结果应返回成功 + 空列表 + 自动创建建议', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      const result = await searchProduct.execute(
        { keyword: '不存在' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: unknown[]; suggestion?: string };
      expect(data.list).toHaveLength(0);
      expect(data.suggestion).toContain('createProduct');
    });
  });

  // ── 7. CreateProductTool（预览 + 执行） ──
  describe('CreateProductTool', () => {
    it('无价格应返回参数错误（需向用户确认价格）', async () => {
      const result = await createProduct.execute(
        { name: '测试酒', categoryId: 1 },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('价格');
    });

    it('预览阶段应返回 preview 且不调用后端', async () => {
      mockServiceClient.get.mockResolvedValue([{ id: 1, name: '白酒' }]);
      const result = await createProduct.execute(
        {
          name: '红星二锅头 56度 500ml',
          categoryName: '白酒',
          retailPrice: 45,
          wholesalePrice: 38,
          confirm: false,
        },
        mockContext,
      );
      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('执行阶段应调用 POST /api/admin/products 并返回 skuId', async () => {
      mockServiceClient.get.mockResolvedValue([{ id: 1, name: '白酒' }]);
      mockServiceClient.post.mockResolvedValue({
        id: 100,
        spuId: 100,
        skuId: 200,
        spuCode: 'SPU_TEST',
      });
      const result = await createProduct.execute(
        {
          name: '红星二锅头 56度 500ml',
          categoryName: '白酒',
          retailPrice: 45,
          wholesalePrice: 38,
          boxRatio: 6,
          confirm: true,
        },
        mockContext,
      );
      expect(result.success).toBe(true);
      const data = result.data as { skuId: number };
      expect(data.skuId).toBe(200);
      const [path] = mockServiceClient.post.mock.calls[0] as [string];
      expect(path).toContain('/api/admin/products');
    });

    it('执行时同名商品已存在应复用且不重复创建', async () => {
      // 第一次 GET：分类解析；第二次 GET：按名称查重
      mockServiceClient.get
        .mockResolvedValueOnce([{ id: 1, name: '白酒' }])
        .mockResolvedValueOnce({
          total: 1,
          page: 1,
          pageSize: 10,
          records: [{ id: 100, name: '红星二锅头 56度 500ml', skuId: 200 }],
        });

      const result = await createProduct.execute(
        {
          name: '红星二锅头 56度 500ml',
          categoryName: '白酒',
          retailPrice: 45,
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        spuId: number;
        duplicate: boolean;
        message: string;
      };
      expect(data.spuId).toBe(100);
      expect(data.duplicate).toBe(true);
      expect(data.message).toContain('已存在');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });
  });
});
