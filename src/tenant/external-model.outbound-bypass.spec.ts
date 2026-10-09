/**
 * R101-AI-06 对抗性绕过反测（攻方枚举）：出站目标仅公网 HTTPS
 *
 * 与 external-model.outbound.spec.ts（实现者自写的正向+基础反向）互补：
 * 本文件按攻方视角逐条枚举混淆/绕过手法，断言「必然被拒」或「如实记录当前放行」。
 *
 * 取证基线（本机 node 22 / axios 1.19.0 实测，2026-10-09）：
 * - WHATWG URL 解析器会把大多数 IP 混淆写法归一化为点分十进制（见 ③⑧）；
 * - axios 顶层 `lookup` 仅在**非代理**链路被消费；HTTP(S)_PROXY 环境下走代理
 *   transport 时 lookup 被丢弃 ⇒ 连接期 DNS 守卫在代理链路整体失效（⑥ GAP-1，
 *   沙箱环境即设 HTTP_PROXY=127.0.0.1:32939，实测 lookupCalled=0）；
 * - axios `beforeRedirect` 经 follow-redirects 消费，代理与否均生效（⑦ 实证）。
 *
 * ⚠️ GAP 标记的用例：断言的是「当前实现放行/失效」的如实取证——修复落地后
 * 该断言会变红，届时必须同步改写为拒收断言（红 = 修复已存在的提示，非回归）。
 *
 * 负责人: 苏然（测试+QA）| 创建日期: 2026-10-09
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Repository } from 'typeorm';
import { lookup } from 'node:dns/promises';
import {
  assertAllowedOutboundUrl,
  assertAllowedRedirectTarget,
  assertPublicResolvableTarget,
  createGuardedLookup,
  OUTBOUND_REJECT_PREFIX,
} from '../common/outbound-target.guard';
import { AiExternalModelEntity } from '../database/entities/ai-external-model.entity';
import { AiConfigService } from './ai-config.service';
import { TenantContext } from './tenant-context';
import { CryptoService } from './crypto.service';
import { ExternalModelService } from './external-model.service';
import { ProviderFactory } from '../providers/provider-factory';
import { TenantAiConfigEntity } from '../database/entities/tenant-ai-config.entity';
import { PlatformAiConfigEntity } from '../database/entities/platform-ai-config.entity';
import { AiModelPriceEntity } from '../database/entities/ai-model-price.entity';

jest.mock('node:dns/promises');

const dnsLookup = lookup as unknown as jest.Mock;

const ENCRYPTION_KEY =
  '14804bc70a2fcff7125aca977139aa5a92e3bff867e5aa1c5ebf1c3219db7359';
const PUBLIC_V4 = '93.184.216.34';

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) =>
      key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined,
    ),
  } as unknown as ConfigService;
}

beforeEach(() => {
  dnsLookup.mockReset();
  dnsLookup.mockResolvedValue([{ address: PUBLIC_V4, family: 4 }]);
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** 启动一次性本机 HTTP 服务（仅 127.0.0.1，不出网），返回端口与关闭函数 */
async function startLocalServer(handler: http.RequestListener): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe('① scheme 大小写/空白混淆', () => {
  it('守卫层：HTTPS:// 大写 scheme 放行（WHATWG 归一化 protocol=https:，语义等价——如实记录为放行）', () => {
    const out = assertAllowedOutboundUrl('HTTPS://EXAMPLE.COM/v1');
    expect(new URL(out).protocol).toBe('https:');
  });

  it('守卫层：前导空白 " https://" 放行（trim 语义，等价 https，无绕过面）', () => {
    expect(() =>
      assertAllowedOutboundUrl('  https://example.com/v1'),
    ).not.toThrow();
  });

  it('服务层：create("HTTPS://…") 被旧口径正则拒（409）⇒ 端到端无违规出站', async () => {
    const crypto = new CryptoService(createConfigService());
    const repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e: AiExternalModelEntity) => e),
      save: jest.fn(),
      remove: jest.fn(),
    };
    const service = new ExternalModelService(
      repo as unknown as Repository<AiExternalModelEntity>,
      crypto,
      {
        registerExternal: jest.fn(),
        unregisterExternal: jest.fn(),
      } as unknown as ProviderFactory,
    );
    await expect(
      service.create({
        name: 'upper',
        displayName: '大写',
        providerBaseUrl: 'HTTPS://api.example.com/v1',
        apiKey: 'sk-x',
        modelName: 'm',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.save).not.toHaveBeenCalled();
  });
});

