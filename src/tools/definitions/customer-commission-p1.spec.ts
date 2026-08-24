/**
 * 第一批收口 P1 写操作工具（客户/佣金/催收/限量折扣 6 个）单元测试
 *
 * 覆盖：CreateCustomerSegmentTool、ExecuteCareRuleTool、CreateCustomerVisitTool、
 *       CalculateCommissionTool、AutoGenerateCollectionsTool、CreateLimitedDiscountTool
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { CreateCustomerSegmentTool } from './create-customer-segment.tool';
import { ExecuteCareRuleTool } from './execute-care-rule.tool';
import { CreateCustomerVisitTool } from './create-customer-visit.tool';
import { CalculateCommissionTool } from './calculate-commission.tool';
import { AutoGenerateCollectionsTool } from './auto-generate-collections.tool';
import { CreateLimitedDiscountTool } from './create-limited-discount.tool';

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

describe('第一批收口 P1 写操作工具', () => {
  let mockClient: ReturnType<typeof createMockServiceClient>;
  let segment: CreateCustomerSegmentTool;
  let care: ExecuteCareRuleTool;
  let visit: CreateCustomerVisitTool;
  let commission: CalculateCommissionTool;
  let autoCollections: AutoGenerateCollectionsTool;
  let limitedDiscount: CreateLimitedDiscountTool;

  beforeAll(async () => {
    mockClient = createMockServiceClient();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ServiceClient, useValue: mockClient.instance },
        CreateCustomerSegmentTool,
        ExecuteCareRuleTool,
        CreateCustomerVisitTool,
        CalculateCommissionTool,
        AutoGenerateCollectionsTool,
        CreateLimitedDiscountTool,
      ],
    }).compile();

    segment = module.get(CreateCustomerSegmentTool);
    care = module.get(ExecuteCareRuleTool);
    visit = module.get(CreateCustomerVisitTool);
    commission = module.get(CalculateCommissionTool);
    autoCollections = module.get(AutoGenerateCollectionsTool);
    limitedDiscount = module.get(CreateLimitedDiscountTool);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('CreateCustomerSegmentTool', () => {
    it('预览展示条件数，不调用后端', async () => {
      const res = await segment.execute(
        {
          segmentName: '批发大客户',
          conditions: {
            customerType: 'wholesale',
            totalAmount: { '>': 10000 },
          },
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('2 个条件');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 创建分群', async () => {
      await segment.execute(
        {
          segmentName: '批发大客户',
          conditions: { customerType: 'wholesale' },
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/members/segments',
        expect.objectContaining({
          segmentName: '批发大客户',
          autoRefresh: false,
        }),
        mockContext,
      );
    });
  });

  describe('ExecuteCareRuleTool', () => {
    it('confirm=true 执行关怀规则', async () => {
      await care.execute({ ruleId: 5, confirm: true }, mockContext);
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/members/care/rules/5/execute',
        {},
        mockContext,
      );
    });

    it('预览不调用后端', async () => {
      const res = await care.execute({ ruleId: 5 }, mockContext);
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('#5');
      expect(mockClient.post).not.toHaveBeenCalled();
    });
  });

  describe('CreateCustomerVisitTool', () => {
    it('confirm=true 提交拜访（snake_case）', async () => {
      await visit.execute(
        {
          customerId: 88,
          customerName: '红星商行',
          storeId: 1,
          visitDate: '2026-08-16',
          visitType: 'ONSITE',
          visitPurpose: 'COLLECTION',
          visitSummary: '沟通回款',
          confirm: true,
        },
        mockContext,
      );
      const [path, body] = mockClient.post.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(path).toBe('/api/admin/customer-visits');
      expect(body).toMatchObject({
        customer_id: 88,
        customer_name: '红星商行',
        store_id: 1,
        visit_type: 'ONSITE',
        visit_purpose: 'COLLECTION',
        visit_date: '2026-08-16',
        follow_up_required: 0,
      });
    });
  });

  describe('CalculateCommissionTool', () => {
    it('confirm=true 调用佣金计算端点', async () => {
      await commission.execute(
        { startDate: '2026-08-01', endDate: '2026-08-31', confirm: true },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/commission/calculate',
        { startDate: '2026-08-01', endDate: '2026-08-31' },
        mockContext,
      );
    });
  });

  describe('AutoGenerateCollectionsTool', () => {
    it('confirm=true 调用自动生成催收端点', async () => {
      await autoCollections.execute({ confirm: true }, mockContext);
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/credits/collections/auto-generate',
        {},
        mockContext,
      );
    });
  });

  describe('CreateLimitedDiscountTool', () => {
    it('预览展示折扣', async () => {
      const res = await limitedDiscount.execute(
        {
          name: '周末限量折扣',
          discountType: 'PERCENTAGE',
          discountValue: 20,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-02 23:59:59',
        },
        mockContext,
      );
      expect(res.success).toBe(true);
      expect(res.preview?.summary).toContain('8.0折');
      expect(mockClient.post).not.toHaveBeenCalled();
    });

    it('confirm=true 创建限量折扣', async () => {
      await limitedDiscount.execute(
        {
          name: '周末限量折扣',
          discountType: 'FIXED',
          discountValue: 50,
          startTime: '2026-09-01 00:00:00',
          endTime: '2026-09-02 23:59:59',
          limitPerUser: 2,
          confirm: true,
        },
        mockContext,
      );
      expect(mockClient.post).toHaveBeenCalledWith(
        '/api/admin/marketing/limited-discounts',
        expect.objectContaining({
          discountType: 'FIXED',
          discountValue: 50,
          limitPerUser: 2,
        }),
        mockContext,
      );
    });
  });
});
