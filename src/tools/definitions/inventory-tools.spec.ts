/**
 * R70-10 库存工具单元测试
 *
 * 测试覆盖：
 * 1. InventoryTransferTool — 预览模式 + 执行模式 + 参数校验 + 单价填充 + 错误处理
 * 2. StockCheckTool — 预览模式 + 执行模式 + 参数校验 + 错误处理
 * 3. QueryInventoryTool — records 字段解析 + 库存状态标签 + 空结果 + 参数校验 + 错误处理
 * 4. CheckInventoryTool — records 字段兼容（R70-09 遗留修复验证）
 *
 * 负责人: 阿坚 | 创建日期: 2026-08-01
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { InventoryTransferTool } from './inventory-transfer.tool';
import { StockCheckTool } from './stock-check.tool';
import { QueryInventoryTool } from './query-inventory.tool';
import { CheckInventoryTool } from './check-inventory.tool';

const mockContext: ToolContext = {
  tenantId: 'test-tenant',
  userId: 'test-user',
  // 测试假 JWT 运行时生成（避免硬编码凭据样式，Mimosa L3 门禁要求）
  authToken: `test-token-${Date.now().toString(36)}`,
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

describe('R70-10 库存工具', () => {
  let mockServiceClient: ReturnType<typeof createMockServiceClient>;
  let inventoryTransfer: InventoryTransferTool;
  let stockCheck: StockCheckTool;
  let queryInventory: QueryInventoryTool;
  let checkInventory: CheckInventoryTool;

  beforeAll(async () => {
    mockServiceClient = createMockServiceClient();

    const module: TestingModule = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true })],
      providers: [
        { provide: ServiceClient, useValue: mockServiceClient.instance },
        InventoryTransferTool,
        StockCheckTool,
        QueryInventoryTool,
        CheckInventoryTool,
      ],
    }).compile();

    inventoryTransfer = module.get(InventoryTransferTool);
    stockCheck = module.get(StockCheckTool);
    queryInventory = module.get(QueryInventoryTool);
    checkInventory = module.get(CheckInventoryTool);
  });

  beforeEach(() => {
    mockServiceClient.get.mockClear();
    mockServiceClient.post.mockClear();
  });

  // ── 1. InventoryTransferTool ──
  describe('InventoryTransferTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          fromStoreName: '1号仓',
          toStoreId: 2,
          toStoreName: '2号仓',
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              quantity: 50,
              unitPrice: 850,
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview?.operation).toBe('库存调拨');
      expect(mockServiceClient.post).not.toHaveBeenCalled();

      // 验证预览包含调出/调入仓库 + 商品明细 + 合计
      const details = result.preview?.details as Record<string, unknown>;
      expect(details.fromStoreId).toBe(1);
      expect(details.toStoreId).toBe(2);
      expect(details.totalAmount).toBe(42500); // 50 * 850
      const items = details.items as Array<{
        skuName: string;
        quantity: number;
        unitPrice: number;
        priceSource: string;
      }>;
      expect(items[0].skuName).toBe('五粮液 500ml');
      expect(items[0].quantity).toBe(50);
      expect(items[0].unitPrice).toBe(850);
      expect(items[0].priceSource).toContain('用户指定');
    });

    it('执行模式（confirm=true）应调用后端 POST 创建调拨单', async () => {
      mockServiceClient.post.mockResolvedValue({
        id: 1,
        transferNo: 'DB20260801001',
      });

      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 2,
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              quantity: 50,
              unitPrice: 850,
            },
          ],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledTimes(1);
      // 验证请求体字段与后端 controller 对齐
      const [path, body] = mockServiceClient.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toContain('/api/admin/transfer-orders');
      expect(body.fromStoreId).toBe(1);
      expect(body.toStoreId).toBe(2);
      expect((body.items as Array<{ unitPrice: number }>)[0].unitPrice).toBe(
        850,
      );

      const data = result.data as { transferNo: string; status: string };
      expect(data.transferNo).toBe('DB20260801001');
      expect(data.status).toBe('DRAFT');
    });

    it('未指定单价但有成本价时应自动应用成本价', async () => {
      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 2,
          items: [
            {
              skuId: 101,
              skuName: '五粮液 500ml',
              quantity: 10,
              productInfo: { costPrice: 800 },
            },
          ],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview?.details as Record<string, unknown>;
      const items = details.items as Array<{
        unitPrice: number;
        priceSource: string;
      }>;
      expect(items[0].unitPrice).toBe(800);
      expect(items[0].priceSource).toContain('成本价');
    });

    it('未指定单价且无成本价时应生成警告但不阻止', async () => {
      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 2,
          items: [{ skuId: 101, skuName: '五粮液 500ml', quantity: 10 }],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      const details = result.preview?.details as Record<string, unknown>;
      const warnings = details.warnings as string[];
      expect(warnings).toBeDefined();
      expect(warnings[0]).toContain('未指定单价');
    });

    it('调出与调入门店相同应返回参数错误', async () => {
      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 1,
          items: [{ skuId: 101, quantity: 10 }],
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('不能相同');
    });

    it('缺少 fromStoreId 应返回参数错误', async () => {
      const result = await inventoryTransfer.execute(
        { toStoreId: 2, items: [{ skuId: 101, quantity: 10 }] },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('fromStoreId');
    });

    it('空 items 应返回参数错误', async () => {
      const result = await inventoryTransfer.execute(
        { fromStoreId: 1, toStoreId: 2, items: [] },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('items');
    });

    it('quantity 为0应返回参数错误', async () => {
      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 2,
          items: [{ skuId: 101, quantity: 0 }],
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('quantity');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.post.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await inventoryTransfer.execute(
        {
          fromStoreId: 1,
          toStoreId: 2,
          items: [{ skuId: 101, quantity: 10, unitPrice: 850 }],
          confirm: true,
        },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('创建调拨单失败');
    });
  });

  // ── 2. StockCheckTool ──
  describe('StockCheckTool', () => {
    it('预览模式（confirm=false）应返回 preview 而不调用后端', async () => {
      const result = await stockCheck.execute(
        {
          storeId: 1,
          remark: '月度盘点',
          items: [{ skuId: 101, skuName: '五粮液 500ml', bookQty: 200 }],
          confirm: false,
        },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(result.preview).toBeDefined();
      expect(result.preview?.operation).toBe('创建盘点单');
      expect(mockServiceClient.post).not.toHaveBeenCalled();

      const details = result.preview?.details as Record<string, unknown>;
      expect(details.storeId).toBe(1);
      expect(details.remark).toBe('月度盘点');
    });

    it('执行模式（confirm=true）应调用后端 POST 创建盘点单', async () => {
      mockServiceClient.post.mockResolvedValue({
        checkId: 1,
        checkNo: 'PD20260801001',
      });

      const result = await stockCheck.execute(
        { storeId: 1, remark: '月度盘点', confirm: true },
        mockContext,
      );

      expect(result.success).toBe(true);
      expect(mockServiceClient.post).toHaveBeenCalledTimes(1);
      const [path, body] = mockServiceClient.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toContain('/api/admin/stock-checks');
      expect(body.storeId).toBe(1);
      expect(body.remark).toBe('月度盘点');

      const data = result.data as { checkNo: string; status: string };
      expect(data.checkNo).toBe('PD20260801001');
      expect(data.status).toBe('DRAFT');
    });

    it('缺少 storeId 应返回参数错误', async () => {
      const result = await stockCheck.execute({ remark: '盘点' }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('storeId');
    });

    it('storeId 非正整数应返回参数错误', async () => {
      const result = await stockCheck.execute({ storeId: 0 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('storeId');
    });

    it('items 非数组应返回参数错误', async () => {
      const result = await stockCheck.execute(
        { storeId: 1, items: 'not-array' },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('items');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.post.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await stockCheck.execute(
        { storeId: 1, confirm: true },
        mockContext,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('创建盘点单失败');
    });
  });

  // ── 3. QueryInventoryTool ──
  describe('QueryInventoryTool', () => {
    it('按 storeId 查询应返回库存汇总列表和状态标签', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 2,
        page: 1,
        pageSize: 20,
        records: [
          {
            storeId: 1,
            storeName: '1号仓',
            skuId: 101,
            skuName: '五粮液 500ml',
            barcode: '6901234567890',
            stockType: 'NORMAL',
            physicalQty: 7,
            availableQty: 5,
            lockedQty: 2,
            boxRatio: 6,
            boxUnit: '箱',
            baseUnit: '瓶',
          },
          {
            storeId: 1,
            storeName: '1号仓',
            skuId: 102,
            skuName: '茅台 500ml',
            barcode: '6901234567891',
            stockType: 'NORMAL',
            physicalQty: 200,
            availableQty: 200,
            lockedQty: 0,
          },
        ],
      });

      const result = await queryInventory.execute({ storeId: 1 }, mockContext);

      expect(result.success).toBe(true);
      // 验证请求路径包含 storeId 参数
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('/api/admin/inventory-balance?'),
        mockContext,
      );
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('storeId=1'),
        mockContext,
      );

      const data = result.data as {
        list: Array<{
          skuName: string;
          stockStatus: string;
          boxRatio: number;
          boxUnit: string;
          baseUnit: string;
        }>;
        summary: { totalAvailable: number; storeCount: number };
      };
      expect(data.list).toHaveLength(2);
      expect(data.list[0].stockStatus).toBe('库存不足'); // 5 < 10
      expect(data.list[1].stockStatus).toBe('库存充足'); // 200 >= 50
      // 规格换算信息应透传给 LLM（用于箱/瓶换算展示）
      expect(data.list[0].boxRatio).toBe(6);
      expect(data.list[0].boxUnit).toBe('箱');
      expect(data.list[0].baseUnit).toBe('瓶');
      expect(data.summary.totalAvailable).toBe(205); // 5 + 200
      expect(data.summary.storeCount).toBe(1);
    });

    it('keyword 可选：无筛选条件查询全部库存', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            storeId: 1,
            storeName: '1号仓',
            skuId: 101,
            skuName: '五粮液 500ml',
            barcode: '6901234567890',
            stockType: 'NORMAL',
            physicalQty: 100,
            availableQty: 100,
            lockedQty: 0,
          },
        ],
      });

      const result = await queryInventory.execute({}, mockContext);

      expect(result.success).toBe(true);
      expect(mockServiceClient.get).toHaveBeenCalledWith(
        expect.stringContaining('page=1&pageSize=20'),
        mockContext,
      );
    });

    it('空结果应返回成功+空列表+筛选描述', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      const result = await queryInventory.execute({ storeId: 99 }, mockContext);

      expect(result.success).toBe(true);
      const data = result.data as {
        list: unknown[];
        total: number;
        message: string;
      };
      expect(data.list).toHaveLength(0);
      expect(data.total).toBe(0);
      expect(data.message).toContain('门店 99');
    });

    it('storeId 非正整数应返回参数错误', async () => {
      const result = await queryInventory.execute({ storeId: -1 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('storeId');
    });

    it('category 非正整数应返回参数错误', async () => {
      const result = await queryInventory.execute({ category: 0 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('category');
    });

    it('后端错误应返回错误信息', async () => {
      mockServiceClient.get.mockRejectedValue(
        new Error('后端 HTTP 500：服务器内部错误'),
      );

      const result = await queryInventory.execute({ storeId: 1 }, mockContext);

      expect(result.success).toBe(false);
      expect(result.error).toContain('查询库存汇总失败');
    });
  });

  // ── 4. CheckInventoryTool records 字段兼容（R70-09 遗留修复验证） ──
  describe('CheckInventoryTool records 兼容', () => {
    it('后端返回 records 字段（真实形态）应正确解析', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 1,
        page: 1,
        pageSize: 20,
        records: [
          {
            storeId: 1,
            storeName: '1号仓',
            skuId: 101,
            skuName: '五粮液 500ml',
            barcode: '6901234567890',
            stockType: 'NORMAL',
            physicalQty: 7,
            availableQty: 5,
            lockedQty: 2,
            boxRatio: 6,
            boxUnit: '箱',
            baseUnit: '瓶',
          },
        ],
      });

      const result = await checkInventory.execute(
        { keyword: '五粮液' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        list: Array<{
          skuName: string;
          stockStatus: string;
          boxRatio: number;
          boxUnit: string;
          baseUnit: string;
        }>;
        total: number;
      };
      expect(data.list).toHaveLength(1);
      expect(data.list[0].skuName).toBe('五粮液 500ml');
      expect(data.list[0].stockStatus).toBe('库存不足');
      expect(data.list[0].boxRatio).toBe(6);
      expect(data.list[0].boxUnit).toBe('箱');
      expect(data.list[0].baseUnit).toBe('瓶');
      expect(data.total).toBe(1);
    });

    it('records 为空列表应返回成功+空列表', async () => {
      mockServiceClient.get.mockResolvedValue({
        total: 0,
        page: 1,
        pageSize: 20,
        records: [],
      });

      const result = await checkInventory.execute(
        { keyword: '不存在' },
        mockContext,
      );

      expect(result.success).toBe(true);
      const data = result.data as { list: unknown[]; message: string };
      expect(data.list).toHaveLength(0);
      expect(data.message).toContain('不存在');
    });
  });
});