describe('② 尾点域名（FQDN trailing dot）', () => {
  it('尾点域名按域名处理：公网解析时放行（校验与连接同 hostname，无绕过面）', async () => {
    await expect(
      assertPublicResolvableTarget('https://example.com./v1'),
    ).resolves.toBe('https://example.com./v1');
  });

  it('尾点域名解析到私网 → 拒（尾点不豁免规则 d）', async () => {
    dnsLookup.mockResolvedValue([{ address: '10.0.0.7', family: 4 }]);
    await expect(
      assertPublicResolvableTarget('https://example.com./v1'),
    ).rejects.toThrow('解析到受限地址 10.0.0.7');
  });
});

describe('③ 非点分十进制 IP 字面量（攻方期望：绕过字符串前缀判定）', () => {
  it.each([
    'https://2130706433/', // 十进制整数 = 127.0.0.1
    'https://0177.0.0.1/', // 八进制首段
    'https://0x7f.1/', // 十六进制混合
    'https://0x7f000001/', // 全十六进制整数
    'https://127.1/', // 缩写点分
  ])('%s → WHATWG 归一化为 127.0.0.1 → 规则 c 拒', (url) => {
    expect(() => assertAllowedOutboundUrl(url)).toThrow('命中受限网段');
  });
});

describe('④ IPv4-mapped / 兼容 / NAT64 IPv6 字面量', () => {
  it.each([
    'https://[::ffff:127.0.0.1]/',
    'https://[::ffff:169.254.169.254]/',
    'https://[::ffff:7f00:1]/', // 十六进制写法
    'https://[0:0:0:0:0:ffff:a9fe:a9fe]/', // 全展开
    'https://[::127.0.0.1]/', // IPv4-compatible
    'https://[64:ff9b::169.254.169.254]/', // NAT64
  ])('%s → 拒', (url) => {
    expect(() => assertAllowedOutboundUrl(url)).toThrow('命中受限网段');
  });

  it('正例对照：[::ffff:8.8.8.8]（公网 mapped）放行——不过度拦截', () => {
    expect(() =>
      assertAllowedOutboundUrl('https://[::ffff:8.8.8.8]/v1'),
    ).not.toThrow();
  });
});

describe('⑤ userinfo 变体', () => {
  it('percent 编码用户名（%75ser@example.com）→ 规则 b 拒', () => {
    expect(() =>
      assertAllowedOutboundUrl('https://%75ser@example.com/'),
    ).toThrow('不得内嵌凭据');
  });

  it('空 userinfo + 私网字面量（https://@127.0.0.1/）→ 规则 c 拒（username 为空串绕过 b，但被 c 接住）', () => {
    expect(() => assertAllowedOutboundUrl('https://@127.0.0.1/')).toThrow(
      '命中受限网段',
    );
  });

  it('空 userinfo + 公网域名（https://@example.com/）→ 放行（如实记录：空 userinfo 无凭据语义，无风险）', () => {
    expect(() =>
      assertAllowedOutboundUrl('https://@example.com/'),
    ).not.toThrow();
  });
});

