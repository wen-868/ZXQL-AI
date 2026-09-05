/**
 * 审批处理工具单元测试
 *
 * 覆盖 HandleApprovalTool：high 风险/needsReview、预览（含 reviewRequired）、
 * 同意/驳回端点 URL、参数校验。
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-16
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ServiceClient } from '../../bridge/service-client';
import { ToolContext } from '../tool.interface';
import { HandleApprovalTool } from './handle-approval.tool';

const mockContext: ToolContext = {
  tenantId: 'test-tenant',
  userId: 'test-user',
  // 测试假 JWT 运行时生成（避免硬编码凭据样式，Mimosa L3 门禁要求）
  authToken: `test-token-${Date.now().toString(36)}`,
};

describe('HandleApprovalTool', () => {
  let tool: HandleApprovalTool;
  let post: jest.Mock;

  beforeAll(async () => {
    post = jest.fn().mockResolvedValue({ id: 1 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: ServiceClient,
          useValue: { get: jest.fn(), post, put: jest.fn(), delete: jest.fn() },
        },
        HandleApprovalTool,
      ],
    }).compile();
    tool = module.get(HandleApprovalTool);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('声明 high 风险且强制人工审核', () => {
    expect(tool.risk).toBe('high');
    expect(tool.needsReview).toBe(true);
  });

  it('预览含 reviewRequired 且不调用后端', async () => {
    const res = await tool.execute(
      { taskId: 10, action: 'approve', comment: '同意' },
      mockContext,
    );
    expect(res.success).toBe(true);
    expect(res.preview?.reviewRequired).toBe(true);
    expect(res.preview?.summary).toContain('同意审批任务 #10');
    expect(post).not.toHaveBeenCalled();
  });

  it('同意调用 approve 端点', async () => {
    await tool.execute(
      { taskId: 10, action: 'approve', confirm: true },
      mockContext,
    );
    expect(post).toHaveBeenCalledWith(
      '/api/admin/approval/tasks/10/approve',
      {},
      mockContext,
    );
  });

  it('驳回调用 reject 端点并携带意见', async () => {
    await tool.execute(
      { taskId: 11, action: 'reject', comment: '资料不全', confirm: true },
      mockContext,
    );
    expect(post).toHaveBeenCalledWith(
      '/api/admin/approval/tasks/11/reject',
      { comment: '资料不全' },
      mockContext,
    );
  });

  it('参数校验失败返回错误', async () => {
    const res = await tool.execute(
      { taskId: 0, action: 'approve' },
      mockContext,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('taskId');
  });
});
