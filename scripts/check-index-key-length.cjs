/* eslint-disable */
/**
 * 索引键长度静态检查（防 ERROR 1071 Specified key was too long）
 *
 * 起因：MS 线 Auto Deploy 连续 9 次红于 migrations/022_ai_notice.sql ——
 *   KEY idx_ai_notice_receiver (tenant_id, receiver)，receiver VARCHAR(1000)
 *   ⇒ (36 + 1000) × 4(utf8mb4) = 4144 > 3072 ⇒ InnoDB 拒绝建索引。
 *
 * 本脚本用途：一次性排查 migrations/ 下【所有】CREATE TABLE 的 KEY / UNIQUE KEY，
 * 按 utf8mb4（4 字节/字符）估算索引键总字节，>3072 即报红（含 TEXT 列直接索引也报）。
 *
 * 只读静态分析，不连库、不改文件。
 *   node scripts/check-index-key-length.cjs
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'migrations');
const MAX_KEY_BYTES = 3072; // InnoDB（DYNAMIC/COMPACT + innodb_large_prefix）
const MB4 = 4; // utf8mb4：4 字节/字符

/** 列类型 → 索引占用的字节数（保守估算；返回 null 表示"不能整体索引"） */
function columnBytes(type) {
  const t = type.toUpperCase();
  let m;
  if ((m = t.match(/VARCHAR\s*\(\s*(\d+)\s*\)/))) return Number(m[1]) * MB4;
  if ((m = t.match(/CHAR\s*\(\s*(\d+)\s*\)/))) return Number(m[1]) * MB4;
  if (/TEXT/.test(t)) return null; // TEXT/BLOB 必须用前缀长度，整体索引不合法
  if (/BIGINT/.test(t)) return 8;
  if (/MEDIUMINT/.test(t)) return 6;
  if (/\bINT\b|INTEGER/.test(t)) return 4;
  if (/SMALLINT/.test(t)) return 2;
  if (/TINYINT/.test(t)) return 1;
  if (/DECIMAL|NUMERIC/.test(t)) return 16; // 粗略上界
  if (/DOUBLE|REAL|FLOAT8/.test(t)) return 8;
  if (/FLOAT/.test(t)) return 4;
  if (/DATETIME/.test(t)) return 8; // DATETIME(6) 上界
  if (/TIMESTAMP/.test(t)) return 7;
  if (/DATE/.test(t)) return 3;
  if (/TIME/.test(t)) return 6;
  if (/ENUM/.test(t)) return 2;
  if (/JSON/.test(t)) return null;
  if (/BLOB/.test(t)) return null;
  return 8; // 未知：保守上界
}

/** 索引列名（可能带前缀长度 col(191)） */
function parseIndexCols(inner) {
  return inner.split(',').map((s) => {
    const m = s.trim().match(/^`?(\w+)`?(?:\(\s*(\d+)\s*\))?/);
    if (!m) return null;
    return { name: m[1], prefix: m[2] ? Number(m[2]) : null };
  });
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const problems = [];
const checked = [];

for (const f of files) {
  const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
  // 去注释行（避免注释里的 KEY 误判）
  const sql = raw
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  // 抓 CREATE TABLE 块（到 ');' 或 ')' + ENGINE 结束）
  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?(\w+)`?\s*\(([\s\S]*?)\)\s*(?:ENGINE|;)/gi;
  let tm;
  while ((tm = tableRe.exec(sql))) {
    const table = tm[1];
    const body = tm[2];

    // 列定义
    const cols = {};
    for (const line of body.split('\n')) {
      const cm = line
        .trim()
        .match(/^`?(\w+)`?\s+([A-Za-z]+(?:\s*\([^)]*\))?)/);
      if (!cm) continue;
      const kw = cm[1].toUpperCase();
      if (
        ['PRIMARY', 'UNIQUE', 'KEY', 'INDEX', 'CONSTRAINT', 'FULLTEXT',
         'FOREIGN', 'CHECK'].includes(kw)
      ) {
        continue;
      }
      cols[cm[1]] = cm[2];
    }

    // 索引定义
    const idxRe =
      /((?:UNIQUE\s+|FULLTEXT\s+)?KEY|INDEX)\s+`?(\w+)`?\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gi;
    let im;
    while ((im = idxRe.exec(body))) {
      const kind = im[1].trim().toUpperCase();
      const idxName = im[2];
      const idxCols = parseIndexCols(im[3]).filter(Boolean);
      let total = 0;
      const parts = [];
      let hasText = false;
      for (const c of idxCols) {
        const type = cols[c.name];
        if (!type) {
          parts.push(`${c.name}=?`);
          total += 8;
          continue;
        }
        const b = columnBytes(type);
        if (b === null) {
          hasText = true;
          // 有前缀长度则按前缀算
          parts.push(
            `${c.name}(${c.prefix ?? 'FULL'}:${type.split('(')[0]})`,
          );
          total += c.prefix ? c.prefix * MB4 : 0;
          continue;
        }
        const use = c.prefix ? Math.min(c.prefix * MB4, b) : b;
        parts.push(`${c.name}:${use}B`);
        total += use;
      }
      checked.push({
        file: f,
        table,
        idxName,
        kind,
        detail: parts.join('+'),
        total,
        hasText,
      });
      if (total > MAX_KEY_BYTES) {
        problems.push({
          file: f,
          table,
          idxName,
          total,
          detail: parts.join('+'),
          reason: `索引键 ${total} 字节 > ${MAX_KEY_BYTES}（ERROR 1071）`,
        });
      } else if (hasText) {
        problems.push({
          file: f,
          table,
          idxName,
          total,
          detail: parts.join('+'),
          reason: '含 TEXT/JSON/BLOB 列直接索引（须前缀长度，InnoDB 不支持整列）',
        });
      }
    }
  }
}

console.log(`扫描 ${files.length} 个迁移文件，解析索引 ${checked.length} 个`);
console.log(`上限 ${MAX_KEY_BYTES} 字节（utf8mb4 按 4 字节/字符估算）\n`);

const worst = checked
  .slice()
  .sort((a, b) => b.total - a.total)
  .slice(0, 12);
console.log('── 索引键长度 TOP（字节） ──');
for (const c of worst) {
  console.log(
    `  ${String(c.total).padStart(5)}  ${c.file}  ${c.table}.${c.idxName}  [${c.detail}]`,
  );
}

console.log('\n── 结论 ──');
if (problems.length === 0) {
  console.log('  ✅ 未发现超 3072 字节的索引键');
} else {
  console.log(`  ❌ 发现 ${problems.length} 处问题：`);
  for (const p of problems) {
    console.log(
      `     ${p.file}  ${p.table}.${p.idxName} ⇒ ${p.reason} [${p.detail}]`,
    );
  }
}
process.exit(problems.length ? 1 : 0);
