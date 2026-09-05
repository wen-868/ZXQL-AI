/**
 * 总平台级写操作工具单元测试
 *
 * 覆盖：CreatePlatformAnnouncementTool、HandleSubscriptionApplyTool
 * - scope='platform' 声明
 * - 预览不落库 / confirm=true 调用真实端点
 * - HandleSubscriptionApplyTool：high 风险 + needsReview + reviewRequired
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { CreatePlatformAnnouncementTool } from './create-platform-announcement.tool';
import { HandleSubscriptionApplyTool } from './handle-subscription-apply.tool';

const mockContext: ToolContext = {
  tenantId: 'platform',
  userId: 'admin',
  // 测试假 JWT 运行时生成（避免硬编码凭据样式，Mimosa L3 门禁要求）
  authToken: `platform-jwt-${Date.now().toString(36)}`,
};

describe('总平台级工具', () => {
  let mockClient: {
    instance: ServiceClient & { post: jest.Mock; put: jest.Mock };
  };
  let post: jest.Mock;
  let put: jest.Mock;
  let announcement: CreatePlatformAnnouncementTool;
  let subscription: HandleSubscriptionApplyTool;

  beforeAll(async () => {
    const postMock = jest.fn().mockResolvedValue({ id: 1 });
    const putMock = jest.fn().mockResolvedValue({ id: 1 });
    mockClient = {
      instance: {
        get: jest.fn(),
        post: postMock,
        put: putMock,
        delete: jest.fn(),
      } as unknown as ServiceClient & { post: jest.Mock; put: jest.Mock },
    };
    post = postMock;
    put = putMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: ServiceClient, useValue: mockClient.instance },
        CreatePlatformAnnouncementTool,
        HandleSubscriptionApplyTool,
      ],
    }).compile();

    announcement = module.get(CreatePlatformAnnouncementTool);
    subscription = module.get(HandleSubscriptionApplyTool);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('两个工具都声明 scope=platform', () => {
    expect(announcement.scope).toBe('platform');
    expect(subscription.scope).toBe('platform');
  });

  it('创建公告预览不调用后端', async () => {
    const res = await announcement.execute(
      {
        title: '系统维护通知',
        type: 'MAINTENANCE',
        content: '8月17日 02:00 维护',
      },
      mockContext,
    );
    expect(res.success).toBe(true);
    expect(res.preview?.summary).toContain('系统维护通知');
    expect(post).not.toHaveBeenCalled();
  });

  it('创建公告 confirm=true 调用平台端点', async () => {
    await announcement.execute(
      {
        title: '系统维护通知',
        type: 'MAINTENANCE',
        content: '8月17日 02:00 维护',
        isTop: 1,
        confirm: true,
      },
      mockContext,
    );
    expect(post).toHaveBeenCalledWith(
      '/api/platform/announcements',
      expect.objectContaining({ title: '系统维护通知', isTop: 1 }),
      mockContext,
    );
  });

  it('订阅审核声明 high 风险且强制人工审核', () => {
    expect(subscription.risk).toBe('high');
    expect(subscription.needsReview).toBe(true);
  });

  it('订阅审核预览含 reviewRequired', async () => {
    const res = await subscription.execute(
      { applyId: 7, action: 'APPROVED', auditRemark: '资料齐全' },
      mockContext,
    );
    expect(res.success).toBe(true);
    expect(res.preview?.reviewRequired).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });

  it('订阅审核 confirm=true 调用审核端点', async () => {
    await subscription.execute(
      {
        applyId: 7,
        action: 'APPROVED',
        auditRemark: '资料齐全',
        confirm: true,
      },
      mockContext,
    );
    expect(put).toHaveBeenCalledWith(
      '/api/platform/subscription-applies/7/audit',
      { action: 'APPROVED', auditRemark: '资料齐全' },
      mockContext,
    );
  });
});
