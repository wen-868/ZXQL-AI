/**
 * standalone 建库/升级应用器（R101-AI-30 第 3 步 · R101-AI-35 S1 升级）
 *
 * 流程（R101-AI-30 乙案：基线 + 增量，均由 applier 落地）：
 *   1. 删除旧库文件（全新库）
 *   2. 应用 `migrations-sqlite/000_baseline.sql`（首次建库基线）
 *   3. 按序应用 `migrations-sqlite/NNN_*.sql` **增量**（纯 DDL，可重复）
 *   4. **条件加列**（sqlite 无 ADD COLUMN IF NOT EXISTS）：对 `t_ai_knowledge_chunks`
 *      用 `PRAGMA table_info` 判定 `doc_id` 是否存在，缺则 `ALTER TABLE ... ADD COLUMN`
 *      —— 幂等，可重复跑
 *   5. 校验并打印：表/索引数、WAL、关键列、**暗坑闭环断言**
 *      （chunks 表可写：插一行再删）
 *
 * 用法：`node scripts/sqlite-baseline/apply-baseline.cjs [库文件路径]`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14（S1 升级 2026-10-15）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.resolve(
  process.argv[2] || path.join(__dirname, '../../data/app.db'),
);
const sqliteDir = path.resolve(__dirname, '../../migrations-sqlite');
const baseline = path.join(sqliteDir, '000_baseline.sql');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) {
  const f = dbPath + suffix;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ── 1. 基线 ──
db.exec(fs.readFileSync(baseline, 'utf8'));
console.log(`[apply] 基线已应用：${path.basename(baseline)}`);

// ── 2. 增量（按文件名排序；纯 DDL，可重复） ──
const increments = fs
  .readdirSync(sqliteDir)
  .filter((f) => /^\d{3}_.+\.sql$/.test(f) && !f.startsWith('000_'))
  .sort();
for (const file of increments) {
  db.exec(fs.readFileSync(path.join(sqliteDir, file), 'utf8'));
  console.log(`[apply] 增量已应用：${file}`);
}

// ── 3. 条件加列（幂等：缺列才加） ──
function ensureColumn(table, column, ddl) {
  const cols = db
    .prepare(`select name from pragma_table_info('${table}')`)
    .all()
    .map((r) => r.name);
  if (cols.includes(column)) {
    console.log(`[apply] ${table}.${column} 已存在（跳过加列）`);
    return false;
  }
  db.exec(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`[apply] ${table}.${column} 已加列`);
  return true;
}

ensureColumn(
  't_ai_knowledge_chunks',
  'doc_id',
  '"doc_id" bigint',
);
// R101-AI-35 tags 补齐：既有库补 t_ai_doc.tags（001 的 CREATE TABLE IF NOT EXISTS 对已存在表整条跳过）
ensureColumn('t_ai_doc', 'tags', '"tags" text');
// R101-AI-35 S3：既有库补 rag_status
ensureColumn(
  't_ai_doc',
  'rag_status',
  `"rag_status" varchar(16) NOT NULL DEFAULT ('pending')`,
);
// R101-AI-41 S2：既有库补 t_ai_approval.deleted_at（审批草稿软弃；仅草稿可弃）
ensureColumn('t_ai_approval', 'deleted_at', '"deleted_at" datetime(3)');
db.exec(
  'CREATE INDEX IF NOT EXISTS "t_ai_knowledge_chunks__idx_kc_tenant_doc" ON "t_ai_knowledge_chunks" ("tenant_id", "doc_id")',
);

// ── 3b. ACL 通用化（R101-AI-37 步骤 1）：t_ai_doc_acl → t_ai_acl，doc_id → resource_id，+
//        resource_type。改名类语句无法用纯 SQL 幂等表达（sqlite 无 RENAME IF EXISTS /
//        ADD COLUMN IF NOT EXISTS）⇒ 一律在这里条件执行。
//        依据：t_ai_doc_acl 由 001 新建且**尚无数据** ⇒ 改名零迁移风险（凌舟裁定方案①）。
function tableExists(name) {
  return (
    db
      .prepare("select count(1) as c from sqlite_master where type='table' and name = ?")
      .get(name).c === 1
  );
}

if (tableExists('t_ai_doc_acl') && !tableExists('t_ai_acl')) {
  db.exec('ALTER TABLE "t_ai_doc_acl" RENAME TO "t_ai_acl"');
  console.log('[apply] ACL 通用化：t_ai_doc_acl → t_ai_acl');
}
if (tableExists('t_ai_acl')) {
  const aclCols = db
    .prepare("select name from pragma_table_info('t_ai_acl')")
    .all()
    .map((r) => r.name);
  if (aclCols.includes('doc_id') && !aclCols.includes('resource_id')) {
    db.exec('ALTER TABLE "t_ai_acl" RENAME COLUMN "doc_id" TO "resource_id"');
    console.log('[apply] ACL 通用化：doc_id → resource_id');
  }
  ensureColumn(
    't_ai_acl',
    'resource_type',
    `"resource_type" varchar(16) NOT NULL DEFAULT ('doc')`,
  );
  // 旧 doc 维度唯一键在新语义下过窄（会把 todo#5 与 doc#5 误判冲突）⇒ 必须换掉
  db.exec('DROP INDEX IF EXISTS "uk_ai_doc_acl_principal"');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS "t_ai_acl__uk_ai_acl_principal" ON "t_ai_acl" ("resource_type", "resource_id", "principal_type", "principal_id")',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS "t_ai_acl__idx_ai_acl_resource" ON "t_ai_acl" ("tenant_id", "resource_type", "resource_id")',
  );
}

// ── 4. 校验 ──
const tables = db
  .prepare(
    "select name from sqlite_master where type='table' order by name",
  )
  .all()
  .map((r) => r.name);
const tTables = tables.filter((n) => n.startsWith('t_'));
const indexCount = db
  .prepare("select count(1) as c from sqlite_master where type='index'")
  .get().c;

console.log(`[apply] 库文件：${dbPath}`);
console.log(`[apply] 表数=${tables.length}（t_* 前缀 ${tTables.length}）索引数=${indexCount}`);
console.log(`[apply] journal_mode=${db.pragma('journal_mode', { simple: true })}`);

const acl = db
  .prepare(
    // R101-AI-37 步骤 1：ACL 通用化后唯一键名为 t_ai_acl__uk_ai_acl_principal
    //（旧 uk_ai_doc_acl_principal 已 DROP：doc 维度唯一键过窄，会把 todo#5 与 doc#5 误判冲突）
    "select name from sqlite_master where type='index' and name='t_ai_acl__uk_ai_acl_principal'",
  )
  .all();
console.log(`[apply] ACL 通用唯一键存在=${acl.length === 1}`);

const chunksCols = db
  .prepare("select name, type from pragma_table_info('t_ai_knowledge_chunks')")
  .all();
const hasDocId = chunksCols.some((c) => c.name === 'doc_id');
console.log(
  `[apply] chunks 列=${JSON.stringify(chunksCols.map((c) => c.name))} doc_id=${hasDocId}`,
);

// 暗坑闭环：chunks 表**可写**（插一行再删）
try {
  db.prepare(
    'INSERT INTO "t_ai_knowledge_chunks" (tenant_id, doc_name, chunk_index, chunk_text, embedding, doc_id) VALUES (?,?,?,?,?,?)',
  ).run('t-probe', 'probe.txt', 0, 'hello', JSON.stringify([0.1, 0.2]), null);
  const n = db
    .prepare('select count(1) as c from "t_ai_knowledge_chunks"')
    .get().c;
  db.prepare('DELETE FROM "t_ai_knowledge_chunks" WHERE tenant_id = ?').run(
    't-probe',
  );
  const after = db
    .prepare('select count(1) as c from "t_ai_knowledge_chunks"')
    .get().c;
  console.log(
    `[apply] chunks 可写=OK（插入后 ${n} 行，清理后 ${after} 行，含 embedding JSON 文本）`,
  );
} catch (err) {
  console.log(`[apply] chunks 可写=FAIL：${err.message}`);
  process.exitCode = 1;
}

db.close();
