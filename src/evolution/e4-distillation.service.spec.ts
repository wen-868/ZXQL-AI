/**
 * E4DistillationService 单元测试
 *
 * 覆盖：就绪度看板（总量/阈值判定/差值）+ JSONL 数据集导出
 * （quality≥4、空值过滤、短 prompt 剔除、同 prompt 去重、上限裁剪）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试断言直接引用 jest mock 方法；JSON.parse 结果已显式定型，无需再豁免 unsafe-member-access */
import { Repository } from 'typeorm';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import {
  E4DistillationService,
  E4_MIN_SAMPLES,
} from './e4-distillation.service';

function createService(configGet?: jest.Mock) {
  const sampleRepo = {
    createQueryBuilder: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  } as unknown as Repository<AiSampleEntity>;
  const configService = {
    get: configGet ?? jest.fn(),
  } as never;
  return {
    service: new E4DistillationService(sampleRepo, configService),
    sampleRepo,
  };
}

describe('E4DistillationService', () => {
  it('readiness：quality≥4 样本 ≥50 且平均质量 ≥4 → ready（含总量与差值）', async () => {
    const { service, sampleRepo } = createService();
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          taskType: 'customer_create',
          total: 80,
          qualified: 62,
          avgQuality: '4.3',
        },
        {
          taskType: 'sales_order',
          total: 30,
          qualified: 12,
          avgQuality: '3.8',
        },
      ]),
    };
    sampleRepo.createQueryBuilder = jest.fn(() => qb) as never;

    const items = await service.readiness();

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      taskType: 'customer_create',
      qualifiedSamples: 62,
      totalSamples: 80,
      avgQuality: 4.3,
      ready: true,
      remaining: 0,
    });
    expect(items[1]).toMatchObject({
      taskType: 'sales_order',
      qualifiedSamples: 12,
      totalSamples: 30,
      ready: false,
      remaining: E4_MIN_SAMPLES - 12,
    });
    // 阈值参数已下发
    expect(qb.setParameter).toHaveBeenCalledWith('q', 4);
  });

  it('exportDataset：训练集卫生——空值剔除、短 prompt 剔除、同 prompt 去重', async () => {
    const { service, sampleRepo } = createService();
    sampleRepo.find = jest.fn().mockResolvedValue([
      {
        prompt: '新建客户李四',
        completion: '{"customerName":"李四"}',
        quality: 4,
      },
      {
        prompt: '新建客户李四', // 同 prompt 去重
        completion: '{"customerName":"李四"}',
        quality: 5,
      },
      { prompt: '   ', completion: '{"x":1}', quality: 4 }, // 空 prompt 剔除
      { prompt: '坏样本', completion: '', quality: 4 }, // 空 completion 剔除
      { prompt: '太短', completion: '{"y":2}', quality: 4 }, // <4 字符剔除
    ]);

    const out = await service.exportDataset('customer_create', 500);

    expect(out.count).toBe(1);
    const parsed = JSON.parse(out.jsonl) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.messages).toEqual([
      { role: 'user', content: '新建客户李四' },
      { role: 'assistant', content: '{"customerName":"李四"}' },
    ]);
    // 查询条件：quality≥4 + 上限裁剪
    expect(sampleRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        order: { createdAt: 'DESC' },
        take: 500,
      }),
    );
  });

  it('exportDataset：limit 越界裁剪到 [1, 2000]', async () => {
    const { service, sampleRepo } = createService();
    sampleRepo.find = jest.fn().mockResolvedValue([]);
    await service.exportDataset('x', -5);
    expect(sampleRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await service.exportDataset('x', 99999);
    expect(sampleRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 2000 }),
    );
  });

  it('train：就绪门控未通过 → 拒绝训练并给出积累指引', async () => {
    const { service, sampleRepo } = createService(
      jest.fn((_key: string, dflt?: unknown) => dflt),
    );
    sampleRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([]),
    });

    const out = await service.train('customer_create');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('门控未通过');
  });

  it('train：门控通过但 Ollama 不可达 → 优雅失败不抛异常', async () => {
    const { service, sampleRepo } = createService(
      jest.fn((key: string, dflt?: unknown) =>
        key === 'OLLAMA_BASE_URL' ? 'http://127.0.0.1:59999' : dflt,
      ),
    );
    sampleRepo.createQueryBuilder = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        {
          taskType: 'customer_create',
          total: 60,
          qualified: 60,
          avgQuality: '4.5',
        },
      ]),
    });
    sampleRepo.find = jest.fn().mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        prompt: `新建客户测试样本第${i}号`,
        completion: `{"customerName":"客户${i}"}`,
      })),
    );

    const out = await service.train('customer_create', { force: true });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('Ollama 不可达');
  });
});
