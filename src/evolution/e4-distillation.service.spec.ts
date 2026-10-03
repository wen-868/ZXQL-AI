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

/** 就绪度查询链的 mock（含 where —— 租户隔离过滤走这条链） */
function mockQb(raw: unknown[]) {
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(raw),
  };
  return qb;
}

describe('E4DistillationService', () => {
  it('readiness：quality≥4 样本 ≥50 且平均质量 ≥4 → ready（含总量与差值）', async () => {
    const { service, sampleRepo } = createService();
    const qb = mockQb([
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
    ]);
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
    sampleRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb([]));

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
    sampleRepo.createQueryBuilder = jest.fn().mockReturnValue(
      mockQb([
        {
          taskType: 'customer_create',
          total: 60,
          qualified: 60,
          avgQuality: '4.5',
        },
      ]),
    );
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

  // ── 以下为 2026-10-03 审查新增：4 个真缺陷的回归防护 ──

  describe('Modelfile 注入防护（P0：baseModel / taskType 裸拼接可注入 Modelfile 指令）', () => {
    /** 注入载荷：换行 + ADAPTER 指向宿主机路径 */
    const PAYLOAD = 'qwen2.5:7b\nADAPTER /etc/shadow';

    it('baseModel 含换行 → 拒绝且不向 Ollama 发出任何请求', async () => {
      const { service, sampleRepo } = createService(
        jest.fn((_key: string, dflt?: unknown) => dflt),
      );
      const fetchSpy = jest.spyOn(global, 'fetch');
      sampleRepo.find = jest.fn().mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({
          prompt: `样本编号${i}`,
          completion: `{"n":${i}}`,
        })),
      );

      const out = await service.train('customer_create', {
        force: true,
        baseModel: PAYLOAD,
      });

      expect(out.ok).toBe(false);
      expect(out.message).toContain('baseModel 非法');
      // 关键反测：必须一个请求都不发，否则等于已经落库恶意模型
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('taskType 含换行与引号（可闭合 SYSTEM 块）→ 拒绝', async () => {
      const { service } = createService(
        jest.fn((_key: string, dflt?: unknown) => dflt),
      );
      const fetchSpy = jest.spyOn(global, 'fetch');

      const out = await service.train('x"""\nADAPTER /etc/shadow', {
        force: true,
      });

      expect(out.ok).toBe(false);
      expect(out.message).toContain('taskType 含非法字符');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('taskType 为空或纯空白 → 拒绝（此前 force 可产出 zhixiang-- 空名脏模型）', async () => {
      const { service } = createService(
        jest.fn((_key: string, dflt?: unknown) => dflt),
      );
      const fetchSpy = jest.spyOn(global, 'fetch');

      for (const bad of ['', '   ']) {
        const out = await service.train(bad, { force: true });
        expect(out.ok).toBe(false);
        expect(out.message).toContain('taskType 不能为空');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('合法 baseModel（qwen2.5:7b）不被误拒——反测门控不过严', async () => {
      const { service, sampleRepo } = createService(
        jest.fn((key: string, dflt?: unknown) =>
          key === 'OLLAMA_BASE_URL' ? 'http://127.0.0.1:59999' : dflt,
        ),
      );
      sampleRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb([]));
      sampleRepo.find = jest.fn().mockResolvedValue(
        Array.from({ length: 12 }, (_, i) => ({
          prompt: `样本编号${i}`,
          completion: `{"n":${i}}`,
        })),
      );

      const out = await service.train('customer_create', {
        force: true,
        baseModel: 'qwen2.5:7b',
      });
      // 应通过校验，走到 Ollama 调用这一步才失败
      expect(out.message).toContain('Ollama 不可达');
    });
  });

  describe('多租户隔离（P0：readiness/exportDataset 曾缺tenantId 过滤，跨租户串样本）', () => {
    it('readiness：SQL 必须带tenant_id 条件', async () => {
      const { service, sampleRepo } = createService();
      const qb = mockQb([]);
      sampleRepo.createQueryBuilder = jest.fn(() => qb) as never;

      await service.readiness('tenant-A');

      expect(qb.where).toHaveBeenCalledWith('s.tenant_id = :tid', {
        tid: 'tenant-A',
      });
    });

    it('exportDataset：查询条件必须含本租户 tenantId', async () => {
      const { service, sampleRepo } = createService();
      sampleRepo.find = jest.fn().mockResolvedValue([]);

      await service.exportDataset('customer_create', 500, 'tenant-A');

      expect(sampleRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-A' }) as unknown,
        }) as unknown,
      );
    });

    it('未传 tenantId 时回落到 default，不放行全租户', async () => {
      const { service, sampleRepo } = createService();
      sampleRepo.find = jest.fn().mockResolvedValue([]);

      await service.exportDataset('customer_create', 500);

      expect(sampleRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'default' }) as unknown,
        }) as unknown,
      );
    });

    it('train：把租户透传到 readiness 与 exportDataset（防 A 租户训练混入 B 租户样本）', async () => {
      const { service, sampleRepo } = createService(
        jest.fn((key: string, dflt?: unknown) =>
          key === 'OLLAMA_BASE_URL' ? 'http://127.0.0.1:59999' : dflt,
        ),
      );
      const qb = mockQb([]);
      sampleRepo.createQueryBuilder = jest.fn(() => qb) as never;
      sampleRepo.find = jest.fn().mockResolvedValue([]);

      await service.train('customer_create', {
        force: true,
        tenantId: 'tenant-A',
      });

      expect(qb.where).toHaveBeenCalledWith('s.tenant_id = :tid', {
        tid: 'tenant-A',
      });
      expect(sampleRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ tenantId: 'tenant-A' }) as unknown,
        }) as unknown,
      );
    });
  });

  it('模型名带时分秒——同日重训不再静默覆盖已投产模型', async () => {
    const { service, sampleRepo } = createService(
      jest.fn((_key: string, dflt?: unknown) => dflt),
    );
    sampleRepo.createQueryBuilder = jest.fn().mockReturnValue(mockQb([]));
    sampleRepo.find = jest.fn().mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({
        prompt: `样本编号${i}`,
        completion: `{"n":${i}}`,
      })),
    );
    // 拦下 Ollama create 请求，从 body 里取模型名（失败分支不返回 modelName）
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    const out = await service.train('customer_create', { force: true });

    expect(out.ok).toBe(true);
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]?.[1] as { body: string }).body,
    ) as { model: string; modelfile: string };
    // 模型名形如 zhixiang-customer_create-20261003hhmmss（时分秒防同日覆盖）
    expect(body.model).toMatch(/^zhixiang-customer_create-\d{14}$/);
    expect(body.modelfile.startsWith('FROM qwen2.5:7b\n')).toBe(true);
    fetchSpy.mockRestore();
  });
});
