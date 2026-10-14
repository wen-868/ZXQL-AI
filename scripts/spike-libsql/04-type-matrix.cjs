/**
 * R101-AI-29 补充探针 4：**逐类型支持矩阵**（better-sqlite3 驱动）
 *
 * 为什么需要：探针2 只测了 3 个实体的代表列；而全仓实体实际用到 12 种列类型
 * （varchar 105 / datetime 47 / bigint 25 / int 21 / text 19 / **tinyint 12** /
 *  decimal 11 / json 10 / char 3 / **mediumtext 1** / **enum 1** / date 1）。
 * 本探针逐个类型建表，给出 MySQL→SQLite 的**完整**兼容清单（避免改造后才发现遗漏）。
 */
const { DataSource, EntitySchema } = require('typeorm');

const CANDIDATES = [
  ['varchar', { type: 'varchar', length: 36 }],
  ['text', { type: 'text' }],
  ['mediumtext', { type: 'mediumtext' }],
  ['char', { type: 'char', length: 64 }],
  ['int', { type: 'int' }],
  ['tinyint', { type: 'tinyint', width: 1 }],
  ['bigint-nonpk', { type: 'bigint' }],
  ['decimal', { type: 'decimal', precision: 12, scale: 4 }],
  ['json', { type: 'json' }],
  ['date', { type: 'date' }],
  ['datetime', { type: 'datetime' }],
  ['datetime-precision3', { type: 'datetime', precision: 3 }],
  ['enum', { type: 'enum', enum: ['a', 'b'] }],
  ['boolean', { type: 'boolean' }],
];

(async () => {
  console.log('=== R101-AI-29 探针4：逐类型支持矩阵（better-sqlite3）===');
  const ok = [];
  const bad = [];
  for (const [label, colDef] of CANDIDATES) {
    const schema = new EntitySchema({
      name: 'Probe',
      tableName: 'probe_type',
      columns: { id: { type: 'integer', primary: true, generated: true }, v: colDef },
    });
    const ds = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [schema],
    });
    try {
      await ds.initialize();
      await ds.synchronize();
      const ddl = await ds.query(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='probe_type'",
      );
      const colType = /"v" ([^,\s]+(?:\(\d+(?:,\s*\d+)?\))?)/.exec(ddl[0].sql);
      console.log(`[OK  ] ${label.padEnd(20)} → SQLite 列: ${colType ? colType[1] : '?'}`);
      ok.push(label);
    } catch (e) {
      console.log(
        `[FAIL] ${label.padEnd(20)} → ${e.name}: ${String(e.message).split('\n')[0].slice(0, 110)}`,
      );
      bad.push(label);
    } finally {
      if (ds.isInitialized) await ds.destroy();
    }
  }
  console.log(`--- 支持 ${ok.length}/${CANDIDATES.length}：不支持 = ${bad.join(', ') || '无'}`);
  console.log('=== 探针4 结束 ===');
})().catch((e) => {
  console.error('探针4 异常：', e);
  process.exitCode = 1;
});
