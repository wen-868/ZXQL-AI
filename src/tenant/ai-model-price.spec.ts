/**
 * R101-AI-07 单价来源（t_ai_model_price）反测
 *
 * 规格（业主 2026-10-09 认可「甲」）：
 * - 分档单价（prompt/completion，元/千Token）只能来自库内配置，禁止代码硬编码价格表
 * - 解析口径：同 (provider, model) 且 enabled=1、effective_from <= 当前时间，
 *   取 effective_from 最大者（未来行不提前生效，支持调价留痕）
 * - **未配置 → 返回 null**（不得回落成 0 冒充已配置）；显式配置 0 元 → 返回 0
 *
 * 反测方向：把「未配置返回 null」改回「返回 0 元对象」⇒ 本文件对应断言变红。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { ConfigService } from '@nestjs/config';
import { FindOperator, Repository } from 'typeorm';
import { AiConfigService } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

function makeRow(
  overrides: Partial<AiModelPriceEntity> = {},
): AiModelPriceEntity {
  return {
    id: 1,
    provider: 'deepseek',
    model: 'deepseek-chat',
    // decimal 列经 mysql2 以字符串返回（真实形态）
    promptPrice: '0.001000' as unknown as number,
    completionPrice: '0.002000' as unknown as number,
    currency: 'CNY',
    effectiveFrom: new Date('2026-01-01T00:00:00+08:00'),
    enabled: 1,
    createdAt: new Date('2026-01-01T00:00:00+08:00'),
    updatedAt: new Date('2026-01-01T00:00:00+08:00'),
    ...overrides,
  };
}

/**
 * 按 t_ai_model_price 的解析口径模拟 findOne（含 where/order 语义）
 *
 * 让「生效时间 / 启用开关 / provider+model 精确匹配」三条语义可在单测中断言，
 * 查询形状由「查询口径」用例单独断言（防止模拟器与实现各写各的）。
 */
function makePriceRepo(
  rows: AiModelPriceEntity[],
): jest.Mocked<Repository<AiModelPriceEntity>> {
  const findOne = jest.fn((options?: unknown) => {
    if (!options) {
      return Promise.resolve(null);
    }
    const opts = options as {
      where?: Record<string, unknown>;
      order?: Record<string, string>;
    };
    const where = opts.where ?? {};
    const operator = where.effectiveFrom as FindOperator<Date> | undefined;
    const cutoff =
      operator?.value instanceof Date ? operator.value : new Date();
    const matched = rows
      .filter(
        (row) =>
          row.provider === where.provider &&
          row.model === where.model &&
          row.enabled === where.enabled,
      )
      .filter(
        (row) => new Date(row.effectiveFrom).getTime() <= cutoff.getTime(),
      )
      .sort(
        (a, b) =>
          new Date(b.effectiveFrom).getTime() -
          new Date(a.effectiveFrom).getTime(),
      );
    return Promise.resolve(matched[0] ?? null);
  });
  return { findOne } as unknown as jest.Mocked<Repository<AiModelPriceEntity>>;
}

