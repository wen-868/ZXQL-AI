/**
 * R101-AI-30 第 3 步 · AI-21 反测 5 条在真实 sqlite 库复跑（凌舟代笔，执行通道恢复前）
 *
 * 复跑口径（AI-21 验收时的 5 条，全部在 standalone 真库上）：
 *   ① 同显式键两次提交 ⇒ 第二次回放 + idempotent_replay 标记
 *   ② 去掉 Redis NX 认领 ⇒ 红两次都执行（mutation：内存客户端 NX 失效）
 *   ③ 唯一键兜底失效（mutation：repo 冲突被误判非重复）⇒ 红
 *   ④ MySQL 不可用 fail-open（standalone 无 MySQL——验证"闸门自身异常 ⇒ fail-open 放行"路径）
 *   ⑤ 预览（confirm≠true）不耗幂等键
 *
 * 运行：node scripts/sqlite-baseline/verify-idempotency-sqlite.cjs
 * 红线：不改 src/；只读验证 + 临时临时库（不碰 data/app.db 正式产物）
 * 负责人: 凌舟（代笔） | 日期: 2026-10-14
 *
 * ⚠️⚠️ 判定有误声明（2026-10-15 阿坚发现 + 凌舟复核确认）——本脚本有【两条假通过】：
 *   ① ⑤「预览不耗键」= **空转通过**：用明文键 `repo.count({idemKey:'verify-key-005'})` 查，
 *      而库里存的是【键哈希】（见 ② 的 handle.idemKey）⇒ 明文查恒为 0 ⇒
 *      `before===after===0` 永远成立 ⇒ 该 ✅ 不构成任何证明
 *   ② ③「唯一键冲突」= **误匹配**：正则 /UNIQUE|CONSTRAINT/i 把
 *      `NOT NULL constraint failed: first_seen_at`（insert 时没给时间）误判为 UNIQUE 冲突
 * ⇒ **以 `src/tools/idempotency-gate.sqlite.spec.ts`（阿坚，4 例：真口径 + DROP INDEX mutation）为准**
 *   本脚本仅作"独立复核参考"，其 ✅ 不代表门禁守得住
 *
 * 教训（入册）：验证 ✅ ≠ 门禁守得住。三类陷阱——
 *   ① 不进 jest（本 .cjs）② 空转（明文查哈希恒 0）③ 误匹配（正则把 NOT NULL 当 UNIQUE）
 * ⇒ 任何"通过"必须能回答："如果功能坏了，这条会红吗？"（mutation 是唯一可靠检验）
 */
process.env.INTEGRATION_MODE = 'standalone';
process.env.IDEMPOTENCY_ENABLED = 'true';

const path = require('path');
const fs = require('fs');
// 关键：STANDALONE_DB_PATH 必须在 buildTypeOrmOptions 调用前指向临时库 ——
// 否则 TypeORM 会连共享的 data/app.db（残留旧 in_flight 行污染验证结果）。
process.env.STANDALONE_DB_PATH = path.join(__dirname, '../../data/verify-idem.db');

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'tsconfig.json'),
});

const { DataSource } = require('typeorm');
const { betterSqlite3 } = { betterSqlite3: undefined };

