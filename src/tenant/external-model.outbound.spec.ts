/**
 * R101-AI-04 反测：外部模型出站目标收敛为「仅公网 HTTPS」（P1-1 SSRF）
 *
 * 目标行为（规格）：
 * - a. scheme 必须 https:（http: 及其他协议拒绝）
 * - b. URL 不得内嵌凭据（user:pass@）
 * - c. host 为 IP 字面量时按受限网段拒绝（127/8、10/8、172.16/12、192.168/16、
 *      169.254/16、0.0.0.0、::1、fc00::/7、fe80::/10）
 * - d. host 为域名时解析并校验**全部** A/AAAA；连接期用同一次解析校验
 * - 收口覆盖 testConnection（入参 URL）与 testById（库中已存 URL）与
 *   create/update（保存前），不得只加在 controller
 *
 * 反测方向：逐条回退实现中的对应判定 ⇒ 本文件对应断言变红（见回传卡记录）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { lookup } from 'node:dns/promises';
import {
  assertAllowedOutboundUrl,
  assertAllowedRedirectTarget,
  assertPublicResolvableTarget,
  createGuardedLookup,
  isBlockedIp,
} from '../common/outbound-target.guard';
import { AiExternalModelEntity } from '../database/entities/ai-external-model.entity';
import { ProviderFactory } from '../providers/provider-factory';
import { OpenAICompatProvider } from '../providers/openai-compat.provider';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';

jest.mock('node:dns/promises');

const dnsLookup = lookup as unknown as jest.Mock;

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:220:1:248:1893:25c8:1946';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

/** 断言「被拒」：状态码 400 + 文案前缀，返回文案供进一步断言 */
async function expectRejected400(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    const rejected = err as BadRequestException;
    expect(rejected.getStatus()).toBe(400);
    expect(rejected.message).toContain('出站目标被拒');
    return rejected.message;
  }
  throw new Error('预期出站目标被拒，但调用被放行');
}

