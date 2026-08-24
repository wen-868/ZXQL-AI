/**
 * EvolutionService 单元测试（P3 自主进化 SE 门控）
 *
 * 覆盖：提案+审核工单、newtool 安全边界、审核通过灰度、驳回、prompt 生效与回滚、状态机非法流转
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AiEvolutionEntity } from '../../database/entities/ai-evolution.entity';
import { AiConfigAdminService } from '../../tenant/ai-config-admin.service';
import { ReviewTaskService } from '../review/review-task.service';
import { ToolGeneratorService } from '../../tools/catalog/tool-generator.service';
import { ToolRegistry } from '../../tools/tool-registry';
import { EvolutionService } from './evolution.service';

function makeEvolution(
  overrides: Partial<AiEvolutionEntity> = {},
): AiEvolutionEntity {
  return {
    id: 1,
    tenantId: 't1',
    target: 'prompt',
    version: 1,
    status: 'proposed',
    currentSnapshot: '旧提示词',
    proposedDiff: '新提示词',
    rationale: '用户偏好',
    reviewId: 9,
    grayPercent: 0,
    proposedBy: 'u1',
    reviewedBy: null,
    createdAt: new Date(),
    rolledOutAt: null,
    ...overrides,
  };
}

describe('EvolutionService', () => {
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    count: jest.Mock;
  };
  let reviewTask: { create: jest.Mock; approve: jest.Mock; reject: jest.Mock };
  let aiConfigAdmin: { updateTenantConfig: jest.Mock };
  let toolGenerator: { generateAndRegister: jest.Mock };
  let registry: { unregister: jest.Mock };
  let service: EvolutionService;

  beforeEach(() => {
    repo = {
      create: jest.fn((e: AiEvolutionEntity) => e),
      save: jest.fn((e: AiEvolutionEntity) => Promise.resolve(e)),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    reviewTask = {
      create: jest.fn().mockResolvedValue({ id: 9 }),
      approve: jest.fn().mockResolvedValue({}),
      reject: jest.fn().mockResolvedValue({}),
    };
    aiConfigAdmin = { updateTenantConfig: jest.fn().mockResolvedValue({}) };
    toolGenerator = { generateAndRegister: jest.fn() };
    registry = { unregister: jest.fn() };
    service = new EvolutionService(
      repo as unknown as Repository<AiEvolutionEntity>,
      reviewTask as unknown as ReviewTaskService,
      aiConfigAdmin as unknown as AiConfigAdminService,
      toolGenerator as unknown as ToolGeneratorService,
      registry as unknown as ToolRegistry,
      { get: jest.fn(() => '20') } as unknown as ConfigService,
    );
  });

  it('propose 创建提案并自动生成审核工单', async () => {
    repo.save.mockImplementation((e: AiEvolutionEntity) => {
      e.id = 1;
      return Promise.resolve(e);
    });
    const entity = await service.propose({
      tenantId: 't1',
      target: 'prompt',
      proposed: '新提示词',
      rationale: '用户偏好',
    });
    expect(entity.status).toBe('proposed');
    expect(entity.reviewId).toBe(9);
    expect(reviewTask.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'evolution:prompt' }),
    );
  });

  it('newtool 提案非 /api/ 路径拒绝', async () => {
    await expect(
      service.propose({
        tenantId: 't1',
        target: 'newtool',
        proposed: JSON.stringify({
          name: 'api_bad',
          path: 'http://evil.com',
          risk: 'medium',
        }),
      }),
    ).rejects.toThrow('/api/');
  });

  it('newtool 提案 risk 为 low 拒绝（默认保守）', async () => {
    await expect(
      service.propose({
        tenantId: 't1',
        target: 'newtool',
        proposed: JSON.stringify({
          name: 'api_ok',
          path: '/api/admin/products',
          risk: 'low',
        }),
      }),
    ).rejects.toThrow('风险不得为 low');
  });

  it('approve 将 proposed 转 gray 并同步审核工单', async () => {
    repo.findOne.mockResolvedValue(makeEvolution());
    const entity = await service.approve(1, 'admin');
    expect(entity.status).toBe('gray');
    expect(entity.grayPercent).toBe(20);
    expect(reviewTask.approve).toHaveBeenCalledWith(9, 'admin');
  });

  it('reject 将 proposed 转 rejected', async () => {
    repo.findOne.mockResolvedValue(makeEvolution());
    const entity = await service.reject(1, 'admin', '理由不充分');
    expect(entity.status).toBe('rejected');
    expect(reviewTask.reject).toHaveBeenCalledWith(9, 'admin', '理由不充分');
  });

  it('rollout prompt 生效：更新租户系统提示词', async () => {
    repo.findOne.mockResolvedValue(
      makeEvolution({ status: 'gray', proposedDiff: '新提示词' }),
    );
    await service.rollout(1);
    expect(aiConfigAdmin.updateTenantConfig).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ systemPrompt: '新提示词' }),
    );
  });

  it('rollback 还原快照并置 rolled_back', async () => {
    repo.findOne.mockResolvedValue(
      makeEvolution({
        status: 'rolled_out',
        currentSnapshot: '旧提示词',
        proposedDiff: '新提示词',
      }),
    );
    const entity = await service.rollback(1, 'admin');
    expect(aiConfigAdmin.updateTenantConfig).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ systemPrompt: '旧提示词' }),
    );
    expect(entity.status).toBe('rolled_back');
  });

  it('非法状态流转被拒绝', async () => {
    repo.findOne.mockResolvedValue(makeEvolution({ status: 'rejected' }));
    await expect(service.approve(1, 'admin')).rejects.toThrow(
      '仅 proposed 可操作',
    );
  });
});
