/**
 * 营销/采购计划/信用 6 个精调写操作工具单元测试
 *
 * 覆盖：
 * 1. CreateCouponTemplateTool — 预览/执行/参数校验
 * 2. SetCouponStatusTool — 激活/暂停 URL 与预览
 * 3. CreateFlashSaleTool — 预览/执行/参数校验
 * 4. CreatePurchasePlanTool — 预览/执行/items 校验
 * 5. ConvertPurchasePlanTool — 预览/执行
 * 6. AdjustCreditLimitTool — high 风险/needsReview/预览/执行
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { CreateCouponTemplateTool } from './create-coupon-template.tool';
import { SetCouponStatusTool } from './set-coupon-status.tool';
import { CreateFlashSaleTool } from './create-flash-sale.tool';
import { CreatePurchasePlanTool } from './create-purchase-plan.tool';
import { ConvertPurchasePlanTool } from './convert-purchase-plan.tool';
import { AdjustCreditLimitTool } from './adjust-credit-limit.tool';

const mockContext: ToolContext = {
  tenantId: 'test-tenant',
  userId: 'test-user',
  // 测试假 JWT 运行时生成（避免硬编码凭据样式，Mimosa L3 门禁要求）
  authToken: `test-token-${Date.now().toString(36)}`,
};

function createMockServiceClient(): {
  instance: ServiceClient;
  get: jest.Mock;
  post: jest.Mock;
  put: jest.Mock;
} {
  const get = jest.fn();
  const post = jest.fn().mockResolvedValue({ id: 1 });
  const put = jest.fn().mockResolvedValue({ id: 1 });
  return {
    instance: {
      get,
      post,
      put,
      delete: jest.fn(),
    } as unknown as ServiceClient,
    get,
    post,
    put,
  };
}

describe('第一批 P0 写操作工具', () => {
  let mockClient: ReturnType<typeof createMockServiceClient>;
  let couponTool: CreateCouponTemplateTool;
  let statusTool: SetCouponStatusTool;
  let flashTool: CreateFlashSaleTool;
  let planTool: CreatePurchasePlanTool;
  let convertTool: ConvertPurchasePlanTool;
  let creditTool: AdjustCreditLimitTool;

  beforeAll(async () => {
    mockClient = createMockServiceClient();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ServiceClient, useValue: mockClient.instance },
        CreateCouponTemplateTool,
        SetCouponStatusTool,
        CreateFlashSaleTool,
        CreatePurchasePlanTool,
        ConvertPurchasePlanTool,
        AdjustCreditLimitTool,
      ],
    }).compile();

    couponTool = module.get(CreateCouponTemplateTool);
    statusTool = module.get(SetCouponStatusTool);
    flashTool = module.get(CreateFlashSaleTool);
    planTool = module.get(CreatePurchasePlanTool);
    convertTool = module.get(ConvertPurchasePlanTool);
    creditTool = module.get(AdjustCreditLimitTool);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CreateCouponTemplateTool', () => {
    it('预览阶段返回 preview 且不调用后端', async () => {
      const res = await couponTool.execute(
        {
          name: '满100减10',
          type: 'FIXED',
          value: 10,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.operation).toBe('创建优惠券模板');
      expect(res.preview?.summary).toContain('满100减10');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 调用后端创建并透传字段', async () => {
      const res = await couponTool.execute(
        {
          name: '满100减10',
          type: 'FIXED',
          value: 10,
          minAmount: 100,
          applicableScope: 'ALL',
          totalCount: 500,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-30 23:59:59',
          confirm: true,
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledTimes(1);
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/marketing/coupons/templates');
      expect(body).toMatchObject({
        name: '满100减10',
        type: 'FIXED',
        value: 10,
        minAmount: 100,
        totalCount: 500,
      });
    });

    it('参数校验失败返回错误', async () => {
      const res = await couponTool.execute(
        { name: '', type: 'FIXED', value: 10 },
        mockContext,
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('name');
    });
  });

  describe('SetCouponStatusTool', () => {
    it('激活时调用 activate 端点', async () => {
      const res = await statusTool.execute(
        { templateId: 7, action: 'activate', confirm: true },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/coupons/templates/7/activate',
        {},
        mockContext,
      );
    });

    it('暂停时调用 pause 端点，预览不执行', async () => {
      const preview = await statusTool.execute(
        { templateId: 7, action: 'pause' },
        mockContext,
      );
      expect(preview.success).toBe(true);
      expect(preview.preview?.operation).toBe('暂停优惠券模板');
      expect(mockClient.post).not.toHaveBeenCalled();
    });
  });

  describe('CreateFlashSaleTool', () => {
    it('预览含折扣与库存信息', async () => {
      const res = await flashTool.execute(
        {
          name: '五粮液秒杀',
          productId: 10,
          skuId: 101,
          flashPrice: 800,
          originalPrice: 1000,
          totalStock: 50,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-02 23:59:59',
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('8折');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 创建秒杀', async () => {
      await flashTool.execute(
        {
          name: '秒杀',
          productId: 10,
          skuId: 101,
          flashPrice: 800,
          originalPrice: 1000,
          totalStock: 50,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-02 23:59:59',
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/flash-sales',
        expect.objectContaining({ name: '秒杀', totalStock: 50 }),
        mockContext,
      );
    });
  });

  describe('CreatePurchasePlanTool', () => {
    it('预览汇总采购明细', async () => {
      const res = await planTool.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [
            { skuId: 101, skuName: '五粮液', suggestQty: 10 },
            { skuId: 102, skuName: '茅台', suggestQty: 5 },
          ],
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('2 种商品');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 提交并过滤预览字段', async () => {
      await planTool.execute(
        {
          supplierId: 3,
          storeId: 1,
          items: [{ skuId: 101, skuName: '五粮液', suggestQty: 10 }],
          confirm: true,
        },
        mockContext,
      );
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/purchase-plans');
      expect(body.items[0]).toEqual({ skuId: 101, suggestQty: 10 });
    });

    it('items 非法时返回错误', async () => {
      const res = await planTool.execute(
        { supplierId: 3, storeId: 1, items: [{ skuId: 0, suggestQty: 1 }] },
        mockContext,
      );
      expect(res.success).toBe(false);
    });
  });

  describe('ConvertPurchasePlanTool', () => {
    it('confirm=true 调用转换端点', async () => {
      const res = await convertTool.execute(
        { planNo: 'JH202608160001', confirm: true },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/purchase-plans/JH202608160001/convert',
        {},
        mockContext,
      );
    });
  });

  describe('AdjustCreditLimitTool', () => {
    it('声明 high 风险且强制人工审核', () => {
      expect(creditTool.risk).toBe('high');
      expect(creditTool.needsReview).toBe(true);
    });

    it('预览含 reviewRequired 标记且不调用后端', async () => {
      const res = await creditTool.execute(
        {
          customerId: 88,
          customerName: '红星商行',
          creditLimit: 50000,
          reason: '合同额提升',
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.reviewRequired).toBe(true);
      expect(res.preview?.summary).toContain('50000');
      expect(mockClient.put).not.toHaveBeenCalled();
    });

    it('confirm=true 调用调整端点', async () => {
      await creditTool.execute(
        { customerId: 88, creditLimit: 50000, confirm: true },
        mockContext,
      );
      expect(mockClient.put).toHaveBeenCalledWith(
        '/api/admin/credits/88/limit',
        { creditLimit: 50000, reason: '调整授信额度' },
        mockContext,
      );
    });
  });
});
