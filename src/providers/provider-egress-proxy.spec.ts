/**
 * R101-AI-12 反测（P0）：代理环境下连接期 DNS 守卫必须仍然生效
 *
 * 缺陷（苏然 GAP-1，凌舟复核）：axios v1 在 `HTTP(S)_PROXY` 存在时自建代理隧道，
 * 顶层 `lookup` 不参与建连 ⇒ 连接期守卫整体失效（实测 `lookupCalls=0`，
 * CONNECT 直达代理），只剩出站前一次性解析 ⇒ DNS rebinding TOCTOU + 代理可把
 * 公网域名解析到内网。
 *
 * 修复：strict 出站一律 `proxy: false`（禁用环境代理）⇒ 本进程解析、校验、连接。
 *
 * 反测方向：去掉 `axiosEgressOptions` 里的 `proxy: false` ⇒ 本文件
 * 「代理环境下守卫拦截且代理零命中」断言变红（变成 CONNECT 直达代理 / 请求放行）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { createServer, type Server } from 'node:http';
import { lookup } from 'node:dns/promises';
import { OpenAICompatProvider } from './openai-compat.provider';
import { DeepSeekProvider } from './deepseek.provider';
import { GlmProvider } from './glm.provider';
import { OllamaProvider } from './ollama.provider';
import { ConfigService } from '@nestjs/config';

jest.mock('node:dns/promises');

const dnsLookup = lookup as unknown as jest.Mock;

const PRIVATE_IP = '10.0.0.7';
const PUBLIC_IP = '93.184.216.34';

/** 伪造代理：记录普通请求与 CONNECT 隧道次数 */
let proxyServer: Server;
let proxyUrl: string;
let proxyHits = 0;
let connectHits = 0;

const ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
];
const savedEnv: Record<string, string | undefined> = {};

function setProxyEnv(url?: string): void {
  for (const key of ENV_KEYS) {
    if (url === undefined) {
      delete process.env[key];
    } else if (key.includes('PROXY') || key.includes('proxy')) {
      if (key === 'NO_PROXY' || key === 'no_proxy') {
        delete process.env[key];
      } else {
        process.env[key] = url;
      }
    }
  }
}

function createConfigService(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
        DEEPSEEK_MODEL: 'deepseek-chat',
        GLM_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4',
        GLM_MODEL: 'glm-4-flash',
        OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
        OLLAMA_MODEL: 'qwen2.5:7b',
        DEFAULT_TEMPERATURE: '0.3',
        DEFAULT_MAX_TOKENS: '2048',
      };
      return map[key];
    }),
  } as unknown as ConfigService;
}

/** strict 出站的四个 Provider 调用（agents 层未改动，统一走 axiosEgressOptions） */
function callStrictProvider(
  name: 'openai-compat' | 'deepseek' | 'glm' | 'ollama',
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const messages = [{ role: 'user' as const, content: 'ping' }];
  if (name === 'openai-compat') {
    const provider = new OpenAICompatProvider('ext_probe', {
      apiKey: 'sk-x',
      baseUrl: url,
      model: 'm',
    });
    return provider.chatSync(messages, { signal });
  }
  if (name === 'deepseek') {
    const provider = new DeepSeekProvider(createConfigService());
    provider.configure({
      apiKey: 'sk-x',
      model: 'deepseek-chat',
      baseUrl: url,
      strictEgress: true,
    });
    return provider.chatSync(messages, { signal });
  }
  if (name === 'glm') {
    const provider = new GlmProvider(createConfigService());
    provider.configure({
      apiKey: 'sk-x',
      model: 'glm-4-flash',
      baseUrl: url,
      strictEgress: true,
    });
    return provider.chatSync(messages, { signal });
  }
  const provider = new OllamaProvider(createConfigService());
  provider.configure({
    apiKey: '',
    model: 'qwen2.5:7b',
    baseUrl: url,
    strictEgress: true,
  });
  return provider.chatSync(messages, { signal });
}

