/**
 * R70-13 财务+报表工具单元测试
 *
 * 测试覆盖：
 * 1. QueryReceivablesTool — 应收列表查询 + records 解析 + 空结果 + 参数校验 + 错误处理
 * 2. QueryPayablesTool — 应付列表查询 + records 解析 + 空结果 + 参数校验 + 错误处理
 * 3. CreateSalesReturnTool — 预览模式 + 执行模式 + 金额计算 + 参数校验 + 错误处理
 * 4. CreateRefundTool — 预览模式 + 执行模式 + 参数校验 + 错误处理
 * 5. CreatePaymentReconciliationTool — 预览模式 + 执行模式 + 参数校验 + 错误处理
 * 6. SalesReportTool — 销售日报 + 趋势 + 参数校验 + 错误处理
 * 7. InventoryReportTool — 库存报表 + 参数校验 + 错误处理
 * 8. ProfitReportTool — 利润报表 + 参数校验 + 错误处理
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { QueryReceivablesTool } from './query-receivables.tool';
import { QueryPayablesTool } from './query-payables.tool';
import { CreateSalesReturnTool } from './create-sales-return.tool';
import { CreateRefundTool } from './create-refund.tool';
import { CreatePaymentReconciliationTool } from './create-payment-reconciliation.tool';
import { SalesReportTool } from './sales-report.tool';
import { InventoryReportTool } from './inventory-report.tool';
import { ProfitReportTool } from './profit-report.tool';

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

describe('R70-13 财务+报表工具', () => {
  let mockServiceClient: ReturnType<typeof createMockServiceClient>;
  let queryReceivables: QueryReceivablesTool;
  let queryPayables: QueryPayablesTool;
  let createSalesReturn: CreateSalesReturnTool;
  let createRefund: CreateRefundTool;
  let createPaymentReconciliation: CreatePaymentReconciliationTool;
  let salesReport: SalesReportTool;
  let inventoryReport: InventoryReportTool;
  let profitReport: ProfitReportTool;

  beforeAll(async () => {
    mockServiceClient = createMockServiceClient();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        { provide: ServiceClient, useValue: mockServiceClient.instance },
        QueryReceivablesTool,
        QueryPayablesTool,
        CreateSalesReturnTool,
        CreateRefundTool,
        CreatePaymentReconciliationTool,
        SalesReportTool,
        InventoryReportTool,
        ProfitReportTool,
      ],
    }).compile();

    queryReceivables = module.get(QueryReceivablesTool);
    queryPayables = module.get(QueryPayablesTool);
    createSalesReturn = module.get(CreateSalesReturnTool);
    createRefund = module.get(CreateRefundTool);
    createPaymentReconciliation = module.get(CreatePaymentReconciliationTool);
    salesReport = module.get(SalesReportTool);
    inventoryReport = module.get(InventoryReportTool);
    profitReport = module.get(ProfitReportTool);
  });

  beforeEach(() => {
    mockServiceClient.get.mockClear();
    mockServiceClient.post.mockClear();
  });

  // ── 1. QueryReceivablesTool ──
  describe('QueryReceivablesTool', () => {
    it('应正确解析 records 字段并返回精简列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            id: 1,
            customerId: 5,
            customerName: '红星商行',
            sourceType: 'SALE_BILL',
            sourceNo: 'XS202607010001',
            receivableAmount: 51000,
            receivedAmount: 10000,
            balance: 41000,
            dueDate: '2026-08-15',
            status: 'PENDING',
            createdAt: '2026-07-01',
          },
        ],
      });

      const result = await queryReceivables.execute({}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { list: Array<Record<string, unknown>> };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].statusLabel).toBe('待收款');
      expect(data.list[0].balance).toBe(41000);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/receivables?'),
        mockContext,
      );
    });

    it('按客户ID筛选时 URL 应包含 customerId', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      await queryReceivables.execute({ customerId: 5 }, mockContext);

      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('customerId=5'),
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

      const result = await queryReceivables.execute({}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { total: number; message: string };
      expect(data.total).toBe(0);
      expect(data.message).toContain('未找到');
    });

    it('customerId 非法时应返回参数错误', async () => {
      const result = await queryReceivables.execute(
        { customerId: -1 },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('customerId');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.get.mockRejectedValue(new Error('network error'));
      const result = await queryReceivables.execute({}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('查询应收账款失败');
    });
  });

  // ── 2. QueryPayablesTool ──
  describe('QueryPayablesTool', () => {
    it('应正确查询应付账款（/payables 路径）', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            id: 2,
            supplierId: 3,
            supplierName: '红星酒业',
            sourceType: 'PURCHASE_ORDER',
            sourceNo: 'CG202607010001',
            payableAmount: 85000,
            paidAmount: 0,
            balance: 85000,
            dueDate: '2026-08-10',
            status: 'PENDING',
            createdAt: '2026-07-02',
          },
        ],
      });

      const result = await queryPayables.execute({}, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as { list: Array<Record<string, unknown>> };
      expect(data.list[0].statusLabel).toBe('待付款');
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/receivables/payables?'),
        mockContext,
      );
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.get.mockRejectedValue(new Error('network error'));
      const result = await queryPayables.execute({}, mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('查询应付账款失败');
    });
  });

  // ── 3. CreateSalesReturnTool ──
  describe('CreateSalesReturnTool', () => {
    it('预览模式（confirm=false）应返回 preview 且计算退款金额', async () => {
      const result = await createSalesReturn.execute(
        {
          storeId: 1,
          customerName: '红星商行',
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 2,
              unitPrice: 850,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview!.operation).toBe('创建销售退货单');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
      // 2箱×12瓶/箱×850元 = 20400
      const details = result.preview!.details;
      expect(details.refundAmount).toBe(20400);
    });

    it('执行模式（confirm=true）应调用 POST /api/admin/sale-returns', async () => {
      mockServiceClient.post.mockResolvedValue({ returnNo: 'TH202608010001' });

      const result = await createSalesReturn.execute(
        {
          storeId: 1,
          items: [
            {
              skuId: 10,
              skuName: '五粮液 500ml',
              boxQty: 1,
              unitPrice: 850,
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ returnNo: 'TH202608010001' });
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        '/api/admin/sale-returns',
        expect.objectContaining({
          storeId: 1,
          discountAmount: 0,
          items: [
            expect.objectContaining({
              skuId: 10,
              boxQty: 1,
              bottleQty: 0,
              unitPrice: 850,
            }),
          ],
        }),
        mockContext,
      );
    });

    it('items 为空时应返回参数错误', async () => {
      const result = await createSalesReturn.execute(
        { storeId: 1, items: [], confirm: true },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('items');
    });

    it('unitPrice 缺失时应返回参数错误', async () => {
      const result = await createSalesReturn.execute(
        {
          storeId: 1,
          items: [{ skuId: 10, skuName: '五粮液', boxQty: 1 }],
          confirm: true,
        },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('unitPrice');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.post.mockRejectedValue(new Error('network error'));
      const result = await createSalesReturn.execute(
        {
          storeId: 1,
          items: [{ skuId: 10, skuName: '五粮液', boxQty: 1, unitPrice: 850 }],
          confirm: true,
        },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('创建销售退货单失败');
    });
  });

  // ── 4. CreateRefundTool ──
  describe('CreateRefundTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createRefund.execute(
        { returnNo: 'TH202608010001', refundMethod: 'WECHAT', confirm: false },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview!.operation).toBe('退货退款');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('执行模式（confirm=true）应调用 POST :returnNo/refund', async () => {
      mockServiceClient.post.mockResolvedValue({
        returnNo: 'TH202608010001',
        status: 'REFUNDED',
      });

      const result = await createRefund.execute(
        { returnNo: 'TH202608010001', refundMethod: 'CASH', confirm: true },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        '/api/admin/sale-returns/TH202608010001/refund',
        { refundMethod: 'CASH' },
        mockContext,
      );
    });

    it('退款方式非法时应返回参数错误', async () => {
      const result = await createRefund.execute(
        { returnNo: 'TH202608010001', refundMethod: 'CREDIT', confirm: true },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('refundMethod');
    });

    it('后端调用失败时应返回错误', async () => {
      mockServiceClient.post.mockRejectedValue(new Error('退货单不存在'));
      const result = await createRefund.execute(
        { returnNo: 'TH202608010001', refundMethod: 'WECHAT', confirm: true },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('退款失败');
    });
  });

  // ── 5. CreatePaymentReconciliationTool ──
  describe('CreatePaymentReconciliationTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await createPaymentReconciliation.execute(
        { customerId: 5, confirm: false },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview!.operation).toBe('对账确认');
      expect(mockServiceClient.post).not.toHaveBeenCalled();
    });

    it('执行模式（confirm=true）应调用 POST /customer/:customerId/confirm', async () => {
      mockServiceClient.post.mockResolvedValue({ confirmed: true });

      const result = await createPaymentReconciliation.execute(
        { customerId: 5, confirm: true },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledWith(
        '/api/admin/reconciliation/customer/5/confirm',
        undefined,
        mockContext,
      );
    });

    it('customerId 非法时应返回参数错误', async () => {
      const result = await createPaymentReconciliation.execute(
        { customerId: 0, confirm: true },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('customerId');
    });
  });

  // ── 6. SalesReportTool ──
  describe('SalesReportTool', () => {
    it('销售日报应调用 /reports/sales-daily 并解析 records', async () => {
      mockServiceClient.get.mockResolvedValue({
        records: [{ date: '2026-07-31', salesAmount: 85000, orderCount: 12 }],
        totalSales: 85000,
        totalOrders: 12,
      });

      const result = await salesReport.execute(
        {
          reportType: 'daily',
          dateStart: '2026-07-01',
          dateEnd: '2026-07-31',
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: Array<Record<string, unknown>> };
      expect(data.list).toHaveLength(1);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/reports/sales-daily?'),
        mockContext,
      );
    });

    it('销售趋势应调用 /reports/sales-trend', async () => {
      mockServiceClient.get.mockResolvedValue({ trend: [] });

      const result = await salesReport.execute(
        { reportType: 'trend', granularity: 'month' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { reportType: string };
      expect(data.reportType).toBe('trend');
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        '/api/admin/reports/sales-trend?granularity=month',
        mockContext,
      );
    });

    it('日期格式非法时应返回参数错误', async () => {
      const result = await salesReport.execute(
        { dateStart: '20260701' },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('YYYY-MM-DD');
    });
  });

  // ── 7. InventoryReportTool ──
  describe('InventoryReportTool', () => {
    it('按商品分组应调用 /reports/inventory-summary?groupBy=product', async () => {
      mockServiceClient.get.mockResolvedValue({ list: [] });

      const result = await inventoryReport.execute(
        { groupBy: 'product' },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining(
          '/api/admin/reports/inventory-summary?groupBy=product',
        ),
        mockContext,
      );
    });

    it('storeId 非法时应返回参数错误', async () => {
      const result = await inventoryReport.execute(
        { storeId: -1 },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('storeId');
    });
  });

  // ── 8. ProfitReportTool ──
  describe('ProfitReportTool', () => {
    it('应调用 /reports/profit 并透传日期', async () => {
      mockServiceClient.get.mockResolvedValue({ profit: 1000 });

      const result = await profitReport.execute(
        { dateStart: '2026-07-01', dateEnd: '2026-07-31' },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        '/api/admin/reports/profit?dateStart=2026-07-01&dateEnd=2026-07-31',
        mockContext,
      );
    });

    it('日期格式非法时应返回参数错误', async () => {
      const result = await profitReport.execute(
        { dateEnd: '2026/07/31' },
        mockContext,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('YYYY-MM-DD');
    });
  });
});
