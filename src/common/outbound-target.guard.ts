/**
 * OutboundTargetGuard — 出站目标收敛为「仅公网 HTTPS」（R101-AI-04 / P1-1）
 *
 * 背景：外部模型连通性测试此前只校验 `/^https?:\/\//`，可填
 * `http://127.0.0.1:8080`、`http://169.254.169.254/…` 等（SSRF + 内网探测）。
 * 业主裁定（2026-10-09）：允许的出站目标 = 只允许公网 HTTPS。
 *
 * 四条规则（本模块是唯一出口）：
 *   a. scheme 必须 `https:`（拒绝 `http:` 及其他协议）
 *   b. 拒绝 URL 内嵌凭据（`user:pass@`）
 *   c. host 为 IP 字面量时按受限网段拒绝
 *   d. host 为域名时必须解析并校验全部 A/AAAA 结果；连接期用 lookup 再校验。
 *      ⚠️ 准确表述（凌舟 2026-10-09 裁定④）：连接期 lookup 与出站前
 *      `assertPublicResolvableTarget` 是**两次独立的 DNS 查询**，不是"同一次解析"。
 *      真正防 rebinding 的性质是：**放行时回传的就是刚刚校验过的那份地址**
 *      （`createGuardedLookup` 校验完 A/AAAA 后把该结果交给 Node 建连）⇒
 *      本次连接不会用到"未校验的另一次解析"。因此不存在"校验用一次、连接用另一次"
 *      的窗口；但**出站前那次解析与连接期那次解析之间仍有时间差**，安全性由
 *      连接期校验单独保证，不依赖出站前那次。
 *      ⚠️ R101-AI-12：该性质**仅在直连时成立**。若请求走了 `HTTP(S)_PROXY`，
 *      axios 会把连接交给自建代理隧道（顶层 `lookup` 不参与、agent 层 lookup 亦
 *      实测不参与），目标域名由**代理**解析 ⇒ 连接期守卫整体失效。
 *      故 strict 出站一律带 `proxy: false`（见 `axiosEgressOptions`）。
 *
 * 三类调用点共用本模块：
 *   1. 保存前（ExternalModelService.create/update）—— 规则 a/b/c（同步）
 *   2. 出站前（testConnection / testById）—— 规则 a/b/c/d（含解析）
 *   3. 连接期（各 Provider 的 axios `lookup` / `beforeRedirect`）—— 规则 c/d
 *      在真正建连的那次解析上生效（strict 出站直连，不走代理）
 *
 * 拒绝一律抛 BadRequestException（HTTP 400 + 明确文案），不静默放行、不只 log。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-09
 */
import { BadRequestException, Logger } from '@nestjs/common';
import type { AxiosRequestConfig } from 'axios';
import type { LookupAddress } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/** 拒绝文案前缀（调用方可据此前缀识别「出站目标被拒」） */
export const OUTBOUND_REJECT_PREFIX = '出站目标被拒';

/**
 * R101-AI-04 补充（凌舟 2026-10-09 裁定）：每次拒绝都要留下
 * 「被拒 host + 命中规则」，生产上线后 10 分钟内可定位。
 *
 * ⚠️ 日志与异常文案都**不含凭据**：不打印原始 URL（可能带 user:pass@），
 * 只打印 host 与规则码；无法解析的 URL 也不回显原文。
 */
const logger = new Logger('OutboundTargetGuard');

/** 统一拒绝：落 WARN 日志（host + 规则）后抛 BadRequestException(400) */
function reject(
  rule: string,
  host: string,
  detail: string,
): BadRequestException {
  const safeHost = host || '-';
  logger.warn(`出站目标被拒 rule=${rule} host=${safeHost} detail=${detail}`);
  return new BadRequestException(
    `${OUTBOUND_REJECT_PREFIX}（仅允许公网 HTTPS）：${detail} [rule=${rule} host=${safeHost}]`,
  );
}

/**
 * 同步校验规则 a/b/c，返回去掉尾部斜杠的 URL。
 *
 * 不解析 DNS（保存前调用必须是纯函数，避免写库依赖外网可达性）。
 */
