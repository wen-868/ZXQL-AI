/**
 * P0-3 McpTokenService 单元测试
 *
 * 覆盖：生成（mcp_ 前缀明文一次性返回/库中存 SHA-256 哈希）、列表脱敏、
 * 启停、删除、校验（enabled/过期/历史明文惰性升级）
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-09-05 哈希存储+脱敏用例
 */
import { Repository } from 'typeorm';
import { createHash } from 'crypto';
import { McpTokenEntity } from '../../database/entities/mcp-token.entity';
import { McpTokenService, maskToken } from './mcp-token.service';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
  it('生成 Token：明文 mcp_ 前缀一次性返回，库中只存 SHA-256 哈希', async () => {
    const { service } = createService({});
    const { entity, plaintext } = await service.create({
      tenantId: 't_001',
      name: 'WorkBuddy对接',
    });

    expect(plaintext).toMatch(/^mcp_[a-f0-9]{64}$/);
    expect(entity.token).toBe(sha256(plaintext));
    expect(entity.token).not.toBe(plaintext);
    expect(entity.tenantId).toBe('t_001');
    expect(entity.name).toBe('WorkBuddy对接');
    expect(entity.enabled).toBe(1);
    // P2 修复（2026-10-04）：不传 expiresAt 不再永不过期，默认 90 天兜底
    expect(entity.expiresAt).toBeInstanceOf(Date);
    expect(entity.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(entity.expiresAt!.getTime()).toBeLessThan(
      Date.now() + 91 * 24 * 60 * 60 * 1000,
    );
  });

  it('生成 Token：支持过期时间', async () => {
    const { service } = createService({});
    const expiresAt = new Date(Date.now() + 86400000);
    const { entity } = await service.create({ tenantId: 't_001', expiresAt });
    expect(entity.expiresAt).toBe(expiresAt);
  });

  it('列表：支持租户过滤 + token 脱敏（不返回完整哈希）', async () => {
    const storedHash = sha256('mcp_plain');
    const qb: {
      orderBy: jest.Mock;
      where: jest.Mock;
      getMany: jest.Mock;
    } = {
      orderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest
        .fn()
        .mockResolvedValue([{ id: 1, tenantId: 't_001', token: storedHash }]),
    };
    const { service, repo } = createService({
      createQueryBuilder: jest.fn(() => qb) as never,
    });

    const items = await service.list('t_001');
    expect(items).toHaveLength(1);
    expect(qb.where.mock.calls[0]).toEqual([
      't.tenant_id = :tenantId',
      { tenantId: 't_001' },
    ]);
    // 脱敏：返回值 ≠ 库中哈希，且等于掩码形态
    expect(items[0].token).not.toBe(storedHash);
    expect(items[0].token).toBe(maskToken(storedHash));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.createQueryBuilder).toHaveBeenCalled();
  });

  it('启停：更新 enabled 字段，条件对象带 tenant_id', async () => {
    const { service, repo } = createService({});
    expect(await service.setEnabledFor(1, false, 'tenant-x')).toBe(true);

    // 断言条件形状而非仅返回值：裸 id 条件必须被断言挡住
    expect(repo.update.mock.calls[0]).toEqual([
      { id: 1, tenantId: 'tenant-x' },
      { enabled: 0 },
    ]);
  });

  it('启停：跨租户操作无效（affected=0 → false），且条件仍带 tenant_id', async () => {
    const { service, repo } = createService({});
    repo.update.mockResolvedValueOnce({ affected: 0 } as never);

    expect(await service.setEnabledFor(999, false, 'tenant-x')).toBe(false);
    // 关键：即使库层面 affected=0，传给 update 的条件也必须含 tenantId
    expect(repo.update.mock.calls[0]).toEqual([
      { id: 999, tenantId: 'tenant-x' },
      { enabled: 0 },
    ]);
  });

  it('启停：平台身份不传 tenantId → 条件只含 id', async () => {
    const { service, repo } = createService({});
    expect(await service.setEnabledFor(1, true)).toBe(true);

    expect(repo.update.mock.calls[0]).toEqual([{ id: 1 }, { enabled: 1 }]);
  });

  it('删除：affected=0 返回 false，且 delete 收到含 tenant_id 的条件对象', async () => {
    const { service, repo } = createService({});
    repo.delete.mockResolvedValueOnce({ affected: 0 } as never);

    expect(await service.removeFor(999, 'tenant-x')).toBe(false);
    expect(repo.delete.mock.calls[0]).toEqual([
      { id: 999, tenantId: 'tenant-x' },
    ]);
  });

  it('删除：平台身份不传 tenantId → 条件只含 id', async () => {
    const { service, repo } = createService({});
    expect(await service.removeFor(1)).toBe(true);

    expect(repo.delete.mock.calls[0]).toEqual([{ id: 1 }]);
  });

  it('校验：哈希命中的有效 token 返回实体', async () => {
    const entity = {
      id: 1,
      tenantId: 't_001',
      token: sha256('mcp_valid'),
      enabled: 1,
      expiresAt: null,
    };
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce(entity as never);
    const result = await service.validate('mcp_valid');
    expect(result).toEqual(entity);
    // 优先按 SHA-256 哈希查找
    expect(repo.findOne.mock.calls[0][0]).toEqual({
      where: { token: sha256('mcp_valid') },
    });
  });

  it('校验：历史明文 token 命中后惰性升级为哈希存储', async () => {
    const { service, repo } = createService({});
    // 第一次（哈希）查不到，第二次（明文兼容）命中
    repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 2,
      tenantId: 't_001',
      token: 'mcp_legacy',
      enabled: 1,
      expiresAt: null,
    } as never);

    const result = await service.validate('mcp_legacy');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.update).toHaveBeenCalledWith(2, {
      token: sha256('mcp_legacy'),
    });
    expect(result?.token).toBe(sha256('mcp_legacy'));
  });

  it('校验：哈希与历史明文都不存在返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValue(null);
    expect(await service.validate('mcp_missing')).toBeNull();
  });

  it('校验：空 token 返回 null', async () => {
    const { service, repo } = createService({});
    expect(await service.validate('')).toBeNull();
    expect(await service.validate('   ')).toBeNull();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('校验：停用的 token 返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce({
      token: sha256('mcp_disabled'),
      enabled: 0,
      expiresAt: null,
    } as never);
    expect(await service.validate('mcp_disabled')).toBeNull();
  });

  it('校验：过期的 token 返回 null', async () => {
    const { service, repo } = createService({});
    repo.findOne.mockResolvedValueOnce({
      token: sha256('mcp_expired'),
      enabled: 1,
      expiresAt: new Date(Date.now() - 1000),
    } as never);
    expect(await service.validate('mcp_expired')).toBeNull();
  });
});
