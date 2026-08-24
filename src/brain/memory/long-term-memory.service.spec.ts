/**
 * LongTermMemoryService 单元测试（P1 长期记忆）
 *
 * 覆盖：档案读写/覆盖、情节保存与配额淘汰、归档保存、检索相关性、租户隔离
 */
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AiLtmProfileEntity } from '../../database/entities/ai-ltm-profile.entity';
import { AiLtmEpisodicEntity } from '../../database/entities/ai-ltm-episodic.entity';
import { AiLtmArchivalEntity } from '../../database/entities/ai-ltm-archival.entity';
import { LongTermMemoryService } from './long-term-memory.service';

function makeRepo<T>() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((e: T) => e),
    save: jest.fn((e: T) => Promise.resolve(e)),
    delete: jest.fn().mockResolvedValue(undefined),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn((e: T) => Promise.resolve(e)),
  } as unknown as jest.Mocked<Repository<T>>;
}

function makeService(overrides: {
  profileRepo?: jest.Mocked<Repository<AiLtmProfileEntity>>;
  episodicRepo?: jest.Mocked<Repository<AiLtmEpisodicEntity>>;
  archivalRepo?: jest.Mocked<Repository<AiLtmArchivalEntity>>;
  episodicMax?: number;
}) {
  const config = {
    get: jest.fn((key: string) =>
      key === 'LTM_EPISODIC_MAX'
        ? String(overrides.episodicMax ?? 500)
        : undefined,
    ),
  };
  return new LongTermMemoryService(
    overrides.profileRepo ?? makeRepo<AiLtmProfileEntity>(),
    overrides.episodicRepo ?? makeRepo<AiLtmEpisodicEntity>(),
    overrides.archivalRepo ?? makeRepo<AiLtmArchivalEntity>(),
    config as unknown as ConfigService,
  );
}

describe('LongTermMemoryService', () => {
  it('upsertProfile 新键创建，同键更新', async () => {
    const profileRepo = makeRepo<AiLtmProfileEntity>();
    const svc = makeService({ profileRepo });
    await svc.upsertProfile('t1', '品牌调性', '高端大气');
    expect(profileRepo.save.mock.calls.length).toBeGreaterThan(0);
    // 同键覆盖：第二次 findOne 返回已有
    profileRepo.findOne.mockResolvedValue({
      id: 1,
      tenantId: 't1',
      entityType: 'tenant',
      entityId: null,
      k: '品牌调性',
      vJson: { value: '旧值' },
    } as AiLtmProfileEntity);
    await svc.upsertProfile('t1', '品牌调性', '新值');
    const saved = profileRepo.save.mock.calls[1][0] as AiLtmProfileEntity;
    expect(saved.vJson).toEqual({ value: '新值' });
  });

  it('getProfiles 返回租户档案', async () => {
    const profileRepo = makeRepo<AiLtmProfileEntity>();
    profileRepo.find.mockResolvedValue([
      {
        k: '常用客户',
        vJson: { value: '红星商行' },
      } as AiLtmProfileEntity,
    ]);
    const svc = makeService({ profileRepo });
    const profiles = await svc.getProfiles('t1');
    expect(profiles).toEqual([{ k: '常用客户', v: '红星商行' }]);
  });

  it('saveEpisodic 超过配额时淘汰最旧', async () => {
    const episodicRepo = makeRepo<AiLtmEpisodicEntity>();
    episodicRepo.count.mockResolvedValue(1);
    episodicRepo.findOne.mockResolvedValue({
      id: 1,
      tenantId: 't1',
    } as AiLtmEpisodicEntity);
    const svc = makeService({ episodicRepo, episodicMax: 1 });
    await svc.saveEpisodic('t1', {
      what: '挂车被驳回：未填类目',
      outcome: 'bad',
    });
    expect(episodicRepo.remove.mock.calls.length).toBeGreaterThan(0);
    expect(episodicRepo.save.mock.calls.length).toBeGreaterThan(0);
  });

  it('search 按关键词命中相关情节', async () => {
    const episodicRepo = makeRepo<AiLtmEpisodicEntity>();
    episodicRepo.find.mockResolvedValue([
      {
        id: 1,
        what: '挂车发布被驳回',
        why: '未填类目',
        summary: '挂车需先填类目',
        createdAt: new Date(),
      } as AiLtmEpisodicEntity,
      {
        id: 2,
        what: '直播话术优化',
        summary: '直播开场用福利钩子',
        createdAt: new Date(),
      } as AiLtmEpisodicEntity,
    ]);
    const svc = makeService({ episodicRepo });
    const hits = await svc.search('t1', '挂车类目', 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('类目');
  });

  it('租户隔离：search 只查本租户', async () => {
    const episodicRepo = makeRepo<AiLtmEpisodicEntity>();
    const svc = makeService({ episodicRepo });
    await svc.search('t1', '挂车', 3);
    expect(episodicRepo.find.mock.calls[0][0]).toEqual(
      expect.objectContaining({ where: { tenantId: 't1' } }),
    );
  });

  it('saveArchival 保存知识沉淀', async () => {
    const archivalRepo = makeRepo<AiLtmArchivalEntity>();
    const svc = makeService({ archivalRepo });
    await svc.saveArchival('t1', '复盘结论', '五粮液周末转化率高', '复盘');
    const saved = archivalRepo.save.mock.calls[0][0] as AiLtmArchivalEntity;
    expect(saved.title).toBe('复盘结论');
    expect(saved.source).toBe('复盘');
  });
});
