/**
 * ReviewTaskService 单元测试
 *
 * 覆盖：创建工单、列表过滤、审核通过、驳回、非 pending 状态拒绝审核
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { AiReviewTaskEntity } from '../../database/entities/ai-review-task.entity';
import { ReviewTaskService } from './review-task.service';

function makeEntity(
  overrides: Partial<AiReviewTaskEntity> = {},
): AiReviewTaskEntity {
  return {
    id: 1,
    tenantId: 't1',
    sessionId: 's1',
    graphId: 'sale_create_graph',
    nodeId: 'publish',
    toolName: 'searchCustomer',
    payload: { nodeLabel: '发布' },
    status: 'pending',
    rejectReason: null,
    createdBy: 'u1',
    reviewedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    reviewedAt: null,
    ...overrides,
  };
}

describe('ReviewTaskService', () => {
  let service: ReviewTaskService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };

  beforeEach(() => {
    repo = {
      create: jest.fn((e: AiReviewTaskEntity) => e),
      save: jest.fn((e: AiReviewTaskEntity) => Promise.resolve(e)),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    service = new ReviewTaskService(
      repo as unknown as Repository<AiReviewTaskEntity>,
    );
  });

  it('create 生成 pending 工单', async () => {
    repo.save.mockImplementation((e: AiReviewTaskEntity) => {
      e.id = 1;
      return Promise.resolve(e);
    });
    const view = await service.create({
      tenantId: 't1',
      sessionId: 's1',
      graphId: 'g1',
      nodeId: 'n1',
      toolName: 'publishVideo',
      payload: { videoId: 'v1' },
    });
    expect(view.status).toBe('pending');
    expect(view.toolName).toBe('publishVideo');
  });

  it('list 按租户 + 状态过滤', async () => {
    repo.find.mockResolvedValue([makeEntity({ status: 'pending' })]);
    const list = await service.list('t1', 'pending');
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 't1', status: 'pending' },
      }),
    );
    expect(list).toHaveLength(1);
  });

  it('approve 更新状态与审核人', async () => {
    repo.findOne.mockResolvedValue(makeEntity());
    const view = await service.approve(1, 'admin');
    expect(view.status).toBe('approved');
    expect(view.reviewedBy).toBe('admin');
    expect(view.reviewedAt).not.toBeNull();
  });

  it('reject 更新状态与驳回原因', async () => {
    repo.findOne.mockResolvedValue(makeEntity());
    const view = await service.reject(1, 'admin', '缺少资质');
    expect(view.status).toBe('rejected');
    expect(view.rejectReason).toBe('缺少资质');
  });

  it('已审核工单不可重复审核（Conflict）', async () => {
    repo.findOne.mockResolvedValue(makeEntity({ status: 'approved' }));
    await expect(service.approve(1, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('不存在的工单抛 404', async () => {
    await expect(service.get(99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
