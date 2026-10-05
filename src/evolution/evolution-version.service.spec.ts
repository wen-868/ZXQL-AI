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
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
  } as unknown as Repository<AiEvolutionVersionEntity>;
  // activate 事务化（P2 修复回归）：manager.transaction 把回调里的
  // em.getRepository 指回带链式 QB mock 的 repo；条件更新默认成功（affected:1）
  const updateQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn(async () => ({ affected: 1 })),
  };
  (repo as unknown as Record<string, unknown>).manager = {
    transaction: jest.fn(
      async (cb: (em: unknown) => Promise<unknown>): Promise<unknown> =>
        cb({
          getRepository: () => ({
            ...repo,
            createQueryBuilder: jest.fn(() => updateQb),
          }),
        }),
    ),
  };
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
    updateQb,
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

  it('activate：同 artifact 旧 active 自动退役（单活约束，事务化条件更新）', async () => {
    const { service, repo, updateQb } = createService();
    // getOrThrow 按主键查；旧 active 退役已改为事务内条件 UPDATE（P2 修复），
    // 不再走 find+save——通过 updateQb 的 set/where 断言退役与激活两条语句
    repo.findOne = jest.fn().mockResolvedValue({
      id: 2,
      artifact: 'write_schema.customer_create',
      fromVersion: 'v1',
      status: 'staged',
    }) as never;

    const entity = await service.activate(2, 'e5-auto');
    expect(entity.status).toBe('active');
    // 第一条 UPDATE：退役旧 active（排除自身 id=2）
    expect(updateQb.where).toHaveBeenCalledWith(
      'artifact = :artifact AND status = :status AND id != :id',
      expect.objectContaining({
        artifact: 'write_schema.customer_create',
        status: 'active',
        id: 2,
      }),
    );
    expect(updateQb.set).toHaveBeenCalledWith({
      status: 'rolled_back',
      approvedBy: 'e5-auto',
    });
    // 第二条 UPDATE：staged → active
    expect(updateQb.set).toHaveBeenCalledWith({
      status: 'active',
      approvedBy: 'e5-auto',
    });
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

  // 以下两条为 P2 修复（2026-10-04）的反测用例：证明"并发双激活被封堵"
  // 依赖的是条件更新 affected 判定，而非恰好走顺。原实现无此断言时，
  // 即便把条件更新 where 去掉退回 save()，测试仍会全绿。
  it('activate：条件更新 affected=0（并发抢先）→ 必须抛激活冲突，不得静默成功', async () => {
    const { service, repo, updateQb } = createService();
    repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      artifact: 'write_schema.customer_create',
      fromVersion: 'v1',
      status: 'staged',
    });
    // 第 1 次 execute = 退役旧 active（成功）；第 2 次 = 条件激活（affected 0）
    (updateQb.execute as jest.Mock)
      .mockResolvedValueOnce({ affected: 1 })
      .mockResolvedValueOnce({ affected: 0 });
    await expect(service.activate(1, 'admin')).rejects.toThrow(
      /激活冲突|已非 staged/,
    );
  });

  it('activate：条件更新必须带 status=staged 约束（防并发双写 active）', async () => {
    const { service, repo, updateQb } = createService();
    repo.findOne = jest.fn().mockResolvedValue({
      id: 1,
      artifact: 'write_schema.customer_create',
      fromVersion: 'v1',
      status: 'staged',
    });
    await service.activate(1, 'admin');
    // 激活自身那条 where 必须带 status = 'staged' 条件。
    // 实现用 SQL 片段 + 参数对象形式（where('id = :id AND status = :status', {...})），
    // 故同时检查 SQL 文本含 status 判定、参数含 staged。
    const whereCalls = updateQb.where.mock.calls;
    const hasStatusGuard = whereCalls.some(
      ([sql, params]) =>
        typeof sql === 'string' &&
        /status\s*=/i.test(sql) &&
        params &&
        params.status === 'staged',
    );
    expect(hasStatusGuard).toBe(true);
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
    const { service, repo, platformRepo, updateQb } = createService();
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
    // 激活走事务化条件更新（P2 修复回归）：不再经 repo.save
    expect(updateQb.set).toHaveBeenCalledWith({
      status: 'active',
      approvedBy: 'e5-auto',
    });
    // 评测结果写回版本行（仍经 save）
    const saved = (repo.save as jest.Mock).mock.calls.map((c) => c[0]);
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

/**
 * E5 评测门控回归（2026-10-04 审查修复）
 *
 * 这两条是"静默放行"类缺陷：评测结论永远偏向"通过"，配合自治策略
 * （evolution_auto_activate=1）可自动激活一个实际未经任何验证的版本。
 */
describe('E5 评测门控（空 completion 与基线 0 不得恒真）', () => {
  /** 基线 accurary 为 0 的上一 active 版本 */
  const baselineZero = {
    artifact: 'write_schema.customer_create',
    status: 'active',
    regressionAccuracy: 0,
  };

  it('空 completion 用例不得判通过（includes("" 恒真陷阱）', async () => {
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
        regressionAccuracy: 1,
      },
    );
    platformRepo.findOne = jest.fn().mockResolvedValue(null);

    const result = await service.runAutoClosure(1, {
      extract: okExtract,
      // 标准答案为空：修复前 JSON.stringify(data).includes('') 恒真 → 判通过
      cases: [{ prompt: '给张三建个客户档案', completion: '   ' }],
    });

    // 反测信号：修复前这里会是 1
    expect(result.newAccuracy).toBe(0);
    expect(result.details[0].correct).toBe(false);
    expect(result.details[0].note).toContain('标准答案为空');
  });

  it('基线为 0 时达标线不得恒真（0.95×0 → >=0 恒真陷阱）', async () => {
    const { service, repo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      baselineZero,
    );
    platformRepo.findOne = jest.fn().mockResolvedValue(null);

    // 抽取全错 → 准确率 0%
    const result = await service.runAutoClosure(1, {
      extract: badExtract,
      cases: CASES,
    });

    // 反测信号：修复前 0 >= 0.95*0 成立 → meetsE5Standard 为 true
    expect(result.newAccuracy).toBe(0);
    expect(result.meetsE5Standard).toBe(false);
    expect(result.recommendation).toBe('staged_further');
  });

  it('基线为 0 且自治开启 → 不得自动激活（0% 准确率不能上线）', async () => {
    const { service, repo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      baselineZero,
    );
    platformRepo.findOne = jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: 1 });

    const result = await service.runAutoClosure(1, {
      extract: badExtract,
      cases: CASES,
    });

    // 反测信号：修复前会被 auto_activated
    expect(result.newAccuracy).toBe(0);
    expect(result.action).not.toBe('auto_activated');
  });

  it('基线有效（0.8）且准确率达标 → 仍可正常判达标（不误伤）', async () => {
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
    platformRepo.findOne = jest.fn().mockResolvedValue(null);

    const result = await service.runAutoClosure(1, {
      extract: okExtract,
      cases: CASES,
    });

    expect(result.newAccuracy).toBe(1);
    expect(result.meetsE5Standard).toBe(true);
    expect(result.recommendation).toBe('keep');
  });

  it('基线为 0 但准确率确实高 → 仍不可判达标（无可信参照）', async () => {
    const { service, repo, platformRepo } = createService();
    mockFindOne(
      repo,
      {
        artifact: 'write_schema.customer_create',
        toVersion: 'v2',
        status: 'staged',
      },
      baselineZero,
    );
    platformRepo.findOne = jest.fn().mockResolvedValue(null);

    const result = await service.runAutoClosure(1, {
      extract: okExtract, // 100% 准确率
      cases: CASES,
    });

    expect(result.newAccuracy).toBe(1);
    // 基线 0 说明上一版本评测全错/未评测，不存在可信参照 → 与"无基线"同等处理
    expect(result.meetsE5Standard).toBe(false);
    expect(result.recommendation).toBe('staged_further');
  });
});
