/**
 * P0-3 McpTokenService 单元测试
 *
 * 覆盖：生成（mcp_ 前缀/唯一）、列表、启停、删除、校验（enabled/过期）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
import { Repository } from 'typeorm';
import { McpTokenEntity } from '../../database/entities/mcp-token.entity';
import { McpTokenService } from './mcp-token.service';

function createService(repo: Partial<Repository<McpTokenEntity>>): {
  service: McpTokenService;
  repo: jest.Mocked<Repository<McpTokenEntity>>;
} {
  const mocked = {
    create: jest.fn((data: Partial<McpTokenEntity>) => data),
    save: jest.fn((data) => Promise.resolve({ id: 1, ...data })),
    createQueryBuilder: jest.fn(),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
    findOne: jest.fn(),
    ...repo,
  } as unknown as Repository<McpTokenEntity>;
  return { service: new McpTokenService(mocked), repo: jest.mocked(mocked) };
}

describe('P0-3 McpTokenService', () => {
  it('生成 Token：mcp_ 前缀 + 绑定租户 + 名称', async () => {
    const { service } = createService({});
    const entity = await service.create({
      tenantId: 't_001',
      name: 'WorkBuddy对接',
    });

    expect(entity.token).toMatch(/^mcp_[a-f0-9]{64}$/);
    expect(entity.tenantId).toBe('t_001');
    expect(entity.name).toBe('WorkBuddy对接');
    expect(entity.enabled).toBe(1);
    expect(entity.expiresAt).toBeNull();
  });

  it('生成 Token：支持过期时间', async () => {
    const { service } = createService({});
    const expiresAt = new Date(Date.now() + 86400000);
    const entity = await service.create({ tenantId: 't_001', expiresAt });
    expect(entity.expiresAt).toBe(expiresAt);
  });

  it('列表：支持租户过滤', async () => {
    const qb: {
      orderBy: jest.Mock;
      where: jest.Mock;
      getMany: jest.Mock;
    } = {
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ id: 1, tenantId: 't_001' }]),
    };
    const { service } = createService({
      createQueryBuilder: jest.fn(() => qb) as never,
    });

    const items = await service.list('t_001');
    expect(items).toHaveLength(1);
    expect(qb.where.mock.calls[0]).toEqual([
      't.tenant_id = :tenantId',
      { tenantId: 't_001' },
    ]);
  });

  it('启停：更新 enabled 字段', async () => {
    const { service, repo } = createService({});
    expect(await service.setEnabled(1, false)).toBe(true);
    expect(repo.update.mock.calls[0]).toEqual([1, { enabled: 0 }]);
  });

  it('删除：affected=0 返回 false', async () => {
    const { service, repo } = createService({});
    repo.delete.mockResolvedValueOnce({ affected: 0 });
    expect(await service.remove(999)).toBe(false);
  });

  it('校验：有效 token 返回实体', async () => {
    const entity = {
      id: 1,
      tenantId: 't_001',
      token: 'mcp_valid',
      enabled: 1,
      expiresAt: null,
    };
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce(entity as never);
    expect(await service.validate('mcp_valid')).toEqual(entity);
  });

  it('校验：不存在的 token 返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce(null);
    expect(await service.validate('mcp_missing')).toBeNull();
  });

  it('校验：停用的 token 返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce({
      token: 'mcp_disabled',
      enabled: 0,
      expiresAt: null,
    } as never);
    expect(await service.validate('mcp_disabled')).toBeNull();
  });

  it('校验：过期的 token 返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce({
      token: 'mcp_expired',
      enabled: 1,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    expect(await service.validate('mcp_expired')).toBeNull();
  });
});
