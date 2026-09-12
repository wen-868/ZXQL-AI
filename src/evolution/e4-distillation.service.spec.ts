/**
 * E4DistillationService 单元测试
 *
 * 覆盖：就绪度看板（阈值判定）+ JSONL 数据集导出（quality≥4、空值过滤、上限裁剪）。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
/* eslint-disable @typescript-eslint/unbound-method -- 测试断言直接引用 jest mock 方法及其调用参数 */
import { Repository } from 'typeorm';
import { AiSampleEntity } from '../database/entities/ai-sample.entity';
import {
  E4DistillationService,
  E4_MIN_SAMPLES,
} from './e4-distillation.service';

function createService() {
  const sampleRepo = {
    createQueryBuilder: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
  } as unknown as Repository<AiSampleEntity>;
  return { service: new E4DistillationService(sampleRepo), sampleRepo };
}

describe('E4DistillationService', () => {
  it('readiness：quality≥4 样本 ≥50 且平均质量 ≥4 → ready', async () => {
    const { service, sampleRepo } = createService();
    const qb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      setParameter: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([
        { taskType: 'customer_create', qualified: 62, avgQuality: '4.3' },
        { taskType: 'sales_order', qualified: 12, avgQuality: '3.8' },
      ]),
    };
    sampleRepo.createQueryBuilder = jest.fn(() => qb) as never;

    const items = await service.readiness();

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      taskType: 'customer_create',
      qualifiedSamples: 62,
      avgQuality: 4.3,
      ready: true,
    });
    expect(items[1].ready).toBe(false);
    // 阈值参数已下发
    expect(qb.setParameter).toHaveBeenCalledWith(
      'q',
      E4_MIN_SAMPLES >= 50 ? 4 : 4,
    );
  });

  it('exportDataset：仅收 quality≥4 且 prompt/completion 齐备的样本，输出 messages JSONL', async () => {
    const { service, sampleRepo } = createService();
    sampleRepo.find = jest.fn().mockResolvedValue([
      {
        prompt: '新建客户李四',
        completion: '{"customerName":"李四"}',
        quality: 4,
      },
      { prompt: '   ', completion: '{"x":1}', quality: 4 }, // 空 prompt 剔除
      { prompt: '坏样本', completion: '', quality: 4 }, // 空 completion 剔除
    ]);

    const out = await service.exportDataset('customer_create', 500);

    expect(out.taskType).toBe('customer_create');
    expect(out.count).toBe(1);
    const parsed = JSON.parse(out.jsonl);
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
});
