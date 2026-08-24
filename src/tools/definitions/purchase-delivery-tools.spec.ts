/**
 * R70-12 采购+配送工具单元测试
 *
 * 测试覆盖：
 * 1. CreatePurchaseOrderTool — 预览模式 + 执行模式 + 供应商名称自动解析 + 单位换算 + 智能进价填充 + 参数校验 + 错误处理
 * 2. QueryPurchaseOrdersTool — 列表查询 + records 解析 + 状态标签 + 空结果 + 参数校验 + 错误处理
 * 3. QueryDeliveryStatusTool — 配送状态查询 + 状态标签 + 空结果 + 参数校验 + 错误处理
 * 4. CreateDeliveryTool — 预览模式 + 执行模式 + 参数校验 + 错误处理
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { PriceEngineService } from '../price-engine.service';
import { UnitConverterService } from '../unit-converter.service';
import { CreatePurchaseOrderTool } from './create-purchase-order.tool';
import { QueryPurchaseOrdersTool } from './query-purchase-orders.tool';
import { QueryDeliveryStatusTool } from './query-delivery-status.tool';
import { CreateDeliveryTool } from './create-delivery.tool';

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

describe('R70-12 采购+配送工具', () => {
  let mockServiceClient: ReturnType<typeof createMockServiceClient>;
  let createPurchaseOrder: CreatePurchaseOrderTool;
  let queryPurchaseOrders: QueryPurchaseOrdersTool;
  let queryDeliveryStatus: QueryDeliveryStatusTool;
  let createDelivery: CreateDeliveryTool;

  beforeAll(async () => {
    mockServiceClient = createMockServiceClient();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        { provide: ServiceClient, useValue: mockServiceClient.instance },
        // R70-14: 智能价格填充引擎
        PriceEngineService,
        UnitConverterService,
        CreatePurchaseOrderTool,
        QueryPurchaseOrdersTool,
        QueryDeliveryStatusTool,
        CreateDeliveryTool,
      ],
    }).compile();

    createPurchaseOrder = module.get(CreatePurchaseOrderTool);
    queryPurchaseOrders = module.get(QueryPurchaseOrdersTool);
    queryDeliveryStatus = module.get(QueryDeliveryStatusTool);
    createDelivery = module.get(CreateDeliveryTool);
  });

  beforeEach(() => {
    mockServiceClient.get.mockClear();
    mockServiceClient.post.mockClear();
  });

  // ── 1. CreatePurchaseOrderTool ──
  describe('CreatePurchaseOrderTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createPurchaseOrder.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 10,
              unitPrice: 850,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview!.operation).toBe('创建采购单');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
      // 单位换算：10箱 × 6瓶/箱 = 60瓶
      const details = result.preview!.details;
      const items = details.items as Array<{ totalBottleQty: number }>;
      expect(items[0].totalBottleQty).toBe(60);
      expect(details.goodsAmount).toBe(60 * 850);
    });

    it('执行模式（confirm=true）应调用 POST /api/admin/purchase-orders', async () => {
      mockServiceClient.post.mockResolvedValue({
        orderId: 100,
        orderNo: 'CG202608010001',
      });

      const result = await createPurchaseOrder.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 10,
              unitPrice: 850,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        orderNo: 'CG202608010001',
        orderId: 100,
      });
      expect(mockServiceClient.post).toHaveBeenCalledTimes(1);
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        '/api/admin/purchase-orders',
        expect.objectContaining({
          supplierId: 3,
          storeId: 1,
          items: [
            expect.objectContaining({
              skuId: 10,
              boxQty: 10,
              bottleQty: 0,
              totalBottleQty: 60,
              unitPrice: 850,
              taxRate: 0,
            }),
          ],
        }),
        mockContext,
      );
    });

    it('仅提供 supplierName 时应自动搜索供应商（GET /api/admin/suppliers）', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 10,
        records: [{ id: 3, name: '红星酒业', shortName: '红星' }],
      });

      const result = await createPurchaseOrder.execute(
        {
          supplierName: '红星酒业',
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 1,
              unitPrice: 850,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/suppliers?keyword='),
        mockContext,
      );
      // 确认请求体使用了解析出的 supplierId=3
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ supplierId: 3 }),
        mockContext,
      );
    });

    it('供应商名称搜索无结果时应返回错误', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 10,
        records: [],
      });

      const result = await createPurchaseOrder.execute(
        {
          supplierName: '不存在的供应商',
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 1,
              unitPrice: 850,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('未找到匹配');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('未提供进价且用户未指定单价时应阻止执行', async () => {
      const result = await createPurchaseOrder.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [{ skuId: 10, skuName: '五粮液 500ml', boxQty: 1 }],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('无进价信息');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('低于系统进价时应生成预览并携带警告（不阻止）', async () => {
      const result = await createPurchaseOrder.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 10,
              unitPrice: 800,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview!.details;
      expect(details.warnings).toBeDefined();
      expect((details.warnings as string[])[0]).toContain('低于进价');
    });

    it('supplierId 与 supplierName 都缺失时应返回参数错误', async () => {
      const result = await createPurchaseOrder.execute(
        {
          storeId: 1,
          items: [{ skuId: 10, boxQty: 1 }],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('supplierId');
    });

    it('items 为空时应返回参数错误', async () => {
      const result = await createPurchaseOrder.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('items');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.post.mockRejectedValue(
        Object.assign(new Error('供应商不存在'), { statusCode: 400 }),
      );

      const result = await createPurchaseOrder.execute(
        {
          supplierId: 999,
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 1,
              unitPrice: 850,
              productInfo: { boxRatio: 6, costPrice: 830 },
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('创建采购单失败');
    });
  });

  // ── 2. QueryPurchaseOrdersTool ──
  describe('QueryPurchaseOrdersTool', () => {
    it('应正确解析 records 字段并返回精简列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            id: 1,
            orderNo: 'CG202607010001',
            supplierId: 3,
            supplierName: '红星酒业',
            storeId: 1,
            orderStatus: 'PENDING',
            goodsAmount: 51000,
            taxAmount: 0,
            payableAmount: 51000,
            paidAmount: 0,
            unpaidAmount: 51000,
            expectedDate: '2026-07-05',
            remark: null,
            createdAt: '2026-07-01',
          },
        ],
      });

      const result = await queryPurchaseOrders.execute(
        { orderStatus: 'PENDING' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: Array<Record<string, unknown>> };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].orderStatusLabel).toBe('待审核');
      expect(data.list[0].payableAmount).toBe(51000);
      // 确认请求 URL 含 orderStatus 筛选
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('orderStatus=PENDING'),
        mockContext,
      );
    });

    it('空结果应返回成功和提示信息', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      const result = await queryPurchaseOrders.execute({}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { total: number; message: string };
      expect(data.total).toBe(0);
      expect(data.message).toContain('未找到');
    });

    it('日期格式非法时应返回参数错误', async () => {
      const result = await queryPurchaseOrders.execute(
        { dateStart: '2026/07/01' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('YYYY-MM-DD');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.get.mockRejectedValue(new Error('network error'));

      const result = await queryPurchaseOrders.execute({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('查询采购单失败');
    });
  });

  // ── 3. QueryDeliveryStatusTool ──
  describe('QueryDeliveryStatusTool', () => {
    it('应正确查询配送状态并返回状态标签', async () => {
      mockServiceClient.get.mockResolvedValue({
        orderNo: 'SO20260730001',
        storeId: 1,
        customerType: 'WHOLESALE',
        fulfillmentType: 'DELIVERY',
        orderStatus: 'DELIVERING',
        payStatus: 'PAID',
        payableAmount: 51000,
        receiverName: '张三',
        receiverMobile: '13800000000',
        receiverAddress: 'XX路1号',
        createdAt: '2026-07-30',
        items: [
          {
            skuId: 10,
            skuName: '五粮液 500ml',
            quantity: 10,
            unitPrice: 850,
            subtotalAmount: 8500,
          },
        ],
      });

      const result = await queryDeliveryStatus.execute(
        { orderNo: 'SO20260730001' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as Record<string, unknown>;
      expect(data.orderStatusLabel).toBe('配送中');
      expect(data.receiverName).toBe('张三');
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        '/api/store/orders/SO20260730001',
        mockContext,
      );
    });

    it('orderNo 缺失时应返回参数错误', async () => {
      const result = await queryDeliveryStatus.execute({}, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('orderNo');
    });

    it('后端返回空时应返回错误', async () => {
      mockServiceClient.get.mockResolvedValue(null);

      const result = await queryDeliveryStatus.execute(
        { orderNo: 'SO_NOT_EXIST' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('不存在');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.get.mockRejectedValue(new Error('network error'));

      const result = await queryDeliveryStatus.execute(
        { orderNo: 'SO20260730001' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('查询配送状态失败');
    });
  });

  // ── 4. CreateDeliveryTool ──
  describe('CreateDeliveryTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createDelivery.execute(
        { orderNo: 'SO20260730001', confirm: false },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview!.operation).toBe('创建配送任务');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('执行模式（confirm=true）应调用 POST /api/store/orders/:orderNo/start-delivery', async () => {
      mockServiceClient.post.mockResolvedValue({
        orderNo: 'SO20260730001',
        status: 'DELIVERING',
      });

      const result = await createDelivery.execute(
        { orderNo: 'SO20260730001', confirm: true },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        orderNo: 'SO20260730001',
        status: 'DELIVERING',
      });
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        '/api/store/orders/SO20260730001/start-delivery',
        undefined,
        mockContext,
      );
    });

    it('orderNo 缺失时应返回参数错误', async () => {
      const result = await createDelivery.execute(
        { confirm: true },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('orderNo');
    });

    it('后端调用失败（状态不允许配送）时应返回错误', async () => {
      mockServiceClient.post.mockRejectedValue(
        Object.assign(new Error('订单不存在或状态不允许开始配送'), {
          statusCode: 400,
        }),
      );

      const result = await createDelivery.execute(
        { orderNo: 'SO20260730001', confirm: true },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('创建配送任务失败');
    });
  });
});
