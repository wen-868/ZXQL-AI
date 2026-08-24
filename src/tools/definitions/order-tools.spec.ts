/**
 * R70-09 销售工具单元测试
 *
 * 测试覆盖：
 * 1. SearchCustomerTool — 参数校验 + 后端调用 + 空结果 + 错误处理
 * 2. SearchProductTool — 参数校验 + 后端调用 + SKU价格信息
 * 3. CheckInventoryTool — 参数校验 + 后端调用 + 库存状态标签
 * 4. CreateSalesOrderTool — 预览模式 + 智能价格填充 + 单位换算 + 价格安全校验 + 执行模式
 * 5. QuerySaleBillsTool — 查询 + 状态翻译
 * 6. GetSaleBillDetailTool — 销售单/订单路由 + 错误处理
 * 7. CancelOrderTool — 取消 + 错误处理
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-01
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { PriceEngineService } from '../price-engine.service';
import { UnitConverterService } from '../unit-converter.service';
import { SearchCustomerTool } from './search-customer.tool';
import { SearchProductTool } from './search-product.tool';
import { CheckInventoryTool } from './check-inventory.tool';
import { CreateSalesOrderTool } from './create-sales-order.tool';
import { QuerySaleBillsTool } from './query-sale-bills.tool';
import { GetSaleBillDetailTool } from './get-sale-bill-detail.tool';
import { CancelOrderTool } from './cancel-order.tool';

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
  delete: jest.Mock;
} {
  const get = jest.fn();
  const post = jest.fn();
  const put = jest.fn();
  const del = jest.fn();

  const instance = {
    get,
    post,
    put,
    delete: del,
  } as unknown as ServiceClient;

  return { instance, get, post, put, delete: del };
}

describe('R70-09 销售工具', () => {
  let mockServiceClient: ReturnType<typeof createMockServiceClient>;
  let searchCustomer: SearchCustomerTool;
  let searchProduct: SearchProductTool;
  let checkInventory: CheckInventoryTool;
  let createSalesOrder: CreateSalesOrderTool;
  let querySaleBills: QuerySaleBillsTool;
  let getSaleBillDetail: GetSaleBillDetailTool;
  let cancelOrder: CancelOrderTool;

  beforeAll(async () => {
    mockServiceClient = createMockServiceClient();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        { provide: ServiceClient, useValue: mockServiceClient.instance },
        // R70-14: 智能价格填充引擎
        PriceEngineService,
        UnitConverterService,
        SearchCustomerTool,
        SearchProductTool,
        CheckInventoryTool,
        CreateSalesOrderTool,
        QuerySaleBillsTool,
        GetSaleBillDetailTool,
        CancelOrderTool,
      ],
    }).compile();

    searchCustomer = module.get(SearchCustomerTool);
    searchProduct = module.get(SearchProductTool);
    checkInventory = module.get(CheckInventoryTool);
    createSalesOrder = module.get(CreateSalesOrderTool);
    querySaleBills = module.get(QuerySaleBillsTool);
    getSaleBillDetail = module.get(GetSaleBillDetailTool);
    cancelOrder = module.get(CancelOrderTool);
  });

  beforeEach(() => {
    // mockReset 清空实现，避免 mockResolvedValueOnce 跨用例残留
    mockServiceClient.get.mockReset();
    mockServiceClient.post.mockReset();
  });

  // ── 1. SearchCustomerTool ──
  describe('SearchCustomerTool', () => {
    it('应正确搜索客户并返回精简列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        list: [
          {
            memberId: 1,
            name: '红星商行',
            mobile: '13800138000',
            customerType: 'WHOLESALE',
            arrears: 5000,
            totalSpent: 50000,
            status: 'ACTIVE',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      });

      const result = await searchCustomer.execute(
        { keyword: '红星' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: unknown[]; total: number };
      expect(data.list).toHaveLength(1);
      expect(data.total).toBe(1);
    });

    it('空关键词应返回参数错误', async () => {
      const result = await searchCustomer.execute({ keyword: '' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('keyword');
    });

    it('后端返回空列表应返回成功+空列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        list: [],
        total: 0,
      });

      const result = await searchCustomer.execute(
        { keyword: '不存在' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: unknown[] };
      expect(data.list).toHaveLength(0);
    });
  });

  // ── 2. SearchProductTool ──
  describe('SearchProductTool', () => {
    it('应正确搜索商品并返回含SKU价格信息', async () => {
      mockServiceClient.get.mockResolvedValue({
        list: [
          {
            id: 10,
            name: '五粮液',
            brandName: '五粮液',
            specs: '500ml',
            unit: '瓶',
            categoryName: '白酒',
            skus: [
              {
                id: 101,
                skuName: '五粮液 500ml',
                barcode: '6901234567890',
                boxRatio: 6,
                baseUnit: '瓶',
                boxUnit: '箱',
                costPrice: 850,
                retailPrice: 1200,
                wholesalePrice: 980,
                miniappPrice: 1100,
                storePrice: 1100,
                availableQty: 200,
              },
            ],
          },
        ],
        total: 1,
      });

      const result = await searchProduct.execute(
        { keyword: '五粮液' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        list: Array<{ skus: Array<{ prices: Record<string, number> }> }>;
      };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].skus[0].prices.wholesalePrice).toBe(980);
    });
  });

  // ── 3. CheckInventoryTool ──
  describe('CheckInventoryTool', () => {
    it('应正确查询库存并返回库存状态标签', async () => {
      mockServiceClient.get.mockResolvedValue({
        list: [
          {
            skuId: 101,
            skuName: '五粮液 500ml',
            barcode: '6901234567890',
            availableQty: 5,
            lockedQty: 2,
            totalQty: 7,
            storeName: '1号仓库',
          },
        ],
        total: 1,
      });

      const result = await checkInventory.execute(
        { keyword: '五粮液' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: Array<{ stockStatus: string }> };
      expect(data.list[0].stockStatus).toBe('库存不足'); // 5 < 10
    });
  });

  // ── 4. CreateSalesOrderTool ──
  describe('CreateSalesOrderTool', () => {
    const productInfo = {
      boxRatio: 6,
      retailPrice: 1200,
      wholesalePrice: 980,
      storePrice: 1100,
      costPrice: 850,
    };

    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          customerName: '红星商行',
          customerType: 'WHOLESALE',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              boxQty: 5,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview?.operation).toBe('创建销售单');
      expect(mockServiceClient.post).not.toHaveBeenCalled();

      // 验证智能价格填充：批发客户应使用批发价 980
      const items = result.preview?.details.items as Array<{
        unitPrice: number;
        priceSource: string;
        totalBottleQty: number;
      }>;
      expect(items[0].unitPrice).toBe(980);
      expect(items[0].priceSource).toContain('批发');
      expect(items[0].totalBottleQty).toBe(30); // 5箱 * 6瓶/箱 = 30瓶
    });

    it('零售客户应自动匹配零售价', async () => {
      const result = await createSalesOrder.execute(
        {
          customerId: 2,
          customerName: '散客',
          customerType: 'CASH',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              bottleQty: 2,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const items = result.preview?.details.items as Array<{
        unitPrice: number;
        priceSource: string;
      }>;
      expect(items[0].unitPrice).toBe(1200); // 零售价
    });

    it('用户指定价应优先于客户类型匹配', async () => {
      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          customerType: 'WHOLESALE',
          items: [
            {
              skuId: 101,
              boxQty: 1,
              unitPrice: 1000,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      const items = result.preview?.details.items as Array<{
        unitPrice: number;
        priceSource: string;
      }>;
      expect(items[0].unitPrice).toBe(1000);
      expect(items[0].priceSource).toContain('用户指定');
    });

    it('低于进价应生成警告但不阻止', async () => {
      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          customerType: 'WHOLESALE',
          items: [
            {
              skuId: 101,
              boxQty: 1,
              unitPrice: 800,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const warnings = result.preview?.details.warnings as string[];
      expect(warnings).toBeDefined();
      expect(warnings[0]).toContain('低于进价');
    });

    it('缺少 productInfo 且无 unitPrice 应阻止执行', async () => {
      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          items: [{ skuId: 101, boxQty: 1 }],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('无可用价格');
    });

    it('缺少 productInfo 时应按 skuId 回查后端价格（兜底）', async () => {
      // customerId 已传入，仅需商品列表回查（GET 一次）
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 200,
        records: [
          {
            id: 101,
            name: '五粮液 500ml',
            skuId: 101,
            boxRatio: 6,
            retailPrice: 1200,
            wholesalePrice: 980,
            storePrice: 1100,
            costPrice: 850,
          },
        ],
      });

      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          customerType: 'WHOLESALE',
          items: [{ skuId: 101, skuName: '五粮液 500ml', boxQty: 1 }],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const items = result.preview?.details.items as Array<{
        unitPrice: number;
        totalBottleQty: number;
        priceSource: string;
      }>;
      expect(items[0].totalBottleQty).toBe(6); // 1箱 × 6瓶
      expect(items[0].unitPrice).toBe(980); // 批发价
      expect(items[0].priceSource).toContain('批发');
    });

    it('执行模式（confirm=true）应调用后端 POST', async () => {
      mockServiceClient.post.mockResolvedValue({
        billNo: 'SB20260801001',
        totalAmount: 29400,
      });

      const result = await createSalesOrder.execute(
        {
          customerId: 1,
          customerName: '红星商行',
          customerType: 'WHOLESALE',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              boxQty: 5,
              productInfo,
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledTimes(1);
      const data = result.data as { billNo: string; totalAmount: number };
      expect(data.billNo).toBe('SB20260801001');
    });

    it('仅传 customerName 且客户已存在：预览应解析出 customerId', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 10,
        records: [{ memberId: 8, name: '光明超市', customerType: 'RETAIL' }],
      });

      const result = await createSalesOrder.execute(
        {
          customerName: '光明超市',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              bottleQty: 2,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview?.details as {
        customerId: number;
        customerName: string;
        willCreateCustomer?: boolean;
      };
      expect(details.customerId).toBe(8);
      expect(details.customerName).toBe('光明超市');
      expect(details.willCreateCustomer).toBeUndefined();
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('仅传 customerName 且客户不存在：预览标记将自动创建（不调用创建接口）', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 10,
        records: [],
      });

      const result = await createSalesOrder.execute(
        {
          customerName: '红星商行',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              boxQty: 1,
              productInfo,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview?.details as {
        willCreateCustomer: boolean;
        customerType: string;
      };
      expect(details.willCreateCustomer).toBe(true);
      expect(details.customerType).toBe('WHOLESALE'); // 名称含"商行" → 批发
      expect(result.preview?.summary).toContain('将自动创建客户');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('执行模式：客户不存在时自动创建客户再创建销售单', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 10,
        records: [],
      });
      mockServiceClient.post
        .mockResolvedValueOnce({ memberId: 99, name: '红星商行' }) // 自动创建客户
        .mockResolvedValueOnce({ billNo: 'SB20260801002', totalAmount: 9800 });

      const result = await createSalesOrder.execute(
        {
          customerName: '红星商行',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              boxQty: 1,
              productInfo,
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledTimes(2);
      const data = result.data as {
        billNo: string;
        customerId: number;
        createdCustomer: boolean;
      };
      expect(data.billNo).toBe('SB20260801002');
      expect(data.customerId).toBe(99);
      expect(data.createdCustomer).toBe(true);
    });

    it('缺少 customerId 应返回参数错误', async () => {
      const result = await createSalesOrder.execute(
        { items: [{ skuId: 1, boxQty: 1 }] },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('customerId 或 customerName');
    });

    it('空 items 应返回参数错误', async () => {
      const result = await createSalesOrder.execute(
        { customerId: 1, items: [] },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('items');
    });
  });

  // ── 5. QuerySaleBillsTool ──
  describe('QuerySaleBillsTool', () => {
    it('应正确查询销售单列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        list: [
          {
            billNo: 'SB20260801001',
            customerName: '红星商行',
            totalAmount: 29400,
            receivedAmount: 29400,
            unreceivedAmount: 0,
            businessStatus: 'COMPLETED',
            saleType: 'CASH',
            createdAt: '2026-08-01T10:00:00Z',
          },
        ],
        total: 1,
      });

      const result = await querySaleBills.execute(
        { keyword: '红星' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        list: Array<{ businessStatusLabel: string }>;
      };
      expect(data.list[0].businessStatusLabel).toBe('已完成');
    });
  });

  // ── 6. GetSaleBillDetailTool ──
  describe('GetSaleBillDetailTool', () => {
    it('SB 开头应调用销售单详情接口', async () => {
      mockServiceClient.get.mockResolvedValue({
        billNo: 'SB20260801001',
        customerName: '红星商行',
        totalAmount: 29400,
      });

      const result = await getSaleBillDetail.execute(
        { billNo: 'SB20260801001' },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/store/sale-bills/SB20260801001'),
        mockContext,
      );
    });

    it('ORD 开头应调用订单详情接口', async () => {
      mockServiceClient.get.mockResolvedValue({
        orderNo: 'ORD20260801001',
        status: 'CONFIRMED',
      });

      const result = await getSaleBillDetail.execute(
        { billNo: 'ORD20260801001' },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/orders/ORD20260801001'),
        mockContext,
      );
    });

    it('空单号应返回参数错误', async () => {
      const result = await getSaleBillDetail.execute(
        { billNo: '' },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('billNo');
    });
  });

  // ── 7. CancelOrderTool ──
  describe('CancelOrderTool', () => {
    it('应正确取消订单', async () => {
      mockServiceClient.post.mockResolvedValue({
        orderNo: 'ORD20260801001',
        status: 'CANCELLED',
      });

      const result = await cancelOrder.execute(
        { orderNo: 'ORD20260801001', reason: '客户取消' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { orderNo: string; message: string };
      expect(data.orderNo).toBe('ORD20260801001');
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/orders/ORD20260801001/cancel'),
        { reason: '客户取消' },
        mockContext,
      );
    });

    it('空单号应返回参数错误', async () => {
      const result = await cancelOrder.execute({ orderNo: '' }, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('orderNo');
    });
  });
});
