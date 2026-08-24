/**
 * P1-1 EvolutionVersionService 单元测试
 *
 * 覆盖：staged 提案生成、人工激活、回滚、列表、当前版本。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { AiEvolutionVersionEntity } from '../database/entities/ai-evolution-version.entity';
import { EvolutionVersionService } from './evolution-version.service';

function createService() {
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  } as unknown as Repository<AiEvolutionVersionEntity>;
  return { service: new EvolutionVersionService(repo), repo };
}

describe('P1-1 EvolutionVersionService', () => {
  it('stage：生成 staged 提案（trigger=auto_learn 默认）', async () => {
    const { service, repo } = createService();
    const entity = await service.stage({
      artifact: 'write_schema.customer_create',
      fromVersion: 'v1',
      toVersion: 'v2',
      changeSummary: '手机号改为可选',
    });
    expect(entity.artifact).toBe('write_schema.customer_create');
    expect(entity.status).toBe('staged');
    expect(entity.trigger).toBe('auto_learn');
    expect(repo.save).toHaveBeenCalled();
  });

  it('activate：staged → active 并记录审批人', async () => {
    const { service, repo } = createService();
    repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      artifact: 'write_schema.customer_create',
      status: 'staged',
    });
    const entity = await service.activate(1, 'admin');
    expect(entity.status).toBe('active');
    expect(entity.approvedBy).toBe('admin');
  });

  it('activate：非 staged 状态拒绝激活', async () => {
    const { service, repo } = createService();
    repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      artifact: 'x',
      status: 'rolled_back',
    });
    await expect(service.activate(1, 'admin')).rejects.toThrow('仅 staged');
  });

  it('rollback：active → rolled_back', async () => {
    const { service, repo } = createService();
    repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      artifact: 'write_schema.customer_create',
      fromVersion: 'v1',
      status: 'active',
    });
    const entity = await service.rollback(1, 'admin');
    expect(entity.status).toBe('rolled_back');
  });

  it('currentVersion：返回最近 active 版本', async () => {
    const { service, repo } = createService();
    repo.findOne = jest
      .fn()
      .mockResolvedValue({ artifact: 'x', toVersion: 'v3', status: 'active' });
    expect(await service.currentVersion('x')).toBe('v3');
  });

  it('list：按 artifact/status 过滤', async () => {
    const { service, repo } = createService();
    const qb = {
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    repo.createQueryBuilder = jest.fn(() => qb) as never;
    await service.list('write_schema.x', 'active');
    expect(qb.where).toHaveBeenCalledWith('v.artifact = :artifact', {
      artifact: 'write_schema.x',
    });
    expect(qb.andWhere).toHaveBeenCalledWith('v.status = :status', {
      status: 'active',
    });
  });
});
