/**
 * 最小复现：真 TypeORM + better-sqlite3 驱动下，闸门【认领 INSERT】撞唯一键的错误形态
 * （阿坚 ②场景定位用：区分 (a) isDuplicateKeyError 未命中 / (b) findRow 未命中）
 *
 * 运行：node scripts/sqlite-baseline/probe-claim-conflict.cjs
 * 红线：不改 src/；临时库隔离（STANDALONE_DB_PATH）；跑完清理
 */
process.env.INTEGRATION_MODE = 'standalone';
process.env.IDEMPOTENCY_ENABLED = 'true';

const path = require('path');
const fs = require('fs');
process.env.STANDALONE_DB_PATH = path.join(__dirname, '../../data/probe-claim.db');

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'tsconfig.json'),
});

const { DataSource } = require('typeorm');
const Database = require('better-sqlite3');
const { ConfigService } = require('@nestjs/config');
const { buildTypeOrmOptions, AI_ENTITIES } = require('../../src/database/database.module');
const { RedisProvider } = require('../../src/common/redis.provider');
const { IdempotencyGateService } = require('../../src/tools/idempotency-gate.service');
const { AiIdempotencyEntity } = require('../../src/database/entities/ai-idempotency.entity');

(async () => {
  const tmpDb = process.env.STANDALONE_DB_PATH;
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  const raw = new Database(tmpDb);
  raw.pragma('journal_mode = WAL');
  raw.exec(fs.readFileSync(path.join(__dirname, '../../migrations-sqlite/000_baseline.sql'), 'utf8'));
  raw.close();

  const fc = new ConfigService({ NODE_ENV: 'test' });
  const ds = new DataSource({ ...buildTypeOrmOptions(fc), entities: AI_ENTITIES, logging: ['error'] });
  await ds.initialize();
  const repo = ds.getRepository(AiIdempotencyEntity);
  const gate = new IdempotencyGateService(fc, new RedisProvider(fc), repo, ds);

  const ctx = { tenantId: 'probe-tenant', userId: 'u1' };
  const input = (k) => ({ toolName: 'createSalesOrder', args: { confirm: true }, context: ctx, explicitKey: k });

  // ── ① 直接看"闸门认领 INSERT 撞唯一键"的原始错误形态 ──
  console.log('\n【A】手动模拟闸门认领 INSERT 撞唯一键（打印原始错误形态）');
  // 关键：用【闸门 handle 返回的真实 idemKey】（含其哈希/盐算法），
  // 自己用明文 sha256 算出来的键与闸门内部不同 ⇒ 插的不是同一键，不会撞唯一索引。
  const firstA = await gate.check(input('probe-key-A'));
  const realKey = firstA.handle ? firstA.handle.idemKey : null;
  console.log('  闸门真实 idemKey =', realKey ? realKey.slice(0, 16) + '…' : 'null(handle)');
  try {
    await repo.insert({
      tenantId: ctx.tenantId, toolName: 'createSalesOrder',
      idemKey: realKey,
      keySource: 'explicit', status: 'in_flight', resultJson: null, errorText: null,
      firstSeenAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    console.log('  ⚠ 未抛错（异常：唯一键未生效？）');
  } catch (err) {
    console.log('  err.code           =', err.code);
    console.log('  err.errno          =', err.errno);
    console.log('  err.driverError?.code =', err.driverError && err.driverError.code);
    console.log('  err.message        =', String(err.message).slice(0, 120));
    // 用闸门内部判重逻辑检验（反射私有方法）
    const isDup = typeof gate['isDuplicateKeyError'] === 'function'
      ? gate['isDuplicateKeyError'](err) : 'N/A(私有方法不可直接调)';
    console.log('  gate.isDuplicateKeyError(err) =', isDup);
  }

  // ── ② 阿坚场景：清 Redis 认领键后第二次 check（真闸门路径）──
  console.log('\n【B】清 Redis 后第二次 check（闸门真实状态机）');
  const k2 = 'probe-key-B';
  const first = await gate.check(input(k2));
  await gate.complete(first.handle, { success: true, orderNo: 'SO-1' });
  // 清掉 Redis 中该键的所有痕迹（模拟 Redis 失效/键过期）
  const client = new RedisProvider(fc).getSharedClient('stop-after-3');
  const keyPrefix = `ai:idem:${ctx.tenantId}:createSalesOrder:`;
  const idemKeyHash = require('crypto').createHash('sha256').update(k2).digest('hex');
  await client.del(keyPrefix + idemKeyHash);
  console.log('  Redis 认领键已清:', keyPrefix + idemKeyHash);
  const second = await gate.check(input(k2));
  console.log('  second.decision        =', second.decision);
  console.log('  second.result?.idempotent_replay =', second.result && second.result.idempotent_replay);
  console.log('  second.handle          =', second.handle ? 'has-handle' : 'null');

  // ── ③ findRow 是否能查到（区分 b）──
  const row = await repo.findOne({ where: { tenantId: ctx.tenantId, toolName: 'createSalesOrder', idemKey: idemKeyHash } });
  console.log('\n【C】findRow 等价查询是否存在（区分 (b)）:');
  console.log('  row =', row ? { status: row.status, hasResult: !!row.resultJson } : 'null');

  await ds.destroy();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }
  console.log('\n═══ 探针结束（库已清理）═══');
  process.exit(0);
})().catch((e) => { console.error('探针异常:', e && e.message); process.exit(2); });
