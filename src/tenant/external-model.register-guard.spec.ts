/**
 * R101-AI-13 反测（P1）：运行时注册入口必须复验 a/b/c
 *
 * 缺陷（苏然 GAP-2）：`testById` 会拒、`chatSync` 不会 —— `registerModel` 在运行时
 * 注册外部模型时没有 a/b/c 复验；叠加 IP 字面量跳过 lookup + scheme 无运行时复验
 * ⇒ 三层皆漏。存量违规行（如 `http://127.0.0.1:8080`）或直插库的行，对话链路继续出站。
 *
 * 修复：注册入口 + 运行时配置入口均复用 `assertAllowedOutboundUrl`（同一守卫）。
 *
 * 反测方向：去掉 `registerModel` 里的 `assertAllowedOutboundUrl` ⇒ 本文件
 * 「违规行注册被拒」断言变红（factory.registerExternal 会被调用）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { AiExternalModelEntity } from '../database/entities/ai-external-model.entity';
import { ProviderFactory } from '../providers/provider-factory';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

describe('R101-AI-13 运行时注册入口复验出站目标', () => {
  let service: ExternalModelService;
  let repo: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let factory: { registerExternal: jest.Mock; unregisterExternal: jest.Mock };
  let crypto: CryptoService;

  function makeEntity(
    overrides: Partial<AiExternalModelEntity> = {},
  ): AiExternalModelEntity {
    return {
      id: 1,
      name: 'custom_probe',
      displayName: 'Probe',
      providerBaseUrl: 'https://api.example.com/v1',
      apiKey: null,
      modelName: 'm',
      enabled: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    crypto = new CryptoService(createConfigService());
    repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e: AiExternalModelEntity) => e),
      save: jest.fn((e: AiExternalModelEntity) => Promise.resolve(e)),
      remove: jest.fn((e: AiExternalModelEntity) => Promise.resolve(e)),
    };
    factory = {
      registerExternal: jest.fn(),
      unregisterExternal: jest.fn(),
    };
    service = new ExternalModelService(
      repo as unknown as Repository<AiExternalModelEntity>,
      crypto,
      factory as unknown as ProviderFactory,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit（启动加载既有行）', () => {
    it('违规行（http:// 内网）不注册，且不影响其它合规行注册', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      repo.find.mockResolvedValue([
        makeEntity({
          id: 1,
          name: 'legacy_http',
          providerBaseUrl: 'http://127.0.0.1:8080',
          apiKey: crypto.encrypt('sk-legacy'),
        }),
        makeEntity({
          id: 2,
          name: 'ok_model',
          providerBaseUrl: 'https://api.example.com/v1',
          apiKey: crypto.encrypt('sk-ok'),
        }),
      ]);

      await service.onModuleInit();

      const registered = factory.registerExternal.mock.calls.map(
        (c: unknown[]) => String(c[0]),
      );
      expect(registered).toEqual(['ok_model']); // 违规行被拒、合规行照常
      expect(registered).not.toContain('legacy_http');
      const logged = errorSpy.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .join('\n');
      expect(logged).toContain('拒绝注册');
      expect(logged).toContain('host=127.0.0.1');
    });

    it('违规行（https:// 私网字面量）不注册', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      repo.find.mockResolvedValue([
        makeEntity({
          id: 3,
          name: 'legacy_private',
          providerBaseUrl: 'https://10.0.0.5/v1',
          apiKey: crypto.encrypt('sk-private'),
        }),
      ]);

      await service.onModuleInit();

      expect(factory.registerExternal).not.toHaveBeenCalled();
    });
  });

  describe('getRuntimeConfig（运行时配置路径）', () => {
    it('违规行 → 显式拒绝（400 语义），不静默返回配置', async () => {
      repo.findOne.mockResolvedValue(
        makeEntity({
          providerBaseUrl: 'http://169.254.169.254/latest',
          apiKey: crypto.encrypt('sk-x'),
        }),
      );

      await expect(
        service.getRuntimeConfig('custom_probe'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.getRuntimeConfig('custom_probe')).rejects.toThrow(
        '出站目标被拒',
      );
    });

    it('合规行 → 正常返回（未过度拦截）', async () => {
      repo.findOne.mockResolvedValue(
        makeEntity({ apiKey: crypto.encrypt('sk-ok') }),
      );

      await expect(service.getRuntimeConfig('custom_probe')).resolves.toEqual({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-ok',
        model: 'm',
      });
    });
  });
});
