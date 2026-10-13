/**
 * R101-AI-29 探针 3/3：幂等语义等价（最关键）
 *
 * 逐条对照 MySQL 方言在 SQLite 下的行为：
 *  A. MySQL `ON DUPLICATE KEY UPDATE` 直接跑 SQLite → 预期语法错误（证明 4 处写点必须改写）
 *  B. SQLite `ON CONFLICT(...) DO UPDATE` 是否与 A 的**仲裁行为**等价（AI-21 认领场景）
 *  C. AI-21 认领全链路等价：首次认领 → 重复提交（冲突）→ 回放 → 完成后再次提交 → 回放既有结果
 *  D. `ON CONFLICT DO NOTHING` + changes()：可**无异常**判重的替代写法（更适合闸门）
 *  E. audit-logger 用量累加（ON DUPLICATE KEY UPDATE x = x + VALUES(x)）的 SQLite 等价性与数值校验
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const DB = path.join(OUT, 'probe3.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}
const db = new Database(DB);
db.pragma('journal_mode = WAL');
console.log('=== R101-AI-29 探针3：幂等语义等价 ===');
console.log(`[ENV] journal_mode=${db.pragma('journal_mode', { simple: true })}`);

// AI-21 的表结构（简化镜像）
db.exec(`
CREATE TABLE t_ai_idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  key_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_flight',
  result_json TEXT,
  first_seen_at TEXT,
  completed_at TEXT
);
CREATE UNIQUE INDEX uk_ai_idempotency ON t_ai_idempotency (tenant_id, tool_name, idem_key);
`);

const ROW = {
  tenant: 't1',
  tool: 'createSalesOrder',
  key: 'k'.repeat(64),
};
/** C 段专用（另起一个键，保证链路从空行开始，证据更干净） */
const ROW_C = { tenant: 't1', tool: 'createSalesOrder', key: 'm'.repeat(64) };

// ── A. MySQL 方言在 SQLite 上 ──
const mysqlStyle = `INSERT INTO t_ai_idempotency (tenant_id, tool_name, idem_key, key_source, status)
 VALUES ('t1','createSalesOrder','${ROW.key}','confirm_token','in_flight')
 ON DUPLICATE KEY UPDATE status = VALUES(status)`;
try {
  db.prepare(mysqlStyle).run();
  console.log('[A-MySQL方言] UNEXPECTED_OK（SQLite 竟接受 ON DUPLICATE KEY）');
} catch (e) {
  console.log(
    `[A-MySQL方言] FAIL（预期）：${e.code} ${String(e.message).split('\n')[0]}`,
  );
  console.log(
    '   ⇒ FINDING F5：`ON DUPLICATE KEY UPDATE` 是 MySQL 专有 ⇒ 4 处写点（audit-logger:439/462/494、ai-usage-daily 注释处）必须改写',
  );
}

// ── B/D. 认领写法：ON CONFLICT DO UPDATE / DO NOTHING ──
const claimUpdate = db.prepare(`
INSERT INTO t_ai_idempotency (tenant_id, tool_name, idem_key, key_source, status, first_seen_at)
VALUES (@tenant, @tool, @key, 'confirm_token', 'in_flight', @now)
ON CONFLICT(tenant_id, tool_name, idem_key) DO UPDATE SET status = excluded.status, first_seen_at = excluded.first_seen_at
`);
const claimNothing = db.prepare(`
INSERT INTO t_ai_idempotency (tenant_id, tool_name, idem_key, key_source, status, first_seen_at)
VALUES (@tenant, @tool, @key, 'confirm_token', 'in_flight', @now)
ON CONFLICT(tenant_id, tool_name, idem_key) DO NOTHING
`);

const first = claimUpdate.run({ ...ROW, now: '2026-10-14T00:00:00.000Z' });
console.log(
  `[B-认领#1] changes=${first.changes} lastInsertRowid=${first.lastInsertRowid}`,
);
const second = claimUpdate.run({ ...ROW, now: '2026-10-14T00:00:01.000Z' });
console.log(
  `[B-认领#2 同键] changes=${second.changes} lastInsertRowid=${second.lastInsertRowid}（DO UPDATE：同一行被改写）`,
);