/** 取错误摘要（用于区分「守卫拦截」与「其它网络错误」） */
function errorText(err: unknown): string {
  const e = err as { code?: string; message?: string; cause?: unknown };
  const cause = (e?.cause as { message?: string } | undefined)?.message ?? '';
  return `${e?.code ?? ''} ${e?.message ?? ''} ${cause}`;
}

describe('R101-AI-12 代理环境下的连接期守卫', () => {
  beforeAll(async () => {
    proxyServer = createServer((_req, res) => {
      proxyHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('proxy-ok');
    });
    proxyServer.on('connect', (_req, socket) => {
      connectHits += 1;
      // 拒绝隧道：本测试只关心「请求是否走到了代理」以及守卫是否参与
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      proxyServer.listen(0, '127.0.0.1', resolve),
    );
    const address = proxyServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    proxyUrl = `http://127.0.0.1:${port}`;

    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
  });

  beforeEach(() => {
    proxyHits = 0;
    connectHits = 0;
    dnsLookup.mockReset();
    dnsLookup.mockResolvedValue([{ address: PRIVATE_IP, family: 4 }]);
  });

  afterEach(() => {
    setProxyEnv(undefined);
  });

  describe('代理 env + 私网解析 ⇒ 守卫仍拦截，且请求不得走到代理', () => {
    it.each(['openai-compat', 'deepseek', 'glm', 'ollama'] as const)(
      '%s：守卫拦截（出站目标被拒）+ 代理 CONNECT 命中为 0',
      async (name) => {
        setProxyEnv(proxyUrl);
        let error: unknown = null;
        try {
          await callStrictProvider(name, 'https://rebind.example.com/v1');
        } catch (err) {
          error = err;
        }

        expect(error).not.toBeNull();
        expect(errorText(error)).toContain('出站目标被拒');
        // 关键：一旦走代理，守卫就再也拦不住（修复前的红点）
        expect(connectHits).toBe(0);
        expect(proxyHits).toBe(0);
        // 守卫拿到的确实是目标域名（说明建连用的是本地解析）
        expect(dnsLookup).toHaveBeenCalledWith(
          'rebind.example.com',
          expect.anything(),
        );
      },
    );
  });

  describe('非 strict（平台/env 端点）不受影响：仍走代理', () => {
    it('strictEgress=false 时请求照常经代理（未扩大收紧范围）', async () => {
      setProxyEnv(proxyUrl);
      const provider = new OllamaProvider(createConfigService());
      provider.configure({
        apiKey: '',
        model: 'qwen2.5:7b',
        baseUrl: 'https://platform.example.com',
        strictEgress: false,
      });

      await expect(
        provider.chatSync([{ role: 'user', content: 'ping' }]),
      ).rejects.toBeDefined();

      // 平台端点保持原有代理能力（本卡只收紧 strict 出站）
      expect(connectHits).toBeGreaterThan(0);
    });
  });

  describe('非代理链路正例未被破坏', () => {
    it('无代理 env + 公网解析 ⇒ 守卫参与且不因守卫被拒', async () => {
      setProxyEnv(undefined);
      dnsLookup.mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);

      let error: unknown = null;
      try {
        // 连到公网 IP 必然不可达/被沙箱阻断，用短超时快速失败
        await callStrictProvider(
          'openai-compat',
          'https://public.example.com/v1',
          AbortSignal.timeout(400),
        );
      } catch (err) {
        error = err;
      }

      expect(error).not.toBeNull();
      // 不是守卫拒绝 ⇒ 说明公网目标被守卫放行（后续失败属网络层）
      expect(errorText(error)).not.toContain('出站目标被拒');
      // 守卫参与建连（本地解析了目标域名）
      expect(dnsLookup).toHaveBeenCalledWith(
        'public.example.com',
        expect.anything(),
      );
      expect(connectHits).toBe(0);
    });

    it('无代理 env + 私网解析 ⇒ 守卫拦截（原行为不回退）', async () => {
      setProxyEnv(undefined);
      let error: unknown = null;
      try {
        await callStrictProvider('deepseek', 'https://rebind.example.com/v1');
      } catch (err) {
        error = err;
      }
      expect(errorText(error)).toContain('出站目标被拒');
    });
  });
});