describe('⑥ 多 A 记录与 DNS 重绑定', () => {
  it('一公网一私网 → 拒（任一记录命中即拒）', async () => {
    dnsLookup.mockResolvedValue([
      { address: PUBLIC_V4, family: 4 },
      { address: '10.0.0.7', family: 4 },
    ]);
    await expect(
      assertPublicResolvableTarget('https://mixed.example.com/v1'),
    ).rejects.toThrow('解析到受限地址 10.0.0.7');
  });

  it('校验期→连接期之间的重绑定窗口：连接期由 axios lookup 兜底', async () => {
    // 第 1 次解析（校验期）公网 → assertPublicResolvableTarget 通过；
    // 第 2 次解析（连接期，若生效）私网 → 应被 createGuardedLookup 拒绝。
    dnsLookup
      .mockResolvedValueOnce([{ address: PUBLIC_V4, family: 4 }])
      .mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(
      assertPublicResolvableTarget('https://rebind.example.com/v1'),
    ).resolves.toBe('https://rebind.example.com/v1');

    const fn = createGuardedLookup() as unknown as (
      hostname: string,
      options: { all?: boolean },
      cb: (err: Error | null, address: unknown, family?: number) => void,
    ) => void;
    const err = await new Promise<Error | null>((resolve) => {
      fn('rebind.example.com', { all: false }, (e) => resolve(e));
    });
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain(OUTBOUND_REJECT_PREFIX);
  });

  it('连接期集成证明（非代理链路）：axios 真实消费 lookup——DNS 解析到受限地址时真实建连被拦截', async () => {
    const { port, close } = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      // DNS mock 恒返回受限地址：若 axios 消费 lookup（proxy:false 直连），请求必须失败。
      dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      await expect(
        axios.get(`http://localhost:${port}/x`, {
          timeout: 3000,
          proxy: false, // 直连（绕开环境代理，本机 node22/axios1.19.0 实证 lookup 被消费）
          lookup: createGuardedLookup(),
        }),
      ).rejects.toThrow(OUTBOUND_REJECT_PREFIX);
    } finally {
      await close();
    }
  });

  it('GAP-1（如实取证，修复后本断言应变红改写）：环境/显式代理下 axios 走代理 transport——lookup 被丢弃，连接期 DNS 守卫整体失效', async () => {
    // 本机沙箱即存在 HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:32939（生产内网配代理出站同样常见）。
    const target = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    // 本地伪代理：收到（absolute-form）请求直接回 200，模拟代理转发链路
    const proxy = await startLocalServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    try {
      dnsLookup.mockReset();
      dnsLookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
      // 若 lookup 生效，目标域名 localhost 必被拒；走代理则守卫完全不知情。
      const resp = await axios.get(`http://localhost:${target.port}/x`, {
        timeout: 3000,
        proxy: { host: '127.0.0.1', port: proxy.port },
        lookup: createGuardedLookup(),
      });
      // 请求成功 + 全程零 DNS 调用 = 连接期校验未执行（DNS 由代理解析，
      // 「校验的解析 = 连接的解析」承诺在代理链路断裂；规则 d 仅剩出站前一次性解析）。
      expect(resp.status).toBe(200);
      expect(dnsLookup.mock.calls.length).toBe(0);
    } finally {
      await proxy.close();
      await target.close();
    }
  });

  it('正例对照：beforeRedirect 是真实生效的（重定向到 http: 被真实栈拦截）', async () => {
    const inner = await startLocalServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });
    const redirector = await startLocalServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${inner.port}/x` });
      res.end();
    });
    try {
      await expect(
        axios.get(`http://127.0.0.1:${redirector.port}/redirect`, {
          timeout: 3000,
          proxy: false,
          beforeRedirect: assertAllowedRedirectTarget,
        }),
      ).rejects.toThrow(OUTBOUND_REJECT_PREFIX);
    } finally {
      await redirector.close();
      await inner.close();
    }
  });
});

describe('⑦ 重定向链对抗（beforeRedirect 判定形态）', () => {
  it.each([
    [{ protocol: 'HTTP:', hostname: 'api.example.com' }], // 大写 scheme
    [{ protocol: 'HTTPS:', hostname: 'api.example.com' }], // 大写 https（严格小写比较，方向安全；follow-redirects 实际传小写，无误伤）
    [{ protocol: 'ftp:', hostname: 'api.example.com' }],
    [{ protocol: 'https:', hostname: '[::ffff:127.0.0.1]' }],
    [{ protocol: 'https:', hostname: 'api.example.com', auth: 'u:p' }],
  ])('重定向目标 %j → 拒', (options) => {
    expect(() =>
      assertAllowedRedirectTarget(options as Record<string, unknown>),
    ).toThrow(BadRequestException);
  });

  it('重定向到尾点域名 → 同步层放行（域名交连接期兜底；但见 GAP-1：连接期 lookup 失效 ⇒ 该兜底当前无着落，如实记录为缺口叠加）', () => {
    expect(() =>
      assertAllowedRedirectTarget({
        protocol: 'https:',
        host: 'example.com.:8443',
      }),
    ).not.toThrow();
  });
});