describe('R101-AI-04 出站目标守卫（纯判定）', () => {
  beforeEach(() => {
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValue([{ address: PUBLIC_V4, family: 4 }]);
  });

  describe('规则 a：仅 https:', () => {
    it('http: 被拒（400 + 明确文案）', () => {
      expect(() =>
        assertAllowedOutboundUrl('http://api.example.com/v1'),
      ).toThrow(BadRequestException);
      expect(() =>
        assertAllowedOutboundUrl('http://api.example.com/v1'),
      ).toThrow('仅允许公网 HTTPS');
    });

    it('ftp: 等非 http(s) 协议被拒', () => {
      expect(() => assertAllowedOutboundUrl('ftp://api.example.com')).toThrow(
        BadRequestException,
      );
    });

    it('正例：合法公网 HTTPS 放行并规范化（去尾斜杠）', () => {
      expect(assertAllowedOutboundUrl('https://api.example.com/v1/')).toBe(
        'https://api.example.com/v1',
      );
    });
  });

  describe('规则 b：拒绝内嵌凭据', () => {
    it('user:pass@ 被拒', () => {
      expect(() =>
        assertAllowedOutboundUrl('https://user:pass@api.example.com/v1'),
      ).toThrow('不得内嵌凭据');
    });
  });

  describe('规则 c：IP 字面量按网段拒绝', () => {
    const blocked = [
      'https://127.0.0.1:8080/v1',
      'https://10.1.2.3/v1',
      'https://172.16.0.1/v1',
      'https://172.31.255.254/v1',
      'https://192.168.1.1/v1',
      'https://169.254.169.254/latest/meta-data/',
      'https://0.0.0.0/v1',
      'https://[::1]/v1',
      'https://[fc00::1]/v1',
      'https://[fe80::1]/v1',
    ];

    it.each(blocked)('%s 被拒', (url) => {
      expect(() => assertAllowedOutboundUrl(url)).toThrow('命中受限网段');
    });

    it('正例：公网字面量与网段边界放行', () => {
      expect(assertAllowedOutboundUrl('https://8.8.8.8/v1')).toBe(
        'https://8.8.8.8/v1',
      );
      // 172.32.0.0/16 已不在 172.16/12 内
      expect(() =>
        assertAllowedOutboundUrl('https://172.32.0.1/v1'),
      ).not.toThrow();
      expect(isBlockedIp('172.15.255.255')).toBe(false);
      expect(isBlockedIp('172.16.0.0')).toBe(true);
    });
  });

  describe('规则 d：域名解析后校验全部 A/AAAA', () => {
    it('任一 A 记录落在私网 → 拒绝', async () => {
      dnsLookup.mockResolvedValue([
        { address: PUBLIC_V4, family: 4 },
        { address: '10.0.0.7', family: 4 },
      ]);
      await expect(
        assertPublicResolvableTarget('https://dns-rebind.example.com/v1'),
      ).rejects.toThrow('解析到受限地址 10.0.0.7');
    });

    it('全部为公网 → 放行', async () => {
      dnsLookup.mockResolvedValue([
        { address: PUBLIC_V4, family: 4 },
        { address: PUBLIC_V6, family: 6 },
      ]);
      await expect(
        assertPublicResolvableTarget('https://api.example.com/v1'),
      ).resolves.toBe('https://api.example.com/v1');
    });

    it('解析失败 / 零结果 → 拒绝（不静默放行）', async () => {
      dnsLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
      await expect(
        assertPublicResolvableTarget('https://nope.example.com/v1'),
      ).rejects.toThrow('解析失败');

      dnsLookup.mockResolvedValue([]);
      await expect(
        assertPublicResolvableTarget('https://empty.example.com/v1'),
      ).rejects.toThrow('未解析到任何地址');
    });
  });

  describe('连接期 lookup（同一解析，防 DNS rebinding）', () => {
    type NodeLookupResult = { err: Error | null; address: unknown };
    function runLookup(
      hostname: string,
      all: boolean,
    ): Promise<NodeLookupResult> {
      const fn = createGuardedLookup() as unknown as (
        hostname: string,
        options: { all?: boolean },
        cb: (err: Error | null, address: unknown, family?: number) => void,
      ) => void;
      return new Promise((resolve) => {
        fn(hostname, { all }, (err, address) => resolve({ err, address }));
      });
    }

    it('连接期解析到私网 → 直接以错误中断建连', async () => {
      dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      const { err } = await runLookup('metadata.example.com', false);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('出站目标被拒');
    });

    it('连接期全部公网 → 正常回传地址', async () => {
      dnsLookup.mockResolvedValue([{ address: PUBLIC_V4, family: 4 }]);
      const { err, address } = await runLookup('api.example.com', false);
      expect(err).toBeNull();
      expect(address).toBe(PUBLIC_V4);
    });

    it('Node 请求 all=true 时回传全部地址（仍逐条校验过）', async () => {
      dnsLookup.mockResolvedValue([
        { address: PUBLIC_V4, family: 4 },
        { address: PUBLIC_V6, family: 6 },
      ]);
      const { err, address } = await runLookup('api.example.com', true);
      expect(err).toBeNull();
      expect(address).toEqual([
        { address: PUBLIC_V4, family: 4 },
        { address: PUBLIC_V6, family: 6 },
      ]);
    });
  });

  describe('重定向目标校验（beforeRedirect）', () => {
    it('重定向到 http: / 内嵌凭据 / 受限字面量 → 拒绝', () => {
      expect(() =>
        assertAllowedRedirectTarget({
          protocol: 'http:',
          hostname: 'api.example.com',
        }),
      ).toThrow('重定向目标 scheme 必须为 https:');
      expect(() =>
        assertAllowedRedirectTarget({
          protocol: 'https:',
          hostname: 'api.example.com',
          auth: 'u:p',
        }),
      ).toThrow('不得内嵌凭据');
      expect(() =>
        assertAllowedRedirectTarget({
          protocol: 'https:',
          hostname: '169.254.169.254',
        }),
      ).toThrow('命中受限网段');
      expect(() =>
        assertAllowedRedirectTarget({ protocol: 'https:', host: '[::1]:443' }),
      ).toThrow('命中受限网段');
    });

    it('正例：重定向到公网 HTTPS 放行（域名解析交给连接期 lookup）', () => {
      expect(() =>
        assertAllowedRedirectTarget({
          protocol: 'https:',
          hostname: 'api.example.com',
          path: '/v1/chat/completions',
        }),
      ).not.toThrow();
    });
  });
});

