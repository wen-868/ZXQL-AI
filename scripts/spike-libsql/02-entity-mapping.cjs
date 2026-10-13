/**
 * R101-AI-29 探针 2/3：Entity 映射（better-sqlite3 驱动）
 *
 * 用 EntitySchema 镜像我们 3 个代表性实体的列定义（同一批列名/类型/唯一键）：
 *  1. AiAuditLogEntity   —— JSON 列（categories）+ 长文本（args） + varchar
 *  2. AiUsageDailyEntity —— 复合唯一键 uk_tenant_date_provider + decimal 金额列 + date
 *  3. AiIdempotencyEntity—— 复合唯一键 uk_ai_idempotency + DATETIME(3) 毫秒 + char(64)
 *
 * 目的：暴露 MySQL→SQLite 的**类型映射差异**（哪些列会被改成什么、哪些需要人工改），
 * 不做业务代码改动。
 */
const fs = require('fs');
const path = require('path');
const { DataSource, EntitySchema } = require('typeorm');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const DB = path.join(OUT, 'probe2.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) {
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

/** 1. 审计日志（镜像 ai-audit-log.entity.ts 的代表列） */
const AuditLog = new EntitySchema({
  name: 'AiAuditLog',
  tableName: 't_ai_audit_log',
  columns: {
    id: { type: 'integer', primary: true, generated: true }, // SQLite: INTEGER PRIMARY KEY AUTOINCREMENT（原 bigint 不支持）
    tenantId: { name: 'tenant_id', type: 'varchar', length: 36 },
    userId: { name: 'user_id', type: 'varchar', length: 36, nullable: true },
    provider: { name: 'provider', type: 'varchar', length: 32, nullable: true },
    categories: { name: 'categories', type: 'json', nullable: true },
    toolCalls: { name: 'tool_calls', type: 'text', nullable: true },
    success: { name: 'success', type: 'boolean', default: true },
    createdAt: { name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' },
  },
  indices: [
    { name: 'idx_tenant_id', columns: ['tenantId'] },
    { name: 'idx_created_at', columns: ['createdAt'] },
  ],
});

/** 2. 用量日汇总（镜像 ai-usage-daily.entity.ts 的代表列 + 唯一键） */
const UsageDaily = new EntitySchema({
  name: 'AiUsageDaily',
  tableName: 't_ai_usage_daily',
  columns: {
    id: { type: 'integer', primary: true, generated: true }, // SQLite: INTEGER PRIMARY KEY AUTOINCREMENT（原 bigint 不支持）
    tenantId: { name: 'tenant_id', type: 'varchar', length: 36 },
    statDate: { name: 'stat_date', type: 'date' },
    provider: { name: 'provider', type: 'varchar', length: 32 },
    chatCount: { name: 'chat_count', type: 'int', default: 0 },
    totalTokens: { name: 'total_tokens', type: 'bigint', default: 0 },
    totalCost: { name: 'total_cost', type: 'decimal', precision: 12, scale: 4, default: 0 },
  },
  indices: [
    {
      name: 'uk_tenant_date_provider',
      columns: ['tenantId', 'statDate', 'provider'],
      unique: true,
    },
  ],
});

/** 3. 幂等键（镜像 ai-idempotency.entity.ts 的代表列 + DATETIME(3)） */
function makeIdempotency(idemKeyType) {
  return new EntitySchema({
    name: 'AiIdempotency',
    tableName: 't_ai_idempotency',
    columns: {
      id: { type: 'integer', primary: true, generated: true }, // SQLite: INTEGER PRIMARY KEY AUTOINCREMENT（原 bigint 不支持）
      tenantId: { name: 'tenant_id', type: 'varchar', length: 36 },
      toolName: { name: 'tool_name', type: 'varchar', length: 64 },
      idemKey: { name: 'idem_key', type: idemKeyType, length: 64 },
      keySource: { name: 'key_source', type: 'varchar', length: 16 },
      status: { name: 'status', type: 'varchar', length: 16, default: 'in_flight' },
      resultJson: { name: 'result_json', type: idemKeyType === 'char' ? 'mediumtext' : 'text', nullable: true },
      completedAt: {
        name: 'completed_at',
        type: 'datetime',
        precision: 3,
        nullable: true,
      },
      createdAt: { name: 'created_at', type: 'datetime' },
    },
    indices: [
      {
        name: 'uk_ai_idempotency',
        columns: ['tenantId', 'toolName', 'idemKey'],
        unique: true,
      },
    ],
  });
}
const IdempotencyOriginal = makeIdempotency('char');
const Idempotency = makeIdempotency('varchar');

/** 建连（失败即打印原因，用于收集"不支持的类型"） */
async function tryInit(entities, label) {
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: label === 'original' ? ':memory:' : DB,
    entities,
  });
  try {
    await ds.initialize();
    return { ds, error: null };
  } catch (e) {
    return { ds: null, error: e };
  }
}

