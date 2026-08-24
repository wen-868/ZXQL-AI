/**
 * 第一批 P1 写操作工具（营销/采购/费用 8 个）单元测试
 *
 * 覆盖：CreateFullReductionTool、CreateGroupBuyTool、CreateGiftRuleTool、
 *       SetMarketingActivityStatusTool、CreatePurchasePaymentTool、
 *       CreatePurchaseReturnTool、CreatePurchaseContractTool、CreateExpenseTool
 * 每工具：预览不落库 / confirm=true 调用真实端点 / 关键参数校验
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { CreateFullReductionTool } from './create-full-reduction.tool';
import { CreateGroupBuyTool } from './create-group-buy.tool';
import { CreateGiftRuleTool } from './create-gift-rule.tool';
import { SetMarketingActivityStatusTool } from './set-marketing-activity-status.tool';
import { CreatePurchasePaymentTool } from './create-purchase-payment.tool';
import { CreatePurchaseReturnTool } from './create-purchase-return.tool';
import { CreatePurchaseContractTool } from './create-purchase-contract.tool';
import { CreateExpenseTool } from './create-expense.tool';

const mockContext: ToolContext = {
  tenantId: 'test-tenant',
  userId: 'test-user',
  authToken: 'test-token',
};

function createMockServiceClient(): {
  instance: ServiceClient;
  post: jest.Mock;
} {
  const post = jest.fn().mockResolvedValue({ id: 1 });
  return {
    instance: {
      get: jest.fn(),
      post,
      put: jest.fn(),
      delete: jest.fn(),
    } as unknown as ServiceClient,
    post,
  };
}

describe('第一批 P1 写操作工具', () => {
  let mockClient: ReturnType<typeof createMockServiceClient>;
  let fullReduction: CreateFullReductionTool;
  let groupBuy: CreateGroupBuyTool;
  let giftRule: CreateGiftRuleTool;
  let activityStatus: SetMarketingActivityStatusTool;
  let purchasePayment: CreatePurchasePaymentTool;
  let purchaseReturn: CreatePurchaseReturnTool;
  let purchaseContract: CreatePurchaseContractTool;
  let expense: CreateExpenseTool;

  beforeAll(async () => {
    mockClient = createMockServiceClient();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ServiceClient, useValue: mockClient.instance },
        CreateFullReductionTool,
        CreateGroupBuyTool,
        CreateGiftRuleTool,
        SetMarketingActivityStatusTool,
        CreatePurchasePaymentTool,
        CreatePurchaseReturnTool,
        CreatePurchaseContractTool,
        CreateExpenseTool,
      ],
    }).compile();

    fullReduction = module.get(CreateFullReductionTool);
    groupBuy = module.get(CreateGroupBuyTool);
    giftRule = module.get(CreateGiftRuleTool);
    activityStatus = module.get(SetMarketingActivityStatusTool);
    purchasePayment = module.get(CreatePurchasePaymentTool);
    purchaseReturn = module.get(CreatePurchaseReturnTool);
    purchaseContract = module.get(CreatePurchaseContractTool);
    expense = module.get(CreateExpenseTool);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CreateFullReductionTool', () => {
    it('预览展示多级满减规则，不调用后端', async () => {
      const res = await fullReduction.execute(
        {
          name: '国庆满减',
          rules: [
            { minAmount: 100, reduceAmount: 10 },
            { minAmount: 300, reduceAmount: 40 },
          ],
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-10-08 23:59:59',
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('满100减10');
      expect(res.preview?.summary).toContain('满300减40');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 创建满减活动', async () => {
      await fullReduction.execute(
        {
          name: '国庆满减',
          rules: [{ minAmount: 100, reduceAmount: 10 }],
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-10-08 23:59:59',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/full-reductions',
        expect.objectContaining({ name: '国庆满减', stackable: false }),
        mockContext,
      );
    });
  });

  describe('CreateGroupBuyTool', () => {
    it('confirm=true 创建拼团', async () => {
      await groupBuy.execute(
        {
          name: '三人成团',
          productId: 10,
          skuId: 101,
          groupPrice: 800,
          originalPrice: 1000,
          minGroupSize: 3,
          maxGroupSize: 10,
          totalStock: 100,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/group-buys',
        expect.objectContaining({
          minGroupSize: 3,
          maxGroupSize: 10,
          totalStock: 100,
        }),
        mockContext,
      );
    });

    it('成团人数非法返回错误', async () => {
      const res = await groupBuy.execute(
        {
          name: '拼团',
          productId: 10,
          skuId: 101,
          groupPrice: 800,
          originalPrice: 1000,
          minGroupSize: 1,
          maxGroupSize: 10,
          totalStock: 100,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
        },
        mockContext,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('minGroupSize');
    });
  });

  describe('CreateGiftRuleTool', () => {
    it('confirm=true 提交 snake_case 字段', async () => {
      await giftRule.execute(
        {
          ruleName: '满500赠礼',
          thresholdType: 'AMOUNT',
          thresholdAmount: 500,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
          levels: [{ giftProductId: 20, giftSkuId: 201, giftQuantity: 2 }],
          confirm: true,
        },
        mockContext,
      );
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/marketing/gift-rules');
      expect(body).toMatchObject({
        rule_name: '满500赠礼',
        threshold_type: 'AMOUNT',
        threshold_amount: 500,
        levels: [
          {
            gift_product_id: 20,
            gift_sku_id: 201,
            gift_quantity: 2,
            sort_order: 0,
          },
        ],
      });
    });
  });

  describe('SetMarketingActivityStatusTool', () => {
    it('激活秒杀调用对应端点', async () => {
      await activityStatus.execute(
        {
          activityType: 'flash_sale',
          activityId: 7,
          action: 'activate',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/flash-sales/7/activate',
        {},
        mockContext,
      );
    });

    it('暂停拼团调用对应端点', async () => {
      await activityStatus.execute(
        {
          activityType: 'group_buy',
          activityId: 8,
          action: 'pause',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/group-buys/8/pause',
        {},
        mockContext,
      );
    });
  });

  describe('CreatePurchasePaymentTool', () => {
    it('confirm=true 提交付款单 snake_case 字段', async () => {
      await purchasePayment.execute(
        {
          supplierId: 3,
          supplierName: '红星酒业',
          amount: 5000,
          paymentDate: '2026-08-16',
          paymentMethod: 'BANK',
          sourceNo: 'PO202608160001',
          confirm: true,
        },
        mockContext,
      );
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/purchase-payments');
      expect(body).toMatchObject({
        supplier_id: 3,
        supplier_name: '红星酒业',
        amount: 5000,
        payment_date: '2026-08-16',
        source_no: 'PO202608160001',
      });
    });
  });

  describe('CreatePurchaseReturnTool', () => {
    it('confirm=true 提交退货明细（含箱瓶换算字段）', async () => {
      await purchaseReturn.execute(
        {
          supplierId: 3,
          supplierName: '红星酒业',
          storeId: 1,
          orderNo: 'PO202608160001',
          items: [
            {
              skuId: 101,
              skuName: '五粮液',
              boxQty: 2,
              bottleQty: 1,
              unitPrice: 850,
            },
          ],
          confirm: true,
        },
        mockContext,
      );
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/purchase-returns');
      expect(body).toMatchObject({
        supplier_id: 3,
        store_id: 1,
        items: [
          {
            sku_id: 101,
            sku_name: '五粮液',
            box_qty: 2,
            bottle_qty: 1,
            unit_price: 850,
          },
        ],
      });
    });

    it('数量为 0 返回错误', async () => {
      const res = await purchaseReturn.execute(
        {
          supplierId: 3,
          supplierName: '红星酒业',
          storeId: 1,
          items: [{ skuId: 101, skuName: '五粮液', unitPrice: 850 }],
        },
        mockContext,
      );
      expect(res.success).toBe(false);
    });
  });

  describe('CreatePurchaseContractTool', () => {
    it('confirm=true 创建合同', async () => {
      await purchaseContract.execute(
        {
          supplierId: 3,
          contractName: '2026年度框架协议',
          contractType: '框架协议',
          totalAmount: 100000,
          signDate: '2026-08-16',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/purchase-contracts',
        expect.objectContaining({
          contractName: '2026年度框架协议',
          totalAmount: 100000,
          signDate: '2026-08-16',
        }),
        mockContext,
      );
    });
  });

  describe('CreateExpenseTool', () => {
    it('confirm=true 创建费用单', async () => {
      await expense.execute(
        {
          expenseType: 'OPERATING',
          category: '房租',
          amount: 8000,
          payee: '物业公司',
          paymentMethod: 'BANK',
          expenseDate: '2026-08-16',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/expenses',
        expect.objectContaining({
          category: '房租',
          amount: 8000,
          payee: '物业公司',
        }),
        mockContext,
      );
    });

    it('金额非法返回错误', async () => {
      const res = await expense.execute(
        {
          expenseType: 'OPERATING',
          category: '房租',
          amount: -1,
          payee: '物业',
          expenseDate: '2026-08-16',
        },
        mockContext,
      );
      expect(res.success).toBe(false);
    });
  });
});