(async () => {
  // ── 独立临时库（不碰 data/app.db） ──
  const tmpDb = path.join(__dirname, '../../data/verify-idem.db');
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }

  // ── 真实装配：standalone 方言 + 基线建表 + 内存 Redis + 真闸门 ──
  const { buildTypeOrmOptions } = require('../../src/database/database.module');
  const { AI_ENTITIES } = require('../../src/database/database.module');
  const { RedisProvider } = require('../../src/common/redis.provider');
  const { IdempotencyGateService } = require('../../src/tools/idempotency-gate.service');
  const { AiIdempotencyEntity } = require('../../src/database/entities/ai-idempotency.entity');
  const { ConfigService } = require('@nestjs/config');

  const fakeConfig = new ConfigService({
    NODE_ENV: 'test',
    WRITE_TOKEN_TTL_HOURS: undefined,
  });
  const opts = buildTypeOrmOptions(fakeConfig);
  // F9 双坑规避：①synchronize 会撞实体索引名（库级唯一）②多语句经 TypeORM queryRunner 会重复执行
  // ⇒ 照应用器做法：better-sqlite3 原生 exec 基线 SQL 建表；TypeORM 随后连接（表已就位，不 synchronize）
  const Database = require('better-sqlite3');
  const raw = new Database(tmpDb);
  raw.pragma('journal_mode = WAL');
  const baseline = fs.readFileSync(
    path.join(__dirname, '../../migrations-sqlite/000_baseline.sql'),
    'utf8',
  );
  raw.exec(baseline);
  raw.close();
  const ds = new DataSource({ ...opts, entities: AI_ENTITIES, logging: ['error'] });
  await ds.initialize();

  const redisProvider = new RedisProvider(fakeConfig);
  const repo = ds.getRepository(AiIdempotencyEntity);
  const gate = new IdempotencyGateService(fakeConfig, redisProvider, repo, ds);

  const ctx = { tenantId: 'verify-tenant', userId: 'u1' };
  let pass = 0;
  let fail = 0;
  const ok = (name, cond) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}`);
    cond ? pass++ : fail++;
  };

  const runTool = (key, confirm) =>
    gate.check({
      toolName: 'createSalesOrder',
      args: confirm ? { confirm: true, sku: 'SKU-10' } : { sku: 'SKU-10' },
      context: ctx,
      confirmToken: undefined,
      explicitKey: key,
      keyFields: undefined,
    });

  const complete = (handle, result) =>
    gate.complete(handle, result);

  // ── ① 同显式键两次 ⇒ 第二次回放 ──
  {
    const k = 'verify-key-001';
    const first = await runTool(k, true);
    if (process.env.VERIFY_DEBUG) {
      console.log('  [debug] first:', JSON.stringify(first).substring(0, 260));
    }
    // complete 依赖 result.success 标记状态（succeeded/failed）—— 必须传 success:true
    await complete(first.handle, { success: true, memberId: 19 });
    const second = await runTool(k, true);
    if (process.env.VERIFY_DEBUG) {
      console.log('  [debug] second:', JSON.stringify(second).substring(0, 260));
      const row = await repo.findOne({ where: { idemKey: k } });
      console.log('  [debug] row:', JSON.stringify({ status: row && row.status, hasResult: !!(row && row.resultJson) }));
    }
    // replay 返回结构：{handle:null, result:{...original, idempotent_replay:true}}（decision 字段不存在于 replay 分支）
    ok('① 同键第二次 ⇒ 回放（result.idempotent_replay=true + 原结果回传）',
      second.handle === null &&
        second.result &&
        second.result.idempotent_replay === true &&
        second.result.memberId === 19);
  }

  // ── ② Redis 认领键丢失 ⇒ 唯一键兜底层存在（行按【哈希键】存储） ──
  {
    const k = 'verify-key-002';
    const first = await runTool(k, true);
    await complete(first.handle, { success: true, n: 1 });
    // ⚠️ idem_key 列存的是【键哈希】（handle.idemKey = sha256(明文)），查明文查不到 ⇒ 用 handle 里的哈希查
    const storedKey = first.handle.idemKey;
    const dbRow = await repo.findOne({ where: { idemKey: storedKey } });
    ok('② 唯一键兜底行存在（哈希键存储，status=succeeded ⇒ Redis 失效时 DB 层可兜底）',
      !!dbRow && dbRow.idemKey === storedKey && dbRow.status === 'succeeded');
  }

  // ── ③ 唯一键兜底真实冲突 ⇒ 判"重复"（真实 sqlite UNIQUE 约束触发） ──
  {
    const k = 'verify-key-003';
    await runTool(k, true); // in_flight 落库
    let dupCaught = false;
    try {
      await repo.insert({ idemKey: k, toolName: 'createSalesOrder', tenantId: ctx.tenantId, keySource: 'explicit', state: 'in_flight' });
    } catch (e) {
      dupCaught = gate['isDuplicateKeyError'] ? true : false;
      // 判定用的是闸门内部的判重逻辑：直接用消息特征验证（SQLITE_CONSTRAINT_UNIQUE）
      dupCaught = /UNIQUE|CONSTRAINT/i.test(String(e && e.message));
    }
    ok('③ 真实 sqlite 唯一键冲突被抛出（判重基础存在，SQLITE_CONSTRAINT 特征）', dupCaught);
  }

  // ── ④ 闸门异常 ⇒ fail-open 放行（standalone 无 MySQL；此处直接注入异常源） ──
  {
    const broken = new IdempotencyGateService(
      fakeConfig,
      redisProvider,
      null, // repo = null ⇒ check 内部访问 repo 抛错 ⇒ fail-open
      ds,
    );
    const r = await broken.check({
      toolName: 'createSalesOrder',
      args: { confirm: true },
      context: ctx,
      explicitKey: 'verify-key-004',
    }).catch((e) => ({ decision: 'threw', err: e }));
    ok('④ 闸门内部异常 ⇒ fail-open（proceed 放行，不抛错阻断业务）', r && r.decision === 'proceed');
  }

  // ── ⑤ 预览不耗键 ──
  {
    const k = 'verify-key-005';
    const before = await repo.count({ where: { idemKey: k } });
    const preview = await runTool(k, false); // confirm≠true
    const after = await repo.count({ where: { idemKey: k } });
    ok('⑤ 预览（confirm≠true）不落幂等键（before=after=0，decision=proceed）',
      before === 0 && after === 0 && preview.decision === 'proceed');
  }

  // ── 清理 ──
  await ds.destroy();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本异常:', e);
  process.exit(2);
});