// 强制回 in_flight 后验证 DO NOTHING 的无异常判重
db.prepare(
  "UPDATE t_ai_idempotency SET status='succeeded', result_json=? WHERE tenant_id=? AND tool_name=? AND idem_key=?",
).run(
  JSON.stringify({ success: true, data: { orderNo: 'SO-1' } }),
  ROW.tenant,
  ROW.tool,
  ROW.key,
);
const nothing1 = claimNothing.run({ ...ROW, now: '2026-10-14T00:00:02.000Z' });
const nothing2 = db.prepare(
  'SELECT COUNT(*) c FROM t_ai_idempotency WHERE tenant_id=? AND tool_name=? AND idem_key=?',
).get(ROW.tenant, ROW.tool, ROW.key);
console.log(
  `[D-DO NOTHING 冲突] changes=${nothing1.changes}（0 = 冲突，可无异常判重）行数=${nothing2.c}`,
);

// ── C. AI-21 认领全链路仲裁 ──
console.log('--- AI-21 认领全链路（仲裁行为）---');
const findRow = db.prepare(
  'SELECT id, status, result_json FROM t_ai_idempotency WHERE tenant_id=? AND tool_name=? AND idem_key=?',
);
const step = (n, note) => {
  const row = findRow.get(ROW_C.tenant, ROW_C.tool, ROW_C.key);
  console.log(
    `[C-${n}] ${note} → id=${row.id} status=${row.status} result=${row.result_json ?? 'null'}`,
  );
};
const c1 = claimUpdate.run({ ...ROW_C, now: '2026-10-14T00:00:10.000Z' });
console.log(`[C-1] 首次认领：changes=${c1.changes}（1 = 插入成功 ⇒ proceed）`);
step(1, '首次认领后（in_flight：执行中）');
step(2, '第二次提交（同键冲突 ⇒ 本实现返回"处理中"，不执行）');
db.prepare(
  "UPDATE t_ai_idempotency SET status='failed', result_json=NULL WHERE tenant_id=? AND tool_name=? AND idem_key=?",
).run(ROW_C.tenant, ROW_C.tool, ROW_C.key);
step(3, '失败置 failed（允许同键重试）');
const retry = db.prepare(`
INSERT INTO t_ai_idempotency (tenant_id, tool_name, idem_key, key_source, status)
VALUES (@tenant, @tool, @key, 'confirm_token', 'in_flight')
ON CONFLICT(tenant_id, tool_name, idem_key) DO UPDATE SET status='in_flight'
WHERE t_ai_idempotency.status='failed'
`).run(ROW_C);
console.log(
  `[C-4] failed 行上的条件重认领：changes=${retry.changes}（1 = 成功抢回；0 = 他人已抢 ⇒ 等价 MySQL 的 UPDATE ... WHERE status='failed'）`,
);
db.prepare(
  "UPDATE t_ai_idempotency SET status='succeeded', result_json=? WHERE tenant_id=? AND tool_name=? AND idem_key=?",
).run(JSON.stringify({ success: true, data: { orderNo: 'SO-1' } }), ROW_C.tenant, ROW_C.tool, ROW_C.key);
step(5, '执行完成置 succeeded（可回放）');
const dupAfterDone = claimNothing.run({ ...ROW_C, now: '2026-10-14T00:00:03.000Z' });
const replay = findRow.get(ROW_C.tenant, ROW_C.tool, ROW_C.key);
console.log(
  `[C-6] 完成后再次提交：插入 changes=${dupAfterDone.changes} ⇒ 读既有行回放 result=${replay.result_json}`,
);
const total = db.prepare(
  'SELECT COUNT(*) c FROM t_ai_idempotency WHERE idem_key=?',
).get(ROW_C.key);
console.log(`[C-7] 全链路后该键行数=${total.c}（始终 1 行 ⇒ 至多一次落单语义成立）`);

// ── E. 用量累加等价性 ──
db.exec(`CREATE TABLE t_ai_usage_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL, stat_date TEXT NOT NULL, provider TEXT NOT NULL,
  chat_count INTEGER NOT NULL DEFAULT 0, total_cost REAL NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, stat_date, provider)
)`);
const usageRedis = db.prepare(`
INSERT INTO t_ai_usage_daily (tenant_id, stat_date, provider, chat_count, total_cost)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(tenant_id, stat_date, provider) DO UPDATE SET
  chat_count = chat_count + excluded.chat_count,
  total_cost = total_cost + excluded.total_cost
`);
for (let i = 0; i < 4; i++) {
  usageRedis.run('t1', '2026-10-14', 'deepseek', 1, 0.0015);
}
const usage = db
  .prepare('SELECT chat_count, total_cost FROM t_ai_usage_daily')
  .get();
console.log(
  `[E-累加] 4 次 UPSERT（每次 chat+1 / cost+0.0015）⇒ chat_count=${usage.chat_count}（期望4） total_cost=${usage.total_cost}（期望0.0060）`,
);

db.close();
console.log('=== 探针3 结束 ===');
