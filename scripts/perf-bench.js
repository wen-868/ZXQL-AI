/**
 * perf-bench — AI 底座性能基准测试
 *
 * 场景：
 * - S1 简单寒暄（无工具；fallback 车道→LLM 分诊一次，可观测分诊开销）
 * - S2 单工具查询（rules 车道，1 次工具调用）
 * - S3 复杂目标（规划 + 多工具）
 * - C5 并发：S2 × 5 并发（限流/内存稳定性）
 *
 * 指标：TTFB（首个 SSE 事件）、总耗时、token、迭代数、事件构成。
 * 用法：node scripts/perf-bench.js [aiBase] [authBase] [每场景次数]
 * 默认：http://127.0.0.1:3016  http://127.0.0.1:8080  3
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
const AI_BASE = process.argv[2] || 'http://127.0.0.1:3016';
const AUTH_BASE = process.argv[3] || 'http://127.0.0.1:8080';
const RUNS = Number(process.argv[4] || 3);

async function login() {
  const r = await fetch(`${AUTH_BASE}/api/admin/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  const token = (j.data || j).token;
  if (!token) throw new Error('登录失败: ' + JSON.stringify(j).slice(0, 120));
  return token;
}

/** 单次对话：返回 {ttfb, total, tokens, iterations, types, toolCalls, textLen} */
async function chat(token, message, conversationId) {
  const t0 = Date.now();
  const res = await fetch(`${AI_BASE}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ message, conversationId }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  let ttfb = null;
  let text = '';
  const types = new Set();
  let toolCalls = 0;
  let tokens = 0;
  let iterations = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        if (ttfb === null) ttfb = Date.now() - t0;
        let ev;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        types.add(ev.type);
        if (ev.type === 'text') text += ev.content || '';
        if (ev.type === 'tool_start') toolCalls++;
        if (ev.type === 'done') {
          tokens = ev.usage?.totalTokens || 0;
          iterations = ev.usage?.iterations || 0;
        }
      }
    }
  }
  return {
    ttfb,
    total: Date.now() - t0,
    tokens,
    iterations,
    toolCalls,
    textLen: text.length,
    types: [...types].join('+'),
  };
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const SCENARIOS = [
  { id: 'S1-寒暄(fallback分诊)', msg: '你好，请介绍一下你自己' },
  { id: 'S2-单工具查询(rules车道)', msg: '查一下五粮液的库存' },
  {
    id: 'S3-复杂目标(规划+多工具)',
    msg: '查一下五粮液的库存然后帮我看看销量情况',
  },
];

(async () => {
  const token = await login();
  console.log(`基线测试：${AI_BASE}（每场景 ${RUNS} 次）\n`);
  const results = {};
  for (const sc of SCENARIOS) {
    results[sc.id] = [];
    for (let k = 0; k < RUNS; k++) {
      const cid = `perf-${sc.id.slice(0, 2)}-${Date.now()}`;
      try {
        const r = await chat(token, sc.msg, cid);
        results[sc.id].push(r);
        console.log(
          `${sc.id} #${k + 1}: TTFB ${r.ttfb}ms | 总耗时 ${r.total}ms | tokens ${r.tokens} | 迭代 ${r.iterations} | 工具 ${r.toolCalls} | 事件 ${r.types}`,
        );
      } catch (e) {
        console.log(`${sc.id} #${k + 1}: 失败 — ${e.message}`);
      }
    }
    const ok = results[sc.id];
    if (ok.length)
      console.log(
        `  ▶ 中位：TTFB ${median(ok.map((r) => r.ttfb))}ms | 总耗时 ${median(
          ok.map((r) => r.total),
        )}ms | tokens ${median(ok.map((r) => r.tokens))}\n`,
      );
  }

  // 并发测试
  console.log(`C5 并发测试：S2 × 5 并发`);
  const t0 = Date.now();
  const jobs = Array.from({ length: 5 }, (_, i) =>
    chat(token, '查一下五粮液的库存', `perf-conc-${Date.now()}-${i}`),
  );
  const conc = await Promise.allSettled(jobs);
  const okRuns = conc.filter((r) => r.status === 'fulfilled').length;
  const totals = conc
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value.total);
  console.log(
    `  ▶ 成功率 ${okRuns}/5 | 墙钟 ${Date.now() - t0}ms | 单请求中位 ${median(totals)}ms | 最大 ${Math.max(...totals)}ms\n`,
  );
})().catch((e) => {
  console.error('基准测试失败:', e.message);
  process.exit(1);
});
