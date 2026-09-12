/**
 * P1-1 / E5 EvolutionVersionService 单元测试
 *
 * 覆盖：staged 提案生成、人工激活、回滚、列表、当前版本；
 * E5 真实评测（95% 达标线）、策略门控自动闭环（激活/拦截/人工放行/无基线/样本自动拉取）。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25 | 更新: 2026-09-05 E5 自治闭环用例
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await -- 测试断言直接引用 jest mock 方法及其调用参数；mock 抽取器无需真实异步 */
import { Repository } from 'typeorm';
import { AiEvolutionVersionEntity } from '../database/entities/ai-evolution-version.entity';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { EvolutionVersionService } from './evolution-version.service';

function createService() {
  const repo = {
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ ...data })),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  } as unknown as Repository<AiEvolutionVersionEntity>;
  const sampleRepo = {
    find: jest.fn().mockResolvedValue([]),
  } as unknown as Repository<AiSampleEntity>;
  const platformRepo = {
    findOne: jest.fn().mockResolvedValue({ id: 1, evolutionAutoActivate: 0 }),
  } as unknown as Repository<PlatformAiConfigEntity>;
  return {
    service: new EvolutionVersionService(repo, sampleRepo, platformRepo),
    repo,
    sampleRepo,
    platformRepo,
  };
}

/** 构造按 where 形状分派的 findOne：{artifact,status}=基线查询，其余=按 id 取实体 */
function mockFindOne(
  repo: Repository<AiEvolutionVersionEntity>,
  current: Partial<AiEvolutionVersionEntity>,
  baseline: Partial<AiEvolutionVersionEntity> | null,
) {
  repo.findOne = jest.fn((opts?: { where?: Record<string, unknown> }) => {
    const w = opts?.where ?? {};
    if ('artifact' in w && 'status' in w) {
      return Promise.resolve(baseline);
    }
    return Promise.resolve({ id: 1, status: 'staged', ...current });
  }) as never;
}

/** 通过的抽取执行器（命中 Schema 且字段全对） */
const okExtract = async () => ({
  success: true,
  matched: true,
  data: { customerName: '张三' },
  valid: true,
  issues: [],
});

/** 失败的抽取执行器（字段不匹配） */
const badExtract = async () => ({
  success: true,
  matched: true,
  data: { customerName: '错的人' },
  valid: true,
  issues: [],
});

const CASES = [
  { prompt: '给张三建个客户档案', completion: '{"customerName":"张三"}' },
];

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

describe('E5 自治闭环', () => {
  it('评测：达标（≥95%×基线）→ keep；策略开启 → 自动激活', async () => {
    const { service, repo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      {
        artifact: 'write_schema.customer_create',
        status: 'active',
        regressionAccuracy: 0.8,
      },
    );
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 1 });

    const result = await service.runAutoClosure(1, {
      extract: okExtract,
      cases: CASES,
    });

    expect(result.policy).toBe('auto');
    expect(result.baselineAccuracy).toBe(0.8);
    expect(result.newAccuracy).toBe(1);
    expect(result.meetsE5Standard).toBe(true);
    expect(result.recommendation).toBe('keep');
    expect(result.action).toBe('auto_activated');
    // 激活后实体状态落库
    const saved = (repo.save as jest.Mock).mock.calls.map((c) => c[0]);
    expect(
      saved.some((e) => e.status === 'active' && e.approvedBy === 'e5-auto'),
    ).toBe(true);
    // 评测结果写回版本行
    expect(
      saved.some((e) => e.regressionAccuracy === 1 && e.regressionEvaluatedAt),
    ).toBe(true);
  });

  it('评测：未达标（<90%×基线）→ rollback；策略开启 → staged 自动拦截废弃', async () => {
    const { service, repo, platformRepo } = createService();
    const current = {
      artifact: 'write_schema.customer_create',
      toVersion: 'v2',
      status: 'staged',
    };
    mockFindOne(repo, current, {
      artifact: 'write_schema.customer_create',
      status: 'active',
      regressionAccuracy: 0.9,
    });
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 1 });

    const result = await service.runAutoClosure(1, {
      extract: badExtract,
      cases: CASES,
    });

    expect(result.newAccuracy).toBe(0);
    expect(result.recommendation).toBe('rollback');
    expect(result.action).toBe('auto_rolled_back');
    // staged 从未生效：拦截 = 直接废弃为 rolled_back
    const saved = (repo.save as jest.Mock).mock.calls.map((c) => c[0]);
    expect(
      saved.some(
        (e) => e.status === 'rolled_back' && e.approvedBy === 'e5-auto',
      ),
    ).toBe(true);
  });

  it('策略关闭（默认人工放行）→ 只评测不动作', async () => {
    const { service, repo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      {
        artifact: 'write_schema.customer_create',
        status: 'active',
        regressionAccuracy: 0.8,
      },
    );
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 0 });

    const result = await service.runAutoClosure(1, {
      extract: okExtract,
      cases: CASES,
    });

    expect(result.policy).toBe('manual');
    expect(result.recommendation).toBe('keep');
    expect(result.action).toBe('none_manual_review');
    // 不发生激活（save 仅评测落库一次，无 status=active 写入）
    const saved = (repo.save as jest.Mock).mock.calls.map((c) => c[0]);
    expect(saved.some((e) => e.status === 'active')).toBe(false);
  });

  it('无基线（上一 active 无评测值）→ 不可判 → staged_further 保持观察', async () => {
    const { service, repo, platformRepo } = createService();
    // 基线查询返回 null（无 active 或无历史评测）
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      null,
    );
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 1 });

    const result = await service.runAutoClosure(1, {
      extract: okExtract,
      cases: CASES,
    });

    expect(result.baselineAccuracy).toBeNull();
    expect(result.meetsE5Standard).toBe(false);
    expect(result.recommendation).toBe('staged_further');
    expect(result.action).toBe('kept_staged');
  });

  it('无显式用例 → 自动从 ai_db 样本池拉取（taskType=artifact，quality≥3）', async () => {
    const { service, repo, sampleRepo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      {
        artifact: 'write_schema.customer_create',
        status: 'active',
        regressionAccuracy: 0.5,
      },
    );
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 1 });
    sampleRepo.find = jest.fn().mockResolvedValue([
      {
        prompt: '新建客户张三',
        completion: '{"customerName":"张三"}',
        quality: 4,
      },
    ]);

    const result = await service.runAutoClosure(1, { extract: okExtract });

    expect(sampleRepo.find).toHaveBeenCalled();
    expect(result.caseCount).toBe(1);
    expect(result.newAccuracy).toBe(1);
    expect(result.action).toBe('auto_activated');
  });
});