describe('⑧ URL 编码/百分号混淆与端口', () => {
  it.each([
    'https://%31%32%37.0.0.1/', // percent 编码的点分十进制
    'https://127．0．0．1/', // 全角点 U+FF0E
    'https://127。0。0。1/', // 表意句点 U+3002
    'https://127%EF%BD%A1.0.0.1/', // percent 编码的全角点（host 解析非法）
    'https://example.com:169.254.169.254/', // 端口段非法
  ])('%s → 拒', (url) => {
    expect(() => assertAllowedOutboundUrl(url)).toThrow(BadRequestException);
  });

  it('https://example.com:80/v1 → 放行（如实记录：端口不在裁定范围；host 仍须公网可解析 ⇒ 无内网绕过；影响面=可触达公网主机任意端口）', async () => {
    await expect(
      assertPublicResolvableTarget('https://example.com:80/v1'),
    ).resolves.toBe('https://example.com:80/v1');
  });

  it('https://[::1]:443/ → 拒', () => {
    expect(() => assertAllowedOutboundUrl('https://[::1]:443/')).toThrow(
      '命中受限网段',
    );
  });
});

describe('⑨ testById 走库中已存 URL', () => {
  function makeServiceWithRepo() {
    const crypto = new CryptoService(createConfigService());
    const repo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((e: AiExternalModelEntity) => e),
      save: jest.fn((e: AiExternalModelEntity) => Promise.resolve(e)),
      remove: jest.fn(),
    };
    const registerExternal = jest.fn();
    const factory = {
      registerExternal,
      unregisterExternal: jest.fn(),
    } as unknown as ProviderFactory;
    const service = new ExternalModelService(
      repo as unknown as Repository<AiExternalModelEntity>,
      crypto,
      factory,
    );
    return { crypto, repo, factory, service, registerExternal };
  }

  function makeEntity(overrides: Partial<AiExternalModelEntity> = {}) {
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

  it('存量行 mapped IPv6 字面量 → testById 400（规则 c 同样覆盖库中 URL）', async () => {
    const { crypto, repo, service } = makeServiceWithRepo();
    repo.findOne.mockResolvedValue(
      makeEntity({
        providerBaseUrl: 'https://[::ffff:127.0.0.1]/v1',
        apiKey: crypto.encrypt('sk-stored'),
      }),
    );
    await expect(service.testById(1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('GAP-2（如实取证，修复后本断言应变红改写）：存量违规行（http://127.0.0.1）经 onModuleInit 直接注册进运行时——无 a/b/c 复验', async () => {
    const { crypto, repo, service, registerExternal } = makeServiceWithRepo();
    repo.find.mockResolvedValue([
      makeEntity({
        providerBaseUrl: 'http://127.0.0.1:8080/v1',
        apiKey: crypto.encrypt('sk-legacy'),
      }),
    ]);
    // onModuleInit → registerModel：既不跑 assertAllowedOutboundUrl，也不解析 DNS。
    await service.onModuleInit();
    expect(registerExternal).toHaveBeenCalledTimes(1);
    const callArgs = registerExternal.mock.calls[0] as unknown[];
    const registered = callArgs[1] as { baseUrl: string };
    // 注册成功的 config.baseUrl 即非合规地址 ⇒ 对话链路（factory.create）可拿它出站。
    // 连接期 lookup 在代理链路被 axios 丢弃（GAP-1）且 Node 对 IP 字面量跳过 lookup、
    // scheme 亦无运行时复验 ⇒ 存量违规行在对话链路继续出站（testById 会拒，chat 不会）。
    expect(registered.baseUrl).toBe('http://127.0.0.1:8080/v1');
  });
});

describe('⑩ 商户可写端点链路（t_tenant_ai_config.api_endpoint）', () => {
  let tenantRepo: jest.Mocked<Repository<TenantAiConfigEntity>>;
  let platformRepo: jest.Mocked<Repository<PlatformAiConfigEntity>>;
  let tenantContext: TenantContext;
  let service: AiConfigService;
  let crypto: CryptoService;
  let externalMock: { getRuntimeConfig: jest.Mock };

  function makeRepo<T extends object>(): jest.Mocked<Repository<T>> {
    return {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    } as unknown as jest.Mocked<Repository<T>>;
  }

  function makeTenantConfig(
    overrides: Partial<TenantAiConfigEntity> = {},
  ): TenantAiConfigEntity {
    return {
      id: 1,
      tenantId: 'tenant-001',
      enabled: 1,
      provider: 'deepseek',
      apiKey: crypto.encrypt('sk-tenant-own'),
      apiEndpoint: null,
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 2048,
      systemPrompt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function makePlatformConfig(
    overrides: Partial<PlatformAiConfigEntity> = {},
  ): PlatformAiConfigEntity {
    return {
      id: 1,
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-chat',
      defaultApiKey: crypto.encrypt('sk-platform-default'),
      defaultEndpoint: null,
      defaultTemperature: 0.3,
      defaultMaxTokens: 2048,
      defaultSystemPrompt: null,
      ollamaFallbackEnabled: 1,
      evolutionAutoActivate: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    crypto = new CryptoService(createConfigService());
    tenantRepo = makeRepo<TenantAiConfigEntity>();
    platformRepo = makeRepo<PlatformAiConfigEntity>();
    tenantContext = new TenantContext();
    externalMock = { getRuntimeConfig: jest.fn().mockResolvedValue(null) };
    service = new AiConfigService(
      tenantRepo,
      platformRepo,
      tenantContext,
      crypto,
      externalMock as unknown as ExternalModelService,
      makeRepo<AiModelPriceEntity>(),
    );
  });

  function mockExternalConfig(value: {
    baseUrl: string;
    apiKey: string;
    model: string;
  }): void {
    externalMock.getRuntimeConfig.mockResolvedValue(value);
  }

  it('商户端点为「解析到私网的域名」：同步层只做 a/b/c 且全程不触发 DNS ⇒ 规则 d 完全依赖连接期（结合 GAP-1：该防线当前失效）——如实取证', async () => {
    tenantRepo.findOne.mockResolvedValue(
      makeTenantConfig({ apiEndpoint: 'https://rebind-tenant.example/v1' }),
    );
    platformRepo.findOne.mockResolvedValue(makePlatformConfig());
    const dnsCallsBefore = dnsLookup.mock.calls.length;

    const resolved = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
      service.getResolvedConfig(),
    );
    const cfg = (
      resolved as {
        providerConfig: { baseUrl?: string; strictEgress?: boolean };
      }
    ).providerConfig;
    expect(cfg.baseUrl).toBe('https://rebind-tenant.example/v1');
    expect(cfg.strictEgress).toBe(true);
    // 同步解析全程零 DNS 查询（设计如此：保存/解析必须是纯函数）
    expect(dnsLookup.mock.calls.length).toBe(dnsCallsBefore);
  });

  it('合并不稀释守卫标记：租户 strictEgress=true + 外部模型库可补全 → config.strictEgress 仍为 true', async () => {
    tenantRepo.findOne.mockResolvedValue(
      makeTenantConfig({ apiEndpoint: 'https://api.example.com/v1' }),
    );
    platformRepo.findOne.mockResolvedValue(makePlatformConfig());
    mockExternalConfig({
      baseUrl: 'https://external.example.com/v1',
      apiKey: 'sk-external',
      model: 'ext-model',
    });

    const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
      service.getProviderConfig(),
    );
    expect(result.config.baseUrl).toBe('https://api.example.com/v1');
    expect(result.config.strictEgress).toBe(true);
  });

  it('平台来源 + 外部模型补全 → strictEgress=false（信任边界：平台端点只告警不拒绝，卡内已裁定；如实记录为文档化取舍而非新缺口）', async () => {
    tenantRepo.findOne.mockResolvedValue(null);
    platformRepo.findOne.mockResolvedValue(makePlatformConfig());
    mockExternalConfig({
      baseUrl: 'https://external.example.com/v1',
      apiKey: 'sk-external',
      model: 'ext-model',
    });

    const result = await tenantContext.run({ tenantId: 'tenant-001' }, () =>
      service.getProviderConfig(),
    );
    expect(result.config.baseUrl).toBe('https://external.example.com/v1');
    expect(result.config.strictEgress).toBe(false);
  });
});