(async () => {
  console.log('=== R101-AI-29 探针2：Entity 映射 ===');

  // ── 2.0 原样（MySQL 口径）建 metadata：收集不支持的类型 ──
  const original = await tryInit(
    [AuditLog, UsageDaily, IdempotencyOriginal],
    'original',
  );
  if (original.error) {
    console.log(
      `[2.0] 原样（MySQL 口径）初始化 FAIL：${original.error.name}: ${String(original.error.message).split('\n')[0]}`,
    );
    console.log(
      '      ⇒ FINDING F1：该列类型在 SQLite 驱动下不受支持，须按方言改列类型（记入改造量）',
    );
  } else {
    console.log('[2.0] 原样（MySQL 口径）初始化 OK');
    await original.ds.destroy();
  }

  const ds = new DataSource({
    type: 'better-sqlite3',
    database: DB,
    entities: [AuditLog, UsageDaily, Idempotency],
  });
  try {
    await ds.initialize();
    console.log('[2.1] DataSource 初始化 OK（better-sqlite3 + 文件库）');

    try {
      await ds.synchronize();
      console.log('[2.2] synchronize() 建表 OK（含 json/mediumtext/datetime(3)/unique）');
    } catch (e) {
      console.log(`[2.2] synchronize() FAIL：${String(e.message).split('\n').slice(0, 4).join(' | ')}`);
      console.log('      ⇒ 该类型组合在 SQLite 下不被支持，需人工改列类型（记入改造量）');
      await ds.destroy();
      return;
    }

    const ddl = await ds.query(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 't_%' ORDER BY name",
    );
    for (const row of ddl) {
      console.log(`[2.3] DDL ${row.name}: ${String(row.sql).replace(/\s+/g, ' ')}`);
    }
    const idx = await ds.query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name",
    );
    for (const row of idx) {
      console.log(`[2.3] IDX ${row.name}: ${String(row.sql).replace(/\s+/g, ' ')}`);
    }

    // JSON 列往返
    const auditRepo = ds.getRepository('AiAuditLog');
    await auditRepo.insert({
      tenantId: 't1',
      userId: 'u1',
      provider: 'deepseek',
      categories: ['inventory', 'order'],
      toolCalls: JSON.stringify([{ tool: 'searchProduct' }]),
    });
    const audit = await auditRepo.find();
    console.log(
      `[2.4] JSON 列往返：categories=${JSON.stringify(audit[0].categories)} 类型=${typeof audit[0].categories}`,
    );

    // DATETIME(3) 毫秒精度
    const idemRepo = ds.getRepository('AiIdempotency');
    const ms = new Date('2026-10-14T00:12:34.567Z');
    await idemRepo.insert({
      tenantId: 't1',
      toolName: 'createSalesOrder',
      idemKey: 'a'.repeat(64),
      keySource: 'confirm_token',
      status: 'in_flight',
      completedAt: ms,
      createdAt: new Date(),
    });
    const raw = await ds.query(
      "SELECT completed_at AS c FROM t_ai_idempotency LIMIT 1",
    );
    console.log(
      `[2.5] DATETIME(3) 毫秒：写入=${ms.toISOString()} 读回=${JSON.stringify(raw[0].c)}`,
    );

    // 唯一键冲突的真实错误形态（关键：我们的 isDuplicateKeyError 认的是 MySQL 1062）
    try {
      await idemRepo.insert({
        tenantId: 't1',
        toolName: 'createSalesOrder',
        idemKey: 'a'.repeat(64),
        keySource: 'confirm_token',
        status: 'in_flight',
        createdAt: new Date(),
      });
      console.log('[2.6] UNEXPECTED：重复唯一键竟插入成功');
    } catch (e) {
      const drv = e.driverError ?? {};
      console.log(
        `[2.6] 唯一键冲突错误形态：name=${e.name} code=${e.code} errno=${e.errno} driverCode=${drv.code} driverErrno=${drv.errno}`,
      );
      console.log(`      message=${String(e.message).split('\n')[0]}`);
      console.log(
        '      ⇒ 对照 MySQL：code=ER_DUP_ENTRY errno=1062 ⇒ 判重逻辑需按方言扩展（改造量）',
      );
    }

    // decimal 列读回类型（MySQL 走 mysql2 会返回字符串）
    const usageRepo = ds.getRepository('AiUsageDaily');
    await usageRepo.insert({
      tenantId: 't1',
      statDate: '2026-10-14',
      provider: 'deepseek',
      totalCost: 0.0019,
    });
    const usage = await usageRepo.find();
    console.log(
      `[2.7] decimal(12,4) 读回：value=${JSON.stringify(usage[0].totalCost)} 类型=${typeof usage[0].totalCost}`,
    );
  } finally {
    if (ds.isInitialized) await ds.destroy();
  }
  console.log('=== 探针2 结束 ===');
})().catch((e) => {
  console.error('探针2 异常：', e);
  process.exitCode = 1;
});