function makeService(
  priceRepo: jest.Mocked<Repository<AiModelPriceEntity>>,
): AiConfigService {
  const configService = {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
  return new AiConfigService(
    { findOne: jest.fn() } as unknown as Repository<never>,
    { findOne: jest.fn() } as unknown as Repository<never>,
    new TenantContext(),
    new CryptoService(configService),
    { getRuntimeConfig: jest.fn() } as unknown as ExternalModelService,
    priceRepo,
  );
}

describe('R101-AI-07 getModelPrice（t_ai_model_price 单价解析）', () => {
  it('未配置 → 返回 null（**不得**回落成 0 冒充已配置）', async () => {
    const service = makeService(makePriceRepo([]));
    await expect(
      service.getModelPrice('deepseek', 'deepseek-chat'),
    ).resolves.toBeNull();
  });

  it('显式配置 0 元 → 返回 0（0 与「未配置」是两种语义）', async () => {
    const service = makeService(
      makePriceRepo([makeRow({ promptPrice: 0, completionPrice: 0 })]),
    );
    const price = await service.getModelPrice('deepseek', 'deepseek-chat');
    expect(price).not.toBeNull();
    expect(price?.promptPrice).toBe(0);
    expect(price?.completionPrice).toBe(0);
  });

  it('已配置 → 返回数值化单价 + 币种 + 生效时间', async () => {
    const service = makeService(makePriceRepo([makeRow()]));
    const price = await service.getModelPrice('deepseek', 'deepseek-chat');
    expect(price).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      promptPrice: 0.001,
      completionPrice: 0.002,
      currency: 'CNY',
      effectiveFrom: new Date('2026-01-01T00:00:00+08:00'),
    });
  });

  it('未来生效行不提前生效（取 <= 当前时间的最大者）', async () => {
    const service = makeService(
      makePriceRepo([
        makeRow({ effectiveFrom: new Date('2026-01-01T00:00:00+08:00') }),
        makeRow({
          id: 2,
          promptPrice: '9.9' as unknown as number,
          effectiveFrom: new Date('2099-01-01T00:00:00+08:00'),
        }),
      ]),
    );
    const price = await service.getModelPrice('deepseek', 'deepseek-chat');
    expect(price?.promptPrice).toBe(0.001);
  });

  it('多行已生效 → 取 effective_from 最大者（调价留痕）', async () => {
    const service = makeService(
      makePriceRepo([
        makeRow({
          promptPrice: '0.001' as unknown as number,
          effectiveFrom: new Date('2026-01-01T00:00:00+08:00'),
        }),
        makeRow({
          id: 2,
          promptPrice: '0.003' as unknown as number,
          effectiveFrom: new Date('2026-06-01T00:00:00+08:00'),
        }),
      ]),
    );
    const price = await service.getModelPrice('deepseek', 'deepseek-chat');
    expect(price?.promptPrice).toBe(0.003);
  });

  it('停用行（enabled=0）不算已配置 → null', async () => {
    const service = makeService(makePriceRepo([makeRow({ enabled: 0 })]));
    await expect(
      service.getModelPrice('deepseek', 'deepseek-chat'),
    ).resolves.toBeNull();
  });

  it('provider / model 精确匹配：不命中 → null（不做通配回落）', async () => {
    const service = makeService(makePriceRepo([makeRow()]));
    await expect(
      service.getModelPrice('glm', 'deepseek-chat'),
    ).resolves.toBeNull();
    await expect(
      service.getModelPrice('deepseek', 'deepseek-reasoner'),
    ).resolves.toBeNull();
  });

  it('查询口径：enabled=1 + effective_from <= now（LessThanOrEqual）+ 按生效时间倒序', async () => {
    const repo = makePriceRepo([makeRow()]);
    const service = makeService(repo);
    const before = Date.now();

    await service.getModelPrice('deepseek', 'deepseek-chat');

    const options = repo.findOne.mock.calls[0][0] as {
      where: {
        provider: string;
        model: string;
        enabled: number;
        effectiveFrom: FindOperator<Date>;
      };
      order: { effectiveFrom: string };
    };
    expect(options.where.provider).toBe('deepseek');
    expect(options.where.model).toBe('deepseek-chat');
    expect(options.where.enabled).toBe(1);
    expect(options.where.effectiveFrom.type).toBe('lessThanOrEqual');
    expect(options.where.effectiveFrom.value.getTime()).toBeGreaterThanOrEqual(
      before,
    );
    expect(options.order).toEqual({ effectiveFrom: 'DESC' });
  });

  it('不依赖租户上下文（平台级配置，无租户也可读）', async () => {
    const service = makeService(makePriceRepo([makeRow()]));
    // 未调用 tenantContext.run/enter，方法仍应正常返回
    await expect(
      service.getModelPrice('deepseek', 'deepseek-chat'),
    ).resolves.not.toBeNull();
  });
});
