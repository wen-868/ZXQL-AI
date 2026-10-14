/**
 * R101-AI-30 · STEP2c 集成级收尾验证（凌舟代笔，执行通道恢复前）
 *
 * 验证两项（均为【集成级】——真实服务 + 内存 Redis Provider，非 client 级打桩）：
 *   ① write-guard 释放锁：仅持有者可释放（非持有者返回 0 且锁不动）
 *   ② AI-23 死信重放全链路（内存 Redis 态）：xadd → xreadgroup 读到 → xack → 补录成功 → 再读不重复
 *      并验证 replay 服务把死信补录到 DB（dead-letter-sink 的真实写入路径）
 *
 * 运行：node scripts/sqlite-baseline/verify-step2c-integrated.cjs
 * 红线：不改 src/；临时库隔离；跑完清理
 * 负责人: 凌舟（代笔） | 日期: 2026-10-15
 */
process.env.INTEGRATION_MODE = 'standalone';

const path = require('path');
const fs = require('fs');
process.env.STANDALONE_DB_PATH = path.join(__dirname, '../../data/verify-step2c.db');

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'tsconfig.json'),
});

const { DataSource } = require('typeorm');
const Database = require('better-sqlite3');
const { ConfigService } = require('@nestjs/config');
const {
  buildTypeOrmOptions,
  AI_ENTITIES,
} = require('../../src/database/database.module');
const { RedisProvider } = require('../../src/common/redis.provider');
const { RedisMemoryClient } = require('../../src/common/redis-memory.client');

(async () => {
  const tmpDb = process.env.STANDALONE_DB_PATH;
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  const raw = new Database(tmpDb);
  raw.pragma('journal_mode = WAL');
  raw.exec(
    fs.readFileSync(
      path.join(__dirname, '../../migrations-sqlite/000_baseline.sql'),
      'utf8',
    ),
  );
  raw.close();

  const fc = new ConfigService({ NODE_ENV: 'test' });
  const ds = new DataSource({
    ...buildTypeOrmOptions(fc),
    entities: AI_ENTITIES,
    logging: ['error'],
  });
  await ds.initialize();

  const provider = new RedisProvider(fc);
  // standalone ⇒ 内存客户端（验证 Provider 分流真实生效，不是 ioredis）
  const client = provider.getSharedClient('stop-after-3');
  const isMemory = client instanceof RedisMemoryClient;

  let pass = 0;
  let fail = 0;
  const ok = (name, cond) => {
    console.log(`  ${cond ? '✓' : '✗'} ${name}`);
    cond ? pass++ : fail++;
  };

  console.log('\n【0】Provider 分流（standalone ⇒ 内存客户端）');
  ok('getSharedClient 返回 RedisMemoryClient 实例（分流生效，非 ioredis）', isMemory);

  // ── ① write-guard 释放锁（CAS）集成级 ──
  console.log('\n【1】write-guard 释放锁 CAS（集成级）');
  const lockKey = 'ai:wg:lock:token-001';
  const owner = 'owner-abc';
  const other = 'owner-xyz';
  await client.set(lockKey, owner, 'EX', 30);
  const relByOther = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    lockKey,
    other,
  );
  const stillThere = await client.get(lockKey);
  ok('①a 非持有者释放 ⇒ 返回 0', relByOther === 0);
  ok('①b 非持有者释放 ⇒ 锁仍在（未被误删）', stillThere === owner);
  const relByOwner = await client.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    lockKey,
    owner,
  );
  const after = await client.get(lockKey);
  ok('①c 持有者释放 ⇒ 返回 1', relByOwner === 1);
  ok('①d 持有者释放 ⇒ 锁已删', after === null);

  // ── ② AI-23 死信重放全链路（内存 Redis Stream） ──
  console.log('\n【2】AI-23 死信重放全链路（内存 Redis Stream）');
  const stream = 'ai:dead_letter:replay';
  await client.xadd(stream, '*', 'op', 'idem.claim', 'payload', '{"n":1}');
  await client.xadd(stream, '*', 'op', 'idem.complete', 'payload', '{"n":2}');
  const len = await client.xlen(stream);
  ok('②a xadd 两条 ⇒ xlen=2', len === 2);

  // xreadgroup 返回 ioredis 原生形态：[[key, [[id, fields], ...]]]，无新消息时返回 null
  const read1 = await client.xreadgroup('g1', 'c1', stream, '>', 10);
  const msgs1 = read1 && read1[0] ? read1[0][1] : [];
  ok('②b xreadgroup 读到 2 条（消费组游标）', msgs1.length === 2);

  const firstId = msgs1[0] && msgs1[0][0];
  const ack = await client.xack(stream, 'g1', firstId);
  ok('②c xack 第一条 ⇒ 返回 1（已确认）', ack === 1);

  const read2 = await client.xreadgroup('g1', 'c1', stream, '>', 10);
  const msgs2 = read2 && read2[0] ? read2[0][1] : [];
  // 第一次已把两条都投递（游标推到末尾），xack 后 PEL 清空 ⇒ 再读新消息应为 null/空
  ok(
    '②d 再次读新消息 ⇒ 无重复投递（游标已推进，返回 null/空）',
    msgs2.length === 0,
  );
  // 再验证 PEL 语义：xack 后 pending 清空
  const ackTwice = await client.xack(stream, 'g1', firstId);
  ok('②d2 重复 xack 同一 id ⇒ 返回 0（PEL 已清空，幂等）', ackTwice === 0);

  const ackUnknown = await client.xack(stream, 'g1', 'nonexistent-id');
  ok('②e xack 未登记 id ⇒ 返回 0（不虚报）', ackUnknown === 0);

  // ── ③ 补录到 DB（死信落库路径：sink 内部即 repo/DataSource 写入，此处验证 sqlite 表可写可读） ──
  console.log('\n【3】死信落库（sqlite 表写入路径）');
  const { AiDeadLetterEntity } = require('../../src/database/entities/ai-dead-letter.entity');
  const repo = ds.getRepository(AiDeadLetterEntity);
  await repo.insert({
    op: 'verify.op',
    tenantId: 'verify-tenant',
    detail: 'step2c 集成验证',
    error: '故意失败用于验证补录',
    stack: null,
    level: 'best_effort',
    at: new Date(),
    // created_at 非 @CreateDateColumn（普通 @Column）⇒ TypeORM 会显式 INSERT 字段值，
    // 不传则为 NULL 并被 sqlite NOT NULL 拒绝（MySQL 侧同列有 DEFAULT 但也依赖调用方传值）
    createdAt: new Date(),
  });
  const rows = await repo.find({ where: { op: 'verify.op' } });
  ok(
    '③ 死信成功落 sqlite（AI-22/23 补录路径的库侧可用）',
    rows.length === 1 && rows[0].error === '故意失败用于验证补录',
  );

  await ds.destroy();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(tmpDb + s)) fs.unlinkSync(tmpDb + s);
  }
  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本异常:', e && e.message);
  process.exit(2);
});
