/**
 * ExternalModelService 单元测试
 *
 * 覆盖：启动注册、添加加密存储+注册、同名冲突、更新留空 key 不修改、停用注销、
 *      删除注销、运行时配置解密、非法 URL 校验
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
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

function makeEntity(
  overrides: Partial<AiExternalModelEntity> = {},
): AiExternalModelEntity {
  return {
    id: 1,
    name: 'custom_kimi',
    displayName: 'Kimi',
    providerBaseUrl: 'https://api.moonshot.cn/v1',
    apiKey: null,
    modelName: 'moonshot-v1-8k',
    enabled: 1,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('ExternalModelService', () => {
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

  it('onModuleInit 加载启用模型并注册', async () => {
    const entity = makeEntity({ apiKey: crypto.encrypt('sk-kimi') });
    repo.find.mockResolvedValue([entity]);
    await service.onModuleInit();
    expect(factory.registerExternal).toHaveBeenCalledWith(
      'custom_kimi',
      expect.objectContaining({
        apiKey: 'sk-kimi',
        baseUrl: 'https://api.moonshot.cn/v1',
        model: 'moonshot-v1-8k',
      }),
    );
  });

  it('create 加密存储并注册', async () => {
    repo.findOne.mockResolvedValue(null);
    repo.save.mockImplementation((e: AiExternalModelEntity) => {
      e.id = 1;
      return Promise.resolve(e);
    });

    const view = await service.create({
      name: 'Custom Kimi',
      displayName: 'Kimi 外部模型',
      providerBaseUrl: 'https://api.moonshot.cn/v1/',
      apiKey: 'sk-kimi',
      modelName: 'moonshot-v1-8k',
    });

    expect(repo.create).toHaveBeenCalled();
    const callArgs = repo.save.mock.calls[0] as [AiExternalModelEntity];
    const saved = callArgs[0];
    expect(saved.name).toBe('custom_kimi');
    expect(saved.apiKey).not.toBe('sk-kimi'); // 已加密
    expect(crypto.decrypt(saved.apiKey as string)).toBe('sk-kimi');
    expect(saved.providerBaseUrl).toBe('https://api.moonshot.cn/v1'); // 去尾斜杠
    expect(factory.registerExternal).toHaveBeenCalledWith(
      'custom_kimi',
      expect.objectContaining({ apiKey: 'sk-kimi' }),
    );
    expect(view.apiKeyMasked).toContain('****');
  });

  it('create 同名冲突抛 409', async () => {
    repo.findOne.mockResolvedValue(makeEntity());
    await expect(
      service.create({
        name: 'custom_kimi',
        displayName: 'Kimi',
        providerBaseUrl: 'https://api.moonshot.cn/v1',
        apiKey: 'sk-x',
        modelName: 'm1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('create 缺少 API Key 抛错', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(
      service.create({
        name: 'custom_kimi',
        displayName: 'Kimi',
        providerBaseUrl: 'https://api.moonshot.cn/v1',
        modelName: 'm1',
      }),
    ).rejects.toThrow('API Key 必填');
  });

  it('update 留空 apiKey 不修改加密值', async () => {
    const entity = makeEntity({ apiKey: crypto.encrypt('sk-original') });
    repo.findOne.mockResolvedValue(entity);

    await service.update(1, {
      name: 'custom_kimi',
      displayName: 'Kimi 新名',
      providerBaseUrl: 'https://api.moonshot.cn/v1',
      modelName: 'moonshot-v1-32k',
    });

    expect(entity.displayName).toBe('Kimi 新名');
    expect(entity.modelName).toBe('moonshot-v1-32k');
    expect(crypto.decrypt(entity.apiKey as string)).toBe('sk-original');
  });

  it('update 停用后注销注册', async () => {
    const entity = makeEntity({ apiKey: crypto.encrypt('sk-x') });
    repo.findOne.mockResolvedValue(entity);

    await service.update(1, {
      name: 'custom_kimi',
      displayName: 'Kimi',
      providerBaseUrl: 'https://api.moonshot.cn/v1',
      modelName: 'm1',
      enabled: 0,
    });

    expect(entity.enabled).toBe(0);
    expect(factory.unregisterExternal).toHaveBeenCalledWith('custom_kimi');
    expect(factory.registerExternal).not.toHaveBeenCalled();
  });

  it('remove 注销并删除', async () => {
    const entity = makeEntity();
    repo.findOne.mockResolvedValue(entity);

    const result = await service.remove(1);

    expect(result.success).toBe(true);
    expect(factory.unregisterExternal).toHaveBeenCalledWith('custom_kimi');
    expect(repo.remove).toHaveBeenCalledWith(entity);
  });

  it('remove 不存在抛 404', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.remove(99)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getRuntimeConfig 解密返回运行时配置', async () => {
    repo.findOne.mockResolvedValue(
      makeEntity({ apiKey: crypto.encrypt('sk-kimi') }),
    );
    const config = await service.getRuntimeConfig('custom_kimi');
    expect(config).toEqual({
      baseUrl: 'https://api.moonshot.cn/v1',
      apiKey: 'sk-kimi',
      model: 'moonshot-v1-8k',
    });
  });

  it('getRuntimeConfig 未启用返回 null', async () => {
    // 查询条件 where: { name, enabled: 1 } 不命中 → 返回 null
    repo.findOne.mockResolvedValue(null);
    expect(await service.getRuntimeConfig('custom_kimi')).toBeNull();
  });

  it('testConnection 校验非法 URL 抛错', async () => {
    await expect(
      service.testConnection({
        providerBaseUrl: 'ftp://bad',
        apiKey: 'sk-x',
        modelName: 'm1',
      }),
    ).rejects.toThrow('必须以 http:// 或 https:// 开头');
  });

  it('testById 不存在或未配置密钥抛 404', async () => {
    repo.findOne.mockResolvedValue(null);
    await expect(service.testById(99)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
