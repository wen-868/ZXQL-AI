/**
 * seed-employees — 数字员工 MVP 岗位种子（补货流水线，12.7）
 *
 * 建两个岗位：库管家（可调度：[采专员]）与 采专员（终端）。
 * 用法：node scripts/seed-employees.js [aiBase] [adminJwt]
 * （adminJwt 缺省时经本地 demo-login 获取）
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
const AI_BASE = process.argv[2] || 'http://127.0.0.1:3016';
const AUTH_BASE = process.argv[3] || 'http://127.0.0.1:8080';

async function adminToken() {
  if (process.argv[4]) return process.argv[4];
  const r = await fetch(`${AUTH_BASE}/api/admin/auth/demo-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  const t = (j.data || j).token;
  if (!t) throw new Error('demo-login 失败');
  return t;
}

async function create(token, body) {
  const r = await fetch(`${AI_BASE}/api/ai/employees`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const token = await adminToken();

  // 终端岗位：采购专员
  const buyer = await create(token, {
    name: '采专员',
    post: '采购专员',
    department: '商品部',
    toolCategories: ['purchase', 'inventory'],
    personaPrompt: '你负责采购执行：务实精算，采购单必带依据。',
    replyStyle: '简洁直接',
  });

  let buyerUid = buyer.body.employeeUid;
  // 幂等：已存在则从列表取 uid
  if (!buyerUid) {
    const list = await (
      await fetch(`${AI_BASE}/api/ai/employees`, {
        headers: { Authorization: 'Bearer ' + token },
      })
    ).json();
    const found = (Array.isArray(list) ? list : []).find(
      (e) => e.name === '采专员',
    );
    buyerUid = found?.employeeUid;
  }
  console.log('采专员 uid:', buyerUid || '(已存在，取列表)');

  // 管理岗：库管家（可调度：[采专员]）
  const keeper = await create(token, {
    name: '库管家',
    post: '库存管家',
    department: '运营部',
    toolCategories: ['inventory', 'product'],
    personaPrompt: '你负责库存健康：先核实再建议，缺货必给补货方案。',
    dispatchUids: buyerUid ? [buyerUid] : [],
  });
  console.log(
    '库管家:',
    keeper.status === 201 || keeper.status === 200
      ? '已创建'
      : JSON.stringify(keeper.body).slice(0, 120),
  );

  const list = await (
    await fetch(`${AI_BASE}/api/ai/employees`, {
      headers: { Authorization: 'Bearer ' + token },
    })
  ).json();
  console.log(
    '当前员工:',
    (Array.isArray(list) ? list : [])
      .map((e) => `${e.name}(${e.post}${e.dispatchUids?.length ? ',可调度' : ''})`)
      .join(' / '),
  );
  process.exit(0);
})().catch((e) => {
  console.error('种子失败:', e.message);
  process.exit(1);
});