export function assertAllowedOutboundUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // 不回显原文：无法解析的串里可能带凭据
    throw reject(
      'url-unparsable',
      '',
      'URL 无法解析（已隐去原文，避免回显凭据）',
    );
  }

  const hostname = stripBrackets(parsed.hostname);
  // a. 仅 https:
  if (parsed.protocol !== 'https:') {
    throw reject(
      'scheme-not-https',
      hostname,
      `scheme 必须为 https:（实际 ${parsed.protocol}）`,
    );
  }
  // b. 拒绝内嵌凭据
  if (parsed.username !== '' || parsed.password !== '') {
    throw reject(
      'url-embedded-credentials',
      hostname,
      'URL 不得内嵌凭据（user:pass@）',
    );
  }
  // c. IP 字面量按网段拒绝（域名留给 d 解析后判定）
  if (isBlockedHostLiteral(hostname)) {
    throw reject(
      'host-ip-literal-blocked',
      hostname,
      `host「${hostname}」命中受限网段`,
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * 异步校验规则 d：解析全部 A/AAAA，任一命中受限网段（或解析失败）即拒绝。
 *
 * 返回规范化 URL；IP 字面量无需解析（已由 a/b/c 判定）。
 */
export async function assertPublicResolvableTarget(
  raw: string,
): Promise<string> {
  const normalized = assertAllowedOutboundUrl(raw);
  const hostname = stripBrackets(new URL(normalized).hostname);
  if (isIP(hostname) !== 0) {
    return normalized;
  }
  const addresses = await resolveAll(hostname);
  const blocked = addresses.find((a) => isBlockedIp(a.address));
  if (blocked) {
    throw reject(
      'dns-blocked-address',
      hostname,
      `域名 ${hostname} 解析到受限地址 ${blocked.address}`,
    );
  }
  return normalized;
}

/**
 * 连接期 DNS 校验（Node `net.LookupFunction` / axios `lookup` 口径）。
 *
 * Node 在真正建连时调用本函数 ⇒ 校验的就是连接要用的那次解析结果。
 * 注意：先解析**全部** A/AAAA 并逐条校验，再按 Node 的 `all` 语义回传。
 */
export function createGuardedLookup(): NonNullable<
  AxiosRequestConfig['lookup']
> {
  const lookupFn: LookupFunction = (hostname, options, callback) => {
    void resolveAll(hostname).then(
      (addresses) => {
        const blocked = addresses.find((a) => isBlockedIp(a.address));
        if (blocked) {
          callback(
            reject(
              'dns-blocked-address-connect',
              hostname,
              `域名 ${hostname} 解析到受限地址 ${blocked.address}（连接期校验，防 DNS 重绑定）`,
            ),
            '',
            0,
          );
          return;
        }
        if (options.all === true) {
          callback(null, addresses);
          return;
        }
        callback(null, addresses[0].address, addresses[0].family);
      },
      (err: unknown) => {
        callback(toError(err), '', 0);
      },
    );
  };
  return lookupFn as NonNullable<AxiosRequestConfig['lookup']>;
}

/**
 * 重定向目标校验（axios `beforeRedirect` 钩子）。
 *
 * 抛出即中止跟随重定向（follow-redirects 会捕获并转为请求错误）。
 * 域名解析仍由连接期 `lookup` 校验，故此处只做同步可判定的部分。
 */
export function assertAllowedRedirectTarget(
  options: Record<string, unknown>,
): void {
  const protocol = typeof options.protocol === 'string' ? options.protocol : '';
  const rawHost = options.hostname ?? options.host;
  const host =
    typeof rawHost === 'string' ? hostnameFromHostField(rawHost) : '';
  if (protocol !== 'https:') {
    throw reject(
      'redirect-scheme-not-https',
      host,
      `重定向目标 scheme 必须为 https:（实际 ${protocol || '未知'}）`,
    );
  }
  if (typeof options.auth === 'string' && options.auth !== '') {
    throw reject(
      'redirect-embedded-credentials',
      host,
      '重定向目标不得内嵌凭据（user:pass@）',
    );
  }
  if (typeof rawHost !== 'string' || rawHost === '') {
    throw reject('redirect-missing-host', '', '重定向目标缺少 host');
  }
  if (isBlockedHostLiteral(host)) {
    throw reject(
      'redirect-ip-literal-blocked',
      host,
      `重定向目标 host「${host}」命中受限网段`,
    );
  }
}

/**
 * axios 请求选项片段（R101-AI-08 / R101-AI-12）
 *
 * `strict=true` ⇒ 挂上「仅公网 HTTPS」的连接期校验（DNS 校验 + 重定向校验），
 * 并**禁用环境代理**（`proxy: false`）。`strict` 为假/缺省 ⇒ 返回空对象，
 * **不改变**该请求行为。
 *
 * ⚠️ 为什么必须 `proxy: false`（R101-AI-12，P0）：
 *   - axios v1 在 `HTTP_PROXY`/`HTTPS_PROXY` 存在时自建代理隧道
 *     （`setProxy` → `HttpsProxyAgent`），此时**顶层 `lookup` 完全不参与建连**
 *     （实测 `lookupCalls=0`，CONNECT 直达代理）；把 lookup 挂到
 *     `httpsAgent` 上实测**同样不参与**（axios 只会把用户 agent 的 TLS 选项
 *     并入隧道 agent）。
 *   - 走代理时目标域名由**代理**解析 ⇒ 连接期校验在原理上无法覆盖目标
 *     ⇒ 规则 d 的承诺断裂（只剩出站前一次解析，留 DNS rebinding 窗口，
 *     且代理可把公网域名解析到内网）。
 *   - 故 strict 出站强制直连：本进程解析、本进程校验、本进程连接。
 *
 * 信任边界（凌舟 2026-10-09 裁定）：只有**商家可写**的端点
 * （`t_tenant_ai_config.api_endpoint`）与**外部模型库**才置 strict；
 * 平台 `default_endpoint` 与环境变量端点只做「记录 + 告警」，**不得擅自拒绝**，
 * 其请求行为（含是否走代理）保持原样。
 */
export function axiosEgressOptions(strict: boolean | undefined): {
  lookup?: NonNullable<AxiosRequestConfig['lookup']>;
  beforeRedirect?: (options: Record<string, unknown>) => void;
  proxy?: false;
} {
  if (strict !== true) {
    return {};
  }
  return {
    lookup: createGuardedLookup(),
    beforeRedirect: assertAllowedRedirectTarget,
    // 见上方说明：不禁代理则连接期守卫失效（R101-AI-12 P0）
    proxy: false,
  };
}

/** 是否为受限网段的 IP 字面量（域名返回 false） */
export function isBlockedHostLiteral(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase());
  const family = isIP(host);
  if (family === 4) {
    return isBlockedIpv4(host);
  }
  if (family === 6) {
    return isBlockedIpv6(host);
  }
  return false;
}

/** 单个 IP（v4/v6）是否命中受限网段；无法解析时保守拒绝 */
export function isBlockedIp(ip: string): boolean {
  const value = stripBrackets(ip.trim().toLowerCase());
  const family = isIP(value);
  if (family === 4) {
    return isBlockedIpv4(value);
  }
  if (family === 6) {
    return isBlockedIpv6(value);
  }
  return true; // 解析不出字面量 → 保守拒绝
}

/** IPv4 受限网段（含业主清单 + 同为不可公网路由的附加段） */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0) return true; // 0.0.0.0/8 本网络
  if (a === 10) return true; // 10.0.0.0/8 私网
  if (a === 127) return true; // 127.0.0.0/8 回环
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私网
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF 协议
  if (a >= 224) return true; // 224.0.0.0/4 组播 + 240.0.0.0/4 保留
  return false;
}

