/**
 * R101-AI-29 探针 1/3：驱动可行性
 *
 * 回答：TypeORM 1.1.0 能否用 LibSQL 建 DataSource？
 *   A. type:'libsql'        → 预期：无该 driver（DatabaseType 无 libsql）
 *   B. require('libsql')    → 本机 win32/arm64 是否有原生绑定
 *   C. type:'better-sqlite3'→ TypeORM 官方 SQLite 驱动能否建连/读写
 *   D. options.driver 注入  → TypeORM 是否支持自带 driver 模块（LibSQL 适配的可行性口子）
 */
const fs = require('fs');
const path = require('path');
const { DataSource } = require('typeorm');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const dbFile = (name) => path.join(OUT, name);

function line(tag, msg) {
  console.log(`[${tag}] ${msg}`);
}

(async () => {
  console.log('=== R101-AI-29 探针1：驱动可行性 ===');
  line(
    'ENV',
    `node=${process.version} platform=${process.platform} arch=${process.arch}`,
  );
  line(
    'ENV',
    `typeorm=${JSON.parse(fs.readFileSync(path.join(__dirname, 'node_modules/typeorm/package.json'), 'utf8')).version}`,
  );

  // ── A. type:'libsql'（预期不被识别） ──
  try {
    const ds = new DataSource({ type: 'libsql', database: dbFile('a.db') });
    await ds.initialize();
    line('A-libsql-type', 'UNEXPECTED_OK（TypeORM 竟然接受了 libsql）');
    await ds.destroy();
  } catch (e) {
    line('A-libsql-type', `FAIL（预期）：${String(e.message).split('\n')[0]}`);
  }

  // ── B. libsql 原生绑定（本机架构） ──
  try {
    const Libsql = require('libsql');
    const db = new Libsql(':memory:');
    line('B-libsql-binding', `OK sqlite=${db.prepare('select sqlite_version() v').get().v}`);
    db.close();
  } catch (e) {
    line('B-libsql-binding', `FAIL：${String(e.message).split('\n')[0]}`);
  }

  // ── C. better-sqlite3（TypeORM 官方 SQLite 驱动） ──
  try {
    const BSQL = require('better-sqlite3');
    const mem = new BSQL(':memory:');
    line(
      'C-better-sqlite3-binding',
      `OK sqlite=${mem.prepare('select sqlite_version() v').get().v}`,
    );
    mem.close();

    const ds = new DataSource({
      type: 'better-sqlite3',
      database: dbFile('c.db'),
    });
    await ds.initialize();
    await ds.query('CREATE TABLE IF NOT EXISTS probe_c (id INTEGER PRIMARY KEY, v TEXT)');
    await ds.query('INSERT INTO probe_c (v) VALUES (?)', ['hello']);
    const rows = await ds.query('SELECT v FROM probe_c');
    line('C-typeorm-init', `OK 建连+建表+读写 rows=${JSON.stringify(rows)}`);
    await ds.destroy();
  } catch (e) {
    line('C-better-sqlite3', `FAIL：${String(e.message).split('\n')[0]}`);
  }

  // ── D. options.driver 注入（extensibility 口子） ──
  try {
    const BSQL = require('better-sqlite3');
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: dbFile('d.db'),
      driver: BSQL, // 注入自定义 driver 模块
    });
    await ds.initialize();
    await ds.query('CREATE TABLE IF NOT EXISTS probe_d (id INTEGER PRIMARY KEY)');
    line(
      'D-driver-injection',
      'OK：TypeORM 接受 options.driver 注入（= 可挂接兼容 SQLite API 的自带 driver，如未来的 libsql 适配）',
    );
    await ds.destroy();
  } catch (e) {
    line('D-driver-injection', `FAIL：${String(e.message).split('\n')[0]}`);
  }

  console.log('=== 探针1 结束 ===');
})().catch((e) => {
  console.error('探针1 异常：', e);
  process.exitCode = 1;
});
