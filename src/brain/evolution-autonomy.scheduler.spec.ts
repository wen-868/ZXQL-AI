/**
 * E5 EvolutionAutonomyScheduler 单元测试
 *
 * 覆盖：策略门控空转、按轮处理 staged、单日激活上限护栏、单版本闭包异常不中断、无 staged 空转。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- 测试断言直接引用 jest mock 方法及其调用参数；mock 闭包无需真实异步 */
import { Repository } from 'typeorm';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { EvolutionAutonomyScheduler } from './evolution-autonomy.scheduler';
import { EvolutionVersionService } from '../evolution/evolution-version.service';
import { StructuredExtractor } from './extraction/structured-extractor';

function createScheduler(opts: {
  policy?: number;
  staged?: Array<{ id: number; status: string }>;
  closureAction?: 'auto_activated' | 'kept_staged' | 'auto_rolled_back';
  failIds?: number[];
}) {
  const stagedList = (opts.staged ?? []).map((s) => ({
    id: s.id,
    artifact: 'write_schema.customer_create',
    toVersion: 'v2',
    status: 'staged',
  }));
  const versions = {
    list: jest.fn().mockResolvedValue(stagedList),
    runAutoClosure: jest.fn(async (id: number) => {
      if (opts.failIds?.includes(id)) {
        throw new Error('闭包注入失败');
      }
      return {
        versionId: id,
        policy: 'auto',
        action: opts.closureAction ?? 'kept_staged',
        recommendation: 'keep',
        message: 'mock',
      };
    }),
  } as unknown as EvolutionVersionService;
  const structuredExtractor = {
    extract: jest.fn(),
  } as never as StructuredExtractor;
  const platformRepo = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 1, evolutionAutoActivate: opts.policy ?? 0 }),
  } as unknown as Repository<PlatformAiConfigEntity>;
  const scheduler = new EvolutionAutonomyScheduler(
    versions,
    structuredExtractor,
    platformRepo,
  );
  return { scheduler, versions, platformRepo };
}

describe('E5 自治调度器', () => {
  it('策略关闭 → 空转（不查 staged 列表）', async () => {
    const { scheduler, versions } = createScheduler({ policy: 0 });
    const result = await scheduler.runOnce();
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('策略未开启');
    expect(versions.list).not.toHaveBeenCalled();
  });

  it('无 staged 版本 → 空转', async () => {
    const { scheduler, versions } = createScheduler({ policy: 1, staged: [] });
    const result = await scheduler.runOnce();
    expect(result.skipped).toBe(true);
    expect(result.reason).toContain('无 staged');
    expect(versions.runAutoClosure).not.toHaveBeenCalled();
  });

  it('策略开启 + 3 个 staged → 逐个闭包处理', async () => {
    const { scheduler, versions } = createScheduler({
      policy: 1,
      staged: [
        { id: 1, status: 'staged' },
        { id: 2, status: 'staged' },
        { id: 3, status: 'staged' },
      ],
      closureAction: 'kept_staged',
    });
    const result = await scheduler.runOnce();
    expect(result.skipped).toBe(false);
    expect(result.processed).toHaveLength(3);
    expect(versions.runAutoClosure).toHaveBeenCalledTimes(3);
  });

  it('单日自动激活达上限 → 本轮提前收工（护栏）', async () => {
    const { scheduler, versions } = createScheduler({
      policy: 1,
      staged: [
        { id: 1, status: 'staged' },
        { id: 2, status: 'staged' },
      ],
      closureAction: 'auto_activated',
    });
    // 预置当日激活计数已到上限
    (
      scheduler as unknown as {
        activationCount: { date: string; count: number };
      }
    ).activationCount = {
      date: new Date().toISOString().slice(0, 10),
      count: 5,
    };

    const result = await scheduler.runOnce();
    expect(result.processed).toHaveLength(0);
    expect(versions.runAutoClosure).not.toHaveBeenCalled();
  });

  it('单版本闭包异常 → 跳过该版本继续处理下一个', async () => {
    const { scheduler, versions } = createScheduler({
      policy: 1,
      staged: [
        { id: 1, status: 'staged' },
        { id: 2, status: 'staged' },
      ],
      closureAction: 'kept_staged',
      failIds: [1],
    });
    const result = await scheduler.runOnce();
    expect(result.processed).toEqual([{ versionId: 2, action: 'kept_staged' }]);
    expect(versions.runAutoClosure).toHaveBeenCalledTimes(2);
  });
});