/** IPv6 受限网段（::1 / fc00::/7 / fe80::/10 + 等价内嵌 IPv4） */
function isBlockedIpv6(ip: string): boolean {
  const groups = ipv6Groups(ip);
  if (!groups) {
    return true; // 解析失败 → 保守拒绝
  }
  const [g0, g1] = groups;
  if (groups.every((g) => g === 0)) return true; // :: 未指定
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true; // ::1 回环
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 组播
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (groups.slice(0, 5).every((g) => g === 0)) {
    // ::ffff:a.b.c.d（IPv4-mapped）与 ::a.b.c.d（IPv4-compatible）
    const mapped = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${
      groups[7] & 0xff
    }`;
    return isBlockedIpv4(mapped);
  }
  return false;
}

/** IPv6 文本 → 8 组 16 位数值（含内嵌 IPv4 写法）；解析失败返回 null */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.split('%')[0];
  if (!text.includes(':')) {
    return null;
  }
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = tail.split('.').map((n) => Number.parseInt(n, 10));
    if (
      v4.length !== 4 ||
      v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    const hi = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
    const lo = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (!head || !rest) {
    return null;
  }
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const missing = 8 - head.length - rest.length;
  if (missing < 0) {
    return null;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function parseGroups(segment: string): number[] | null {
  if (segment === '') {
    return [];
  }
  const out: number[] = [];
  for (const part of segment.split(':')) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    out.push(Number.parseInt(part, 16));
  }
  return out;
}

/** 解析域名全部 A/AAAA；解析失败或零结果按拒绝处理 */
async function resolveAll(hostname: string): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw reject(
      'dns-resolve-failed',
      hostname,
      `域名 ${hostname} 解析失败（${detail}）`,
    );
  }
  if (addresses.length === 0) {
    throw reject(
      'dns-no-address',
      hostname,
      `域名 ${hostname} 未解析到任何地址`,
    );
  }
  return addresses;
}

/** 提取 host 字段里的主机名（兼容 `[::1]:443` / `example.com:443`） */
function hostnameFromHostField(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : value;
  }
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(0, colon);
}

/** 去掉 URL.hostname 的 IPv6 方括号 */
function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

/** unknown → Error（回调式 lookup 的错误位） */
function toError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  return new Error(String(err));
}
