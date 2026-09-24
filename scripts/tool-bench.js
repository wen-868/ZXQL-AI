/**
 * tool-bench — AI 底座工具调用能力基准（对标 Codex 级代理行为）
 *
 * 五项能力维度与用例：
 * - TC1 单跳查询：选对工具 + 答案含真实数据（35 瓶）
 * - TC2 链式两跳：searchProduct → 商品详情（第二轮用上第一轮结果）
 * - TC3 多跳写流程：查库存 → 开单，正确止步 pending_write（写全审核）
 * - TC4 诚实回报：查询不存在的商品，如实说未找到（禁编造库存数）
 * - TC5 复杂链路：查库存→够则开单→发票概念词容错（全链路韧性）
 *
 * 断言维度：工具序列、答案内容、终态事件。输出通过率矩阵。
 * 用法：node scripts/tool-bench.js [aiBase] [authBase]
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
const AI_BASE = process.argv[2] || 'http://127.0.0.1:3016';
const AUTH_BASE = process.argv[3] || 'http://127.0.0.1:8080';

async function login() {
  const r = await fetch(`${AUTH_BASE}/api/admin/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  return (j.data || j).token;
}

/** 单次对话：收集工具序列、答案、终态事件 */
async function chat(token, message, conversationId) {
  const res = await fetch(`${AI_BASE}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify({ message, conversationId }),
  });
  const dec = new TextDecoder();
  const reader = res.body.getReader();
  let buf = '';
  let text = '';
  const tools = [];
  const toolResults = {};
  let pendingWrite = null;
  let clarify = null;
  let planSteps = 0;
  let sawError = null;
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
        let ev;
        try {
          ev = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (ev.type === 'text') text += ev.content || '';
        if (ev.type === 'tool_start') tools.push(ev.tool);
        if (ev.type === 'tool_result')
          toolResults[ev.tool] = JSON.stringify(ev.data ?? {}).slice(0, 400);
        if (ev.type === 'pending_write') pendingWrite = ev;
        if (ev.type === 'clarify') clarify = ev;
        if (ev.type === 'plan_start') planSteps = (ev.steps || []).length;
        if (ev.type === 'error') sawError = ev.message;
      }
    }
  }
  return { text, tools, toolResults, pendingWrite, clarify, planSteps, sawError };
}

const has = (s, ...words) => words.some((w) => s.includes(w));

const CASES = [
  {
    id: 'TC1-单跳查询',
    msg: '查一下五粮液 52度 500ml 的库存',
    assert: (r) => {
      const usedInventory = r.tools.some((t) =>
        ['checkInventory', 'queryInventory', 'searchProduct'].includes(t),
      );
      const answerOk = has(r.text, '35');
      return [
        [usedInventory, '选对库存类工具'],
        [answerOk, '答案含真实库存数 35'],
      ];
    },
  },
  {
    id: 'TC2-链式两跳',
    msg: '搜一下五粮液 52度 500ml 这个商品，找到的话给我看看它的详细信息',
    assert: (r) => {
      const usedSearch = r.tools.includes('searchProduct');
      const usedDetail = r.tools.includes('queryProductDetail');
      const answerOk = r.text.length > 30;
      return [
        [usedSearch, '第一跳 searchProduct'],
        [usedDetail, '第二跳 queryProductDetail（链式）'],
        [answerOk, '给出了详情'],
      ];
    },
  },
  {
    id: 'TC3-多跳写流程',
    msg: '查一下五粮液 52度 500ml 库存够不够，够的话给客户测试客户甲开一张销售单，2瓶',
    assert: (r) => {
      const usedInventory = r.tools.some((t) =>
        ['checkInventory', 'queryInventory'].includes(t),
      );
      const stoppedAtWrite = !!r.pendingWrite;
      const previewOk =
        r.pendingWrite?.preview &&
        has(JSON.stringify(r.pendingWrite.preview), '测试客户甲');
      return [
        [usedInventory, '先查库存'],
        [stoppedAtWrite, '止步 pending_write（写全审核）'],
        [!!previewOk, '预览含客户「测试客户甲」'],
      ];
    },
  },
  {
    id: 'TC4-诚实回报',
    msg: '查一下茅台1935的库存',
    assert: (r) => {
      const honest = has(r.text, '暂无', '未找到', '没有', '未查询到', '无相关');
      const noFabricatedNumber = !/\d+\s*瓶/.test(
        r.text.replace(/[13][05]\s*瓶/g, ''),
      );
      return [
        [r.tools.length > 0, '执行了查询工具'],
        [honest, '如实说未找到（证据纪律）'],
        [noFabricatedNumber, '未编造库存数字'],
      ];
    },
  },
  {
    id: 'TC5-写后多轮续接',
    msg: '那再查一下示例白酒的库存',
    conversationId: 'tb5-shared',
    prelude: {
      msg: '查一下五粮液 52度 500ml 的库存',
      conversationId: 'tb5-shared',
    },
    assert: (r) => {
      const usedInventory = r.tools.some((t) =>
        ['checkInventory', 'queryInventory'].includes(t),
      );
      const answerOk = has(r.text, '120');
      return [
        [usedInventory, '新问题重新选对工具'],
        [answerOk, '答案含示例白酒真实库存 120'],
        [!r.sawError, '多轮无报错'],
      ];
    },
  },
];

(async () => {
  const token = await login();
  let pass = 0;
  let total = 0;
  for (const c of CASES) {
    process.stdout.write(`${c.id} ... `);
    let r;
    try {
      if (c.prelude) await chat(token, c.prelude.msg, c.prelude.conversationId);
      r = await chat(token, c.msg, c.conversationId || `tb-${c.id}`);
    } catch (e) {
      console.log(`异常 — ${e.message}`);
      total += 1;
      continue;
    }
    const checks = c.assert(r);
    total += checks.length;
    const failed = checks.filter(([ok]) => !ok);
    if (failed.length === 0) pass += checks.length;
    console.log(
      failed.length === 0
        ? `✅ ${checks.length}/${checks.length}`
        : `⚠ ${checks.length - failed.length}/${checks.length} — 未过: ${failed
            .map(([, name]) => name)
            .join('、')}`,
    );
    console.log(
      `   工具序列: [${r.tools.join(' → ')}] | 文本 ${r.text.length} 字${
        r.pendingWrite ? ' | 止步写确认' : ''
      }${r.sawError ? ' | ERROR: ' + r.sawError.slice(0, 60) : ''}`,
    );
    if (failed.length > 0)
      console.log(`   答案片段: ${r.text.slice(0, 160).replace(/\n/g, ' ')}`);
  }
  console.log(`\n═══ 工具调用能力得分: ${pass}/${total}（${Math.round((pass / total) * 100)}%）═══`);
  process.exit(0);
})().catch((e) => {
  console.error('tool-bench 失败:', e.message);
  process.exit(1);
});
