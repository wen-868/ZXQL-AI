/**
 * standalone 单基线生成器（R101-AI-30 第 3 步 · 迁移乙案）
 *
 * 用途：由 23 个实体（**standalone 方言形态**：F1 char→varchar / F2 mediumtext→text /
 *       F3 bigint 主键→integer / F8 enum→varchar）经 TypeORM 的 schema builder 生成一次 DDL，
 *       固化为 `migrations-sqlite/000_baseline.sql`（**不逐个移植 MySQL 的 17 个迁移**）。
 *
 * ⚠️ 关键时序：方言在**模块加载期**（装饰器）求值 ⇒ `INTEGRATION_MODE=standalone`
 *    必须在 require 实体之前设好（本文件为此用 .cjs + 先设 env 再注册 ts-node）。
 *
 * 复跑：`node scripts/sqlite-baseline/generate-baseline.cjs`
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
process.env.INTEGRATION_MODE = 'standalone';

const fs = require('fs');
const path = require('path');

require('ts-node').register({
  transpileOnly: true,
  // 仓库 tsconfig 是 module=nodenext（与脚本的 CommonJS 注入冲突 TS5098）
  // ⇒ 本目录专用 tsconfig（commonjs + 装饰器元数据）
  project: path.join(__dirname, 'tsconfig.json'),
});

const { DataSource } = require('typeorm');
const { AI_ENTITIES } = require('../../src/database/database.module');

const OUT_DIR = path.resolve(__dirname, '../../migrations-sqlite');
const OUT_FILE = path.join(OUT_DIR, '000_baseline.sql');

const HEADER = `-- R101-AI-30 standalone 单基线（乙案）
--
-- 生成方式：node scripts/sqlite-baseline/generate-baseline.cjs
-- 方言：better-sqlite3（INTEGRATION_MODE=standalone）
-- 覆盖：AI_ENTITIES 全部实体（含 F1 char→varchar / F2 mediumtext→text /
--       F3 bigint 主键→integer / F8 enum→varchar 的最终形态）
--
-- ⚠️ 本文件是**桌面端首次建库**的唯一基线；后续结构变更请新增增量脚本
--    （migrations-sqlite/001_xxx.sql），**不要**重新生成 000 覆盖。
--
-- 注意：MySQL/云端形态**不使用**本文件（生产仍走 migrations/ 的 17 个迁移）。

`;

(async () => {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: ':memory:',
    entities: AI_ENTITIES,
    synchronize: false,
    enableWAL: true,
  });
  await ds.initialize();

  const inMemory = await ds.driver.createSchemaBuilder().log();
  // F9（本步实测发现）：**SQLite 的索引名是库级唯一**（MySQL 是表级）⇒ 多个实体各自的
  // `@Index('idx_tenant_created')` 会生成同名索引 ⇒ 第二条 `CREATE INDEX` 直接
  // `SqliteError: index idx_tenant_created already exists`。
  // 处置：**仅在 standalone 基线里**把索引名按表前缀化（`<table>__<index>`）；
  // 实体与生产 MySQL 零改动（MySQL 仍用原索引名）。
  const statements = inMemory.upQueries
    .map((q) => q.query.trim())
    .map((sql) => {
      const m = /^create index "([^"]+)" on "([^"]+)"/i.exec(sql);
      return m ? sql.replace(`"${m[1]}"`, `"${m[2]}__${m[1]}"`) : sql;
    });
  const ddl = statements.join(';\n\n') + ';\n';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, HEADER + ddl, 'utf8');

  const tableCount = statements.filter((s) =>
    /^create table/i.test(s),
  ).length;
  const indexCount = statements.filter((s) => /^create index/i.test(s)).length;
  console.log(
    `[baseline] 实体数=${AI_ENTITIES.length} 语句数=${statements.length} 表=${tableCount} 索引=${indexCount}`,
  );
  console.log(`[baseline] 写出：${OUT_FILE}`);
  await ds.destroy();
})().catch((err) => {
  console.error('[baseline] 生成失败：', err);
  process.exitCode = 1;
});