describe('R101-AI-04 ExternalModelService 收口（入参 / 存量 / 保存前）', () => {
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
      name: 'custom_kimi',
      displayName: 'Kimi',
      providerBaseUrl: 'https://api.example.com/v1',
      apiKey: null,
      modelName: 'moonshot-v1-8k',
      enabled: 1,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    crypto = new CryptoService(createConfigService());
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValue([{ address: PUBLIC_V4, family: 4 }]);
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

  it('testConnection：http: 内网地址 → 400，且不发起任何出站请求', async () => {
    const postSpy = jest.spyOn(
      OpenAICompatProvider.prototype,
      'testConnection',
    );
    const message = await expectRejected400(() =>
      service.testConnection({
        providerBaseUrl: 'http://169.254.169.254/latest/meta-data/',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    );
    expect(message).toContain('https:');
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('testConnection：域名解析到私网 → 400（规则 d）', async () => {
    dnsLookup.mockResolvedValue([{ address: '192.168.1.20', family: 4 }]);
    const message = await expectRejected400(() =>
      service.testConnection({
        providerBaseUrl: 'https://evil.example.com/v1',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    );
    expect(message).toContain('192.168.1.20');
  });

  it('testConnection 正例：合法公网 HTTPS → 放行并委托 Provider', async () => {
    const testSpy = jest
      .spyOn(OpenAICompatProvider.prototype, 'testConnection')
      .mockResolvedValue({ success: true, message: '连接成功', latencyMs: 1 });

    await expect(
      service.testConnection({
        providerBaseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    ).resolves.toEqual({ success: true, message: '连接成功', latencyMs: 1 });
    expect(testSpy).toHaveBeenCalledTimes(1);
  });

  it('testById：库中已存 http://127.0.0.1 → 400（存量行同样收口）', async () => {
    const entity = makeEntity({
      providerBaseUrl: 'http://127.0.0.1:8080/v1',
      apiKey: crypto.encrypt('sk-stored'),
    });
    repo.findOne.mockResolvedValue(entity);
    const testSpy = jest.spyOn(
      OpenAICompatProvider.prototype,
      'testConnection',
    );

    await expectRejected400(() => service.testById(1));
    expect(testSpy).not.toHaveBeenCalled();
  });

  it('create：保存前拒绝 http: 与私网字面量（不落库）', async () => {
    await expectRejected400(() =>
      service.create({
        name: 'insecure',
        displayName: 'HTTP',
        providerBaseUrl: 'http://api.example.com/v1',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    );
    await expectRejected400(() =>
      service.create({
        name: 'private',
        displayName: '内网',
        providerBaseUrl: 'https://10.0.0.5/v1',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('update：保存前拒绝改成私网地址', async () => {
    repo.findOne.mockResolvedValue(
      makeEntity({ apiKey: crypto.encrypt('sk-a') }),
    );
    await expectRejected400(() =>
      service.update(1, {
        name: 'custom_kimi',
        displayName: 'Kimi',
        providerBaseUrl: 'https://192.168.0.9/v1',
        modelName: 'm',
      }),
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('create 正例：合法公网 HTTPS 正常落库（未过度拦截）', async () => {
    repo.findOne.mockResolvedValue(null);
    const view = await service.create({
      name: 'Custom Kimi',
      displayName: 'Kimi',
      providerBaseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-kimi',
      modelName: 'moonshot-v1-8k',
    });
    expect(view.providerBaseUrl).toBe('https://api.example.com/v1');
    expect(repo.save).toHaveBeenCalled();
  });
});

describe('R101-AI-04 补充：拒绝时打印被拒 host + 命中规则（不含凭据）', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('同步拒绝：日志含 rule + host，且不含真实凭据', () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    expect(() =>
      assertAllowedOutboundUrl('https://alice:secret@10.0.0.5/v1'),
    ).toThrow(BadRequestException);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('出站目标被拒');
    expect(line).toContain('rule=url-embedded-credentials');
    expect(line).toContain('host=10.0.0.5');
    expect(line).not.toContain('secret');
  });

  it('IP 字面量拒绝：日志含 host-ip-literal-blocked + host', () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    expect(() => assertAllowedOutboundUrl('https://169.254.169.254/x')).toThrow(
      BadRequestException,
    );
    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('rule=host-ip-literal-blocked');
    expect(line).toContain('host=169.254.169.254');
  });

  it('解析类拒绝：日志含 rule + host（不解析失败也留痕）', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    dnsLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);

    await expect(
      assertPublicResolvableTarget('https://evil.example.com/v1'),
    ).rejects.toThrow(BadRequestException);

    const line = String(warnSpy.mock.calls[0][0]);
    expect(line).toContain('rule=dns-blocked-address');
    expect(line).toContain('host=evil.example.com');
  });
});
