/**
 * R101-AI-30 探针 5：Windows on ARM 的 x64 仿真 —— 能否加载 x64 native？
 *
 * 背景：凌舟问「x64 单包（Electron x64 + better-sqlite3 x64 native）能否覆盖 arm64 机器」。
 * 本机 = Windows 11 build 26300 ARM64。
 *
 * 实测结论（2026-10-14，本机）：
 *  1. x64 进程**可以**在 ARM64 上跑（x64 Node v24.18.0: process.arch=x64 / os.arch()=x64 / PROCESSOR_ARCHITECTURE=AMD64）
 *  2. 架构不匹配是**硬失败**且报错明确：把 ARM64 的 better_sqlite3.node 交给 x64 进程
 *     ⇒ ERR_DLOPEN_FAILED: `... is not a valid Win32 application`
 *  3. **未能完成直接证明**（x64 的 better-sqlite3 prebuild 在本环境拉不下来：GitHub releases ECONNRESET；
 *     本机也无现成 x64 .node；desktop/release/win-unpacked 内 0 个 .node）
 *     ⇒ 「x64 native 在 x64 仿真进程里可加载」需在能访问 GitHub releases 的机器上补跑：
 *        cd node_modules/better-sqlite3 && prebuild-install --arch=x64 --platform=win32 --runtime=node
 *        然后在本文件同等进程里 require 并核对 PE machine（0x8664）
 *
 * 运行方式（x64 Node 下运行）：
 *   node test-emu.cjs
 */
const fs = require('fs');
const path = require('path');

/** 读 PE machine（0x8664=x64 / 0xaa64=arm64） */
function peMachine(p) {
  const b = fs.readFileSync(p);
  const e = b.readUInt32LE(0x3c);
  return '0x' + b.readUInt16LE(e + 4).toString(16);
}

console.log(
  '[env] process.arch=' +
    process.arch +
    ' os.arch=' +
    require('os').arch() +
    ' PROCESSOR_ARCHITECTURE=' +
    process.env.PROCESSOR_ARCHITECTURE,
);

const binding = path.join(
  __dirname,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
if (fs.existsSync(binding)) {
  console.log('[pe] ' + binding + ' -> machine=' + peMachine(binding));
} else {
  console.log('[pe] 未找到本地绑定：' + binding);
}

try {
  const D = require('better-sqlite3');
  const db = new D(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT UNIQUE, n INTEGER)');
  const ins = db.prepare(
    'INSERT INTO t (k,n) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n',
  );
  ins.run('a', 1);
  ins.run('a', 5);
  console.log(
    '[sqlite] version=' +
      db.prepare('select sqlite_version() v').get().v +
      ' rows=' +
      JSON.stringify(db.prepare('select k,n from t').all()),
  );
  console.log('[verdict] 本进程成功加载并执行了该 native 模块');
  db.close();
} catch (e) {
  console.log('[verdict] native 加载失败：' + (e.code || '') + ' ' + String(e.message).split('\n')[0]);
}
