/**
 * P1-1 ExperienceExtractorService 单元测试
 *
 * 覆盖：无样本、LLM 萃取生成 staged 提案并标记 applied、LLM 失败降级保守提案。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-25
 */
/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { AiCorrectionEntity } from '../database/entities/ai-correction.entity';
import { ExperienceExtractorService } from './experience-extractor.service';
import { EvolutionVersionService } from './evolution-version.service';

function createService(options?: {
  corrections?: Partial<AiCorrectionEntity>[];
  llmContent?: string;
  llmError?: boolean;
}) {
  const corrections = options?.corrections ?? [];
  const corrRepo = {
    find: jest.fn().mockResolvedValue(corrections),
    save: jest.fn((data) => Promise.resolve(data)),
  } as unknown as Repository<AiCorrectionEntity>;

  const provider = {
    chatSync: jest.fn().mockImplementation(() => {
      if (options?.llmError) {
        throw new Error('llm down');
      }
      return {
        content:
          options?.llmContent ??
          '{"changeSummary":"手机号字段改为可选，避免必填误拦"}',
        prompt_tokens: 5,
        completion_tokens: 10,
      };
    }),
  };
  const factory = { getDefault: jest.fn().mockReturnValue(provider) };

  const versionRepo = {
    create: jest.fn((data: Record<string, unknown>) => data),
    save: jest.fn((data: Record<string, unknown>) =>
      Promise.resolve({ id: 1, ...data }),
    ),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  } as unknown as Repository<never>;
  const versions = new EvolutionVersionService(versionRepo);

  const service = new ExperienceExtractorService(
    corrRepo,
    factory as never,
    versions,
  );
  return { service, corrRepo, provider, versionRepo };
}

describe('P1-1 ExperienceExtractorService', () => {
  it('无未反哺样本：analyzed=0', async () => {
    const { service } = createService({ corrections: [] });
    const result = await service.extract();
    expect(result).toEqual({ analyzed: 0, staged: 0, insights: [] });
  });

  it('萃取：LLM 归纳生成 staged 提案并标记 appliedToVersion', async () => {
    const { service, corrRepo, versionRepo } = createService({
      corrections: [
        {
          tenantId: 't_001',
          taskType: 'customer_create',
          wrongPayload: { phone: '123' },
          rightPayload: { phone: '13800000000' },
          reason: '手机号格式错误',
          appliedToVersion: null,
        },
      ],
    });

    const result = await service.extract('customer_create');

    expect(result.analyzed).toBe(1);
    expect(result.staged).toBe(1);
    expect(result.insights[0].artifact).toBe('write_schema.customer_create');
    expect(result.insights[0].changeSummary).toContain('手机号');
    // 版本表落库
    expect(versionRepo.save).toHaveBeenCalled();
    // 纠正样本标记 appliedToVersion
    const saved = (corrRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved[0].appliedToVersion).toMatch(/^v/);
  });

  it('萃取：LLM 失败降级为保守提案（不中断）', async () => {
    const { service, versionRepo } = createService({
      corrections: [
        {
          tenantId: 't_001',
          taskType: 'refund',
          reason: '退款方式缺失',
          appliedToVersion: null,
        },
      ],
      llmError: true,
    });

    const result = await service.extract('refund');

    expect(result.staged).toBe(1);
    expect(result.degraded).toContain('llm down');
    expect(versionRepo.save).toHaveBeenCalled();
    const saved = (versionRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.changeSummary).toContain('退款方式缺失');
    expect(saved.trigger).toBe('auto_learn');
    expect(saved.status).toBe('staged');
  });

  it('萃取：LLM 输出非法 JSON 时降级', async () => {
    const { service } = createService({
      corrections: [
        {
          tenantId: 't_001',
          taskType: 'x',
          reason: 'r',
          appliedToVersion: null,
        },
      ],
      llmContent: '不是 JSON',
    });
    const result = await service.extract('x');
    expect(result.staged).toBe(1);
    expect(result.degraded).toBeDefined();
  });
});
