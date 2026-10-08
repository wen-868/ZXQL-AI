/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-floating-promises -- 测试断言需直接引用 mock 方法（toHaveBeenCalledWith）；controller 委托方法返回 Promise，测试仅验证同步委托关系无需 await */
/**
 * R101-AI-09 反测：AI 单价管理端点必须显式判平台身份
 *
 * 规格（P0-1 教训）：
 * - 全部单价端点（列表 / 新增调价 / 启用停用）**仅限平台身份**：
 *   `identityType !== 'platform'` → 403 + `aiError('AI_010')`
 * - **不得只挂 AdminGuard**（AdminGuard 同时放行商家 4 类管理角色）
 * - 平台身份调用正常委托 service
 *
 * 反测方向：删掉控制器里的 `requirePlatformIdentity(req)` ⇒ 本文件
 * 「商家身份 → 403」3 条断言变红（会变成正常委托）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { ForbiddenException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { AiConfigController } from './ai-config.controller';
import { AiConfigAdminService } from '../tenant/ai-config-admin.service';
import {
  SetModelPriceEnabledDto,
  UpsertModelPriceDto,
} from './dto/ai-config.dto';

function createAdminService(): jest.Mocked<AiConfigAdminService> {
  return {
    listModelPrices: jest.fn().mockResolvedValue([]),
    createModelPrice: jest.fn().mockResolvedValue({ id: 1 }),
    setModelPriceEnabled: jest.fn().mockResolvedValue({ id: 1 }),
  } as unknown as jest.Mocked<AiConfigAdminService>;
}

/** 构造带 AdminGuard 挂载身份的 mock request */
function reqOf(
  identityType: 'merchant' | 'platform',
  tenantId?: string,
): Request {
  return {
    adminIdentity: { identityType, tenantId, userId: 1, username: 'tester' },
  } as unknown as Request;
}

function makeUpsertDto(): UpsertModelPriceDto {
  const dto = new UpsertModelPriceDto();
  dto.provider = 'deepseek';
  dto.model = 'deepseek-chat';
  dto.promptPrice = 0.001;
  dto.completionPrice = 0.002;
  return dto;
}

describe('R101-AI-09 单价端点平台身份收口', () => {
  let adminService: jest.Mocked<AiConfigAdminService>;
  let controller: AiConfigController;

  beforeEach(() => {
    adminService = createAdminService();
    controller = new AiConfigController(adminService);
  });

  describe('商家身份 → 403（不得只挂 AdminGuard）', () => {
    it('GET model-prices（商家）→ 403，不触达 service', () => {
      expect(() =>
        controller.listModelPrices(reqOf('merchant', 'tenant-A')),
      ).toThrow(ForbiddenException);
      expect(adminService.listModelPrices).not.toHaveBeenCalled();
    });

    it('POST model-prices（商家）→ 403，不触达 service', () => {
      expect(() =>
        controller.createModelPrice(
          reqOf('merchant', 'tenant-A'),
          makeUpsertDto(),
        ),
      ).toThrow(ForbiddenException);
      expect(adminService.createModelPrice).not.toHaveBeenCalled();
    });

    it('PUT model-prices/:id/enabled（商家）→ 403，不触达 service', () => {
      const dto = new SetModelPriceEnabledDto();
      dto.enabled = 0;
      expect(() =>
        controller.setModelPriceEnabled(reqOf('merchant', 'tenant-A'), 7, dto),
      ).toThrow(ForbiddenException);
      expect(adminService.setModelPriceEnabled).not.toHaveBeenCalled();
    });

    it('403 响应携带 AI_010 错误码', () => {
      try {
        controller.listModelPrices(reqOf('merchant', 'tenant-A'));
        throw new Error('预期 403，但被放行');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const body = (err as ForbiddenException).getResponse() as {
          code?: string;
          statusCode?: number;
        };
        expect(body.code).toBe('AI_010');
        expect(body.statusCode).toBe(403);
      }
    });
  });

  describe('平台身份 → 正常委托', () => {
    it('GET model-prices：透传 provider/model/includeDisabled', () => {
      controller.listModelPrices(
        reqOf('platform'),
        'deepseek',
        'deepseek-chat',
        '1',
      );
      expect(adminService.listModelPrices).toHaveBeenCalledWith({
        provider: 'deepseek',
        model: 'deepseek-chat',
        includeDisabled: true,
      });
    });

    it('GET model-prices：缺省只查启用行', () => {
      controller.listModelPrices(
        reqOf('platform'),
        undefined,
        undefined,
        undefined,
      );
      expect(adminService.listModelPrices).toHaveBeenCalledWith({
        provider: undefined,
        model: undefined,
        includeDisabled: false,
      });
    });

    it('POST model-prices：委托 createModelPrice(dto)', () => {
      const dto = makeUpsertDto();
      controller.createModelPrice(reqOf('platform'), dto);
      expect(adminService.createModelPrice).toHaveBeenCalledWith(dto);
    });

    it('PUT model-prices/:id/enabled：委托 setModelPriceEnabled(id, enabled)', () => {
      const dto = new SetModelPriceEnabledDto();
      dto.enabled = 0;
      controller.setModelPriceEnabled(reqOf('platform'), 7, dto);
      expect(adminService.setModelPriceEnabled).toHaveBeenCalledWith(7, 0);
    });
  });
});

describe('R101-AI-09 DTO 校验：单价 > 0 或显式 0，禁止负数', () => {
  /** 用 class-validator 直接校验（等价于全局 ValidationPipe 的 DTO 校验） */
  async function validateUpsert(payload: Record<string, unknown>) {
    return validate(plainToInstance(UpsertModelPriceDto, payload));
  }

  const base = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    promptPrice: 0.001,
    completionPrice: 0.002,
  };

  it('合法值（含显式 0 免费档）→ 无校验错误', async () => {
    expect(await validateUpsert(base)).toHaveLength(0);
    expect(
      await validateUpsert({ ...base, promptPrice: 0, completionPrice: 0 }),
    ).toHaveLength(0);
  });

  it('负数单价 → 校验失败（prompt 与 completion 各一条）', async () => {
    const errors = await validateUpsert({
      ...base,
      promptPrice: -0.001,
      completionPrice: -0.002,
    });
    const fields = errors.map((e) => e.property);
    expect(fields).toContain('promptPrice');
    expect(fields).toContain('completionPrice');
  });

  it('小于 0.000001 的单价 → 校验失败（避免入库静默舍入成 0 + 科学计数法逃逸）', async () => {
    const errors = await validateUpsert({ ...base, promptPrice: 0.0000001 });
    expect(errors.map((e) => e.property)).toContain('promptPrice');
  });

  it('小数位超过 6 位 → 校验失败（与 DECIMAL(12,6) 对齐）', async () => {
    const errors = await validateUpsert({ ...base, promptPrice: 0.1234567 });
    expect(errors.map((e) => e.property)).toContain('promptPrice');
  });

  it('provider/model 缺失、币种长度非 3、生效时间非法 → 校验失败', async () => {
    const errors = await validateUpsert({
      provider: '',
      model: '',
      promptPrice: 0.001,
      completionPrice: 0.002,
      currency: 'CN',
      effectiveFrom: 'not-a-date',
    });
    const fields = errors.map((e) => e.property);
    expect(fields).toContain('provider');
    expect(fields).toContain('model');
    expect(fields).toContain('currency');
    expect(fields).toContain('effectiveFrom');
  });

  it('enabled 只接受 0/1', async () => {
    const errors = await validateUpsert({ ...base, enabled: 5 });
    expect(errors.map((e) => e.property)).toContain('enabled');
  });
});
