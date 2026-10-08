/* eslint-disable @typescript-eslint/unbound-method -- 断言需直接引用 mock 方法（save/update 调用留痕） */
/**
 * R101-AI-09 反测：AI 单价写入口（调价留痕，不覆盖历史）
 *
 * 规格：
 * - 新增/调价 = **插入新 effective_from 行**（`save` 新实体），**不得 UPDATE 覆盖旧行**
 *   ⇒ 唯一键 (provider, model, effective_from) 保留调价痕迹
 * - 同 (provider, model, effective_from) 重复提交 → 409（ConflictException）
 * - 停用/启用只改 `enabled`；记录不存在 → 404
 * - 视图数值化（decimal 经 mysql2 为字符串）
 *
 * 反测方向：把 createModelPrice 改成「先查旧行 → update 覆盖」⇒ 本文件
 * 「调价走 INSERT 不走 UPDATE」断言变红。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObjectLiteral, Repository } from 'typeorm';
import { AiConfigAdminService } from './ai-config-admin.service';
import { AiConfigService } from './ai-config.service';
import { CryptoService } from './crypto.service';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { AiUsageDailyEntity } from '../database/entities/ai-usage-daily.entity';
import { TenantAiBillingEntity } from '../database/entities/tenant-ai-billing.entity';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

function makeRepo<T extends ObjectLiteral>(): jest.Mocked<Repository<T>> & {
  update: jest.Mock;
} {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((e: T): T => e),
    save: jest.fn((e: T) => Promise.resolve(e)),
    update: jest.fn(),
  } as unknown as jest.Mocked<Repository<T>> & { update: jest.Mock };
}

function makeRow(
  overrides: Partial<AiModelPriceEntity> = {},
): AiModelPriceEntity {
  return {
    id: 1,
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptPrice: '0.001000' as unknown as number,
    completionPrice: '0.002000' as unknown as number,
    currency: 'CNY',
    effectiveFrom: new Date('2026-06-01T00:00:00+08:00'),
    enabled: 1,
    createdAt: new Date('2026-06-01T00:00:00+08:00'),
    updatedAt: new Date('2026-06-01T00:00:00+08:00'),
    ...overrides,
  };
}

describe('R101-AI-09 单价写入口（AiConfigAdminService）', () => {
  let service: AiConfigAdminService;
  let priceRepo: ReturnType<typeof makeRepo<AiModelPriceEntity>>;

  beforeEach(() => {
    priceRepo = makeRepo<AiModelPriceEntity>();
    (priceRepo.save as jest.Mock).mockImplementation(
      (e: AiModelPriceEntity) => {
        e.id = e.id ?? 1;
        return Promise.resolve(e);
      },
    );
    service = new AiConfigAdminService(
      makeRepo<PlatformAiConfigEntity>(),
      makeRepo<TenantAiConfigEntity>(),
      makeRepo<AiUsageDailyEntity>(),
      makeRepo<TenantAiBillingEntity>(),
      priceRepo,
      new CryptoService(createConfigService()),
      { clearCache: jest.fn() } as unknown as AiConfigService,
    );
  });

  describe('新增 / 调价：插入新行，不覆盖历史', () => {
    it('createModelPrice 走 INSERT（save）而非 UPDATE', async () => {
      priceRepo.findOne.mockResolvedValue(null);

      const view = await service.createModelPrice({
        provider: 'deepseek',
        model: 'deepseek-chat',
        promptPrice: 0.003,
        completionPrice: 0.006,
        effectiveFrom: '2026-07-01T00:00:00+08:00',
      });

      expect(priceRepo.save).toHaveBeenCalledTimes(1);
      expect(priceRepo.update).not.toHaveBeenCalled();
      expect(view.provider).toBe('deepseek');
      expect(view.promptPrice).toBe(0.003);
      expect(view.currency).toBe('CNY');
      expect(view.enabled).toBe(1);
    });

    it('调价两次（不同 effective_from）⇒ 两行并存，历史保留', async () => {
      // 模拟 t_ai_model_price 表（唯一键 provider+model+effective_from）
      const rows: AiModelPriceEntity[] = [];
      priceRepo.findOne.mockImplementation((options: unknown) => {
        const where = (options as { where: Record<string, unknown> }).where;
        const hit =
          rows.find(
            (r) =>
              r.provider === where.provider &&
              r.model === where.model &&
              (where.effectiveFrom === undefined ||
                r.effectiveFrom.getTime() ===
                  (where.effectiveFrom as Date).getTime()),
          ) ?? null;
        return Promise.resolve(hit);
      });
      (priceRepo.save as jest.Mock).mockImplementation(
        (e: AiModelPriceEntity) => {
          if (!rows.includes(e)) {
            e.id = rows.length + 1;
            rows.push(e); // INSERT；若实现改成 UPDATE 旧行，rows 不会增长
          }
          return Promise.resolve(e);
        },
      );

      await service.createModelPrice({
        provider: 'deepseek',
        model: 'deepseek-chat',
        promptPrice: 0.001,
        completionPrice: 0.002,
        effectiveFrom: '2026-01-01T00:00:00+08:00',
      });
      await service.createModelPrice({
        provider: 'deepseek',
        model: 'deepseek-chat',
        promptPrice: 0.003,
        completionPrice: 0.006,
        effectiveFrom: '2026-07-01T00:00:00+08:00',
      });

      expect(priceRepo.update).not.toHaveBeenCalled();
      // 核心留痕断言：调价必须新增一行，而不是覆盖旧行
      expect(rows).toHaveLength(2);
      expect(
        rows.map((r) => r.effectiveFrom.getTime()).sort((a, b) => a - b),
      ).toEqual([
        new Date('2026-01-01T00:00:00+08:00').getTime(),
        new Date('2026-07-01T00:00:00+08:00').getTime(),
      ]);
    });

    it('同 (provider, model, effective_from) 重复提交 → 409', async () => {
      priceRepo.findOne.mockResolvedValue(makeRow());

      await expect(
        service.createModelPrice({
          provider: 'deepseek',
          model: 'deepseek-chat',
          promptPrice: 0.003,
          completionPrice: 0.006,
          effectiveFrom: '2026-06-01T00:00:00+08:00',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(priceRepo.save).not.toHaveBeenCalled();
    });

    it('缺省 effectiveFrom 时取当前时间（服务端决定生效点）', async () => {
      priceRepo.findOne.mockResolvedValue(null);
      const before = Date.now();

      await service.createModelPrice({
        provider: 'glm',
        model: 'glm-4-flash',
        promptPrice: 0,
        completionPrice: 0,
      });

      const saved = priceRepo.save.mock.calls[0][0] as AiModelPriceEntity;
      expect(saved.effectiveFrom.getTime()).toBeGreaterThanOrEqual(before);
      expect(saved.currency).toBe('CNY');
      expect(saved.enabled).toBe(1);
    });
  });

  describe('列表与启停', () => {
    it('默认只返回启用行（where.enabled=1）', async () => {
      await service.listModelPrices({});
      const options = priceRepo.find.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(options.where.enabled).toBe(1);
    });

    it('includeDisabled=true ⇒ 不加 enabled 过滤；provider/model 精确过滤', async () => {
      await service.listModelPrices({
        provider: 'deepseek',
        model: 'deepseek-chat',
        includeDisabled: true,
      });
      const options = priceRepo.find.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(options.where.enabled).toBeUndefined();
      expect(options.where.provider).toBe('deepseek');
      expect(options.where.model).toBe('deepseek-chat');
    });

    it('setModelPriceEnabled：停用只改 enabled', async () => {
      priceRepo.findOne.mockResolvedValue(makeRow());
      const view = await service.setModelPriceEnabled(1, 0);
      expect(view.enabled).toBe(0);
      expect(priceRepo.save).toHaveBeenCalledTimes(1);
      expect(priceRepo.update).not.toHaveBeenCalled();
    });

    it('setModelPriceEnabled：不存在 → 404', async () => {
      priceRepo.findOne.mockResolvedValue(null);
      await expect(service.setModelPriceEnabled(99, 0)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('视图数值化：decimal 字符串 → number', async () => {
    priceRepo.find.mockResolvedValue([
      makeRow({
        promptPrice: '0.001250' as unknown as number,
        completionPrice: '0.002500' as unknown as number,
      }),
    ]);
    const rows = await service.listModelPrices({});
    expect(rows[0].promptPrice).toBe(0.00125);
    expect(rows[0].completionPrice).toBe(0.0025);
  });
});
