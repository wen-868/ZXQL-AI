/**
 * standalone 基线应用器（R101-AI-30 第 3 步）
 *
 * 把 `migrations-sqlite/000_baseline.sql` 应用到 sqlite 库文件（缺省 `data/app.db`），
 * 并打印校验信息（表/索引数、WAL、关键列类型）——**桌面端首启建库**与人工验证共用。
 *
 * 用法：`node scripts/sqlite-baseline/apply-baseline.cjs [库文件路径]`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(
  process.argv[2] || path.join(__dirname, '../../data/app.db'),
);
const baseline = path.resolve(
  __dirname,
  '../../migrations-sqlite/000_baseline.sql',
);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const f = dbPath + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(fs.readFileSync(baseline, 'utf8'));

const tables = db
  .prepare(
    "select name from sqlite_master where type='table' and name like 't_%' order by name",
  )
  .all()
  .map((r) => r.name);
const indexCount = db
  .prepare("select count(1) as c from sqlite_master where type='index'")
  .get().c;

console.log(`[apply] 库文件：${dbPath}`);
console.log(`[apply] 表数=${tables.length} 索引数=${indexCount}`);
console.log(`[apply] 抽样表：${tables.slice(0, 5).join(', ')} …`);
console.log(`[apply] journal_mode=${db.pragma('journal_mode', { simple: true })}`);

const idemCols = db
  .prepare("select name, type from pragma_table_info('t_ai_idempotency')")
  .all()
  .filter((c) => ['id', 'idem_key', 'result_json', 'completed_at'].includes(c.name));
console.log(`[apply] t_ai_idempotency 关键列：${JSON.stringify(idemCols)}`);

const planCol = db
  .prepare("select name, type from pragma_table_info('t_ai_execution_plan')")
  .all()
  .filter((c) => c.name === 'state');
console.log(`[apply] t_ai_execution_plan.state：${JSON.stringify(planCol)}`);

db.close();
