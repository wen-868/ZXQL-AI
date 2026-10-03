/**
 * bench-auth — 基准/种子脚本统一取 token（perf-bench / tool-bench / seed-employees 共用）
 *
 * 取 token 优先级（高→低）：
 * 1. 显式 token：环境变量 AI_BASE_TOKEN（或调用方传入的 argv token）
 * 2. 真实登录：环境变量 AI_BASE_USERNAME + AI_BASE_PASSWORD
 *    POST {authBase}/api/admin/auth/login  body {username,password}  → data.token
 * 3. 演示登录：POST {authBase}/api/admin/auth/demo-login（免密）
 *    ⚠ 仅允许本地/内网地址。生产域名为禁用（见下），因该端点免密即返回
 *      SUPER_ADMIN JWT，属 P0 漏洞，禁止脚本在生产上使用。
 *
 * 环境变量：
 * - AI_BASE_TOKEN     直接指定 JWT，跳过登录
 * - AI_BASE_USERNAME  真实登录账号（与 PASSWORD 同时提供才生效）
 * - AI_BASE_PASSWORD  真实登录密码
 * - ALLOW_DEMO_LOGIN  显式设为 '1' 才允许在生产域名使用 demo-login（应急，慎用）
 *
 * 负责人: AI底座 | 创建日期: 2026-10-03
 */
'use strict';

const DEMO_LOGIN_PATH = '/api/admin/auth/demo-login';
const LOGIN_PATH = '/api/admin/auth/login';

/** 本地/内网地址判定：只有这些地址允许免密演示登录 */
function isLocalish(host) {
  if (!host) return true;
  return /^(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i.test(
    host,
  );
}

function pickToken(json) {
  const d = json && json.data ? json.data : json;
  return d && d.token;
}

async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j && (j.msg || j.message)) || 'HTTP ' + r.status;
    throw new Error(msg);
  }
  return j;
}

/**
 * 取管理端 token
 * @param {object} opts
 * @param {string} opts.authBase 认证中心地址，如 http://127.0.0.1:8080
 * @param {string} [opts.token]  显式 token（优先）
 * @returns {Promise<{token:string, via:string}>}
 */
async function resolveAdminToken(opts) {
  const authBase = (opts.authBase || '').replace(/\/+$/, '');
  const explicit = opts.token || process.env.AI_BASE_TOKEN;
  if (explicit) return { token: explicit, via: '显式 token' };

  const username = process.env.AI_BASE_USERNAME;
  const password = process.env.AI_BASE_PASSWORD;
  if (username && password) {
    const j = await postJson(authBase + LOGIN_PATH, { username, password });
    const token = pickToken(j);
    if (!token) throw new Error('登录失败: ' + JSON.stringify(j).slice(0, 120));
    return { token, via: `真实登录(${username})` };
  }
  if (username || password) {
    throw new Error('AI_BASE_USERNAME 与 AI_BASE_PASSWORD 必须同时提供');
  }

  // 无凭据 → 演示登录，但先过生产门控
  let host = '';
  try {
    host = new URL(authBase).hostname;
  } catch {
    host = '';
  }
  if (!isLocalish(host) && process.env.ALLOW_DEMO_LOGIN !== '1') {
    throw new Error(
      `拒绝在非本地地址 ${host || authBase} 使用免密 demo-login。\n` +
        '  该端点免密即返回 SUPER_ADMIN JWT（P0）。请改为真实登录：\n' +
        '    AI_BASE_USERNAME=<账号> AI_BASE_PASSWORD=<密码> node scripts/<脚本>.js ...\n' +
        '  应急可用 ALLOW_DEMO_LOGIN=1 强制放行（会留痕于生产日志，不建议）。',
    );
  }
  const j = await postJson(authBase + DEMO_LOGIN_PATH, null);
  const token = pickToken(j);
  if (!token) throw new Error('demo-login 失败: ' + JSON.stringify(j).slice(0, 120));
  return { token, via: `演示登录(${host || authBase})` };
}

module.exports = { resolveAdminToken, isLocalish };
