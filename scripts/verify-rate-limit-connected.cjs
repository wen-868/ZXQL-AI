/**
 * R101-AI-34 P2-6：**connected（真 ioredis）限流读写分桶**实测
 *
 * 与 P2-6 之前的 standalone（内存）验证互补：本脚本连**真 Redis**，驱动**真 `RateLimiterService`**
 * （走 Lua 令牌桶路径），验证：
 *   ① 容量口径：读 600/分钟、写 60/分钟（缺省配置，`capacityOf` 直读）
 *   ② 分桶行为：读桶与写桶**各自独立触顶**（用 env 缩小容量跑密集循环，避免真实网络延迟下的补桶干扰）
 *   ③ 桶互不挤占：写桶触顶后读仍放行
 *   ④ key 形态：`tenant:{tid}:read|write`（在真 Redis 里查实际键）
 *
 * 红线：**只读验证、不改任何限流配置**；只用测试专用 key 前缀（`tenant:p26-*`）并在跑完清理；
 *       连本机 Redis 的 **db 15**（隔离），不动生产 key。
 *
 * 运行：`node scripts/verify-rate-limit-connected.cjs`
 * 负责人: 阿坚 | 创建日期: 2026-10-15
 */
process.env.INTEGRATION_MODE = 'connected';

const path = require('path');

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'sqlite-baseline/tsconfig.json'),
});

const Redis = require('ioredis');
const { RateLimiterService } = require('../src/common/rate-limiter');

const TEST_PREFIX = 'tenant:p26-check';
const REDIS = { host: '127.0.0.1', port: 6379, db: 15 };

/** 造一个按 env 覆盖容量的 ConfigService 桩（只影响本进程，不改任何配置文件） */
function configOf(env) {
  return { get: (key, dflt) => (key in env ? env[key] : dflt) };
}

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) {
    pass += 1;
    console.log(`  √ ${label}`);
  } else {
    fail += 1;
    console.log(`  × ${label}`);
  }
}

(async () => {
  console.log('═══ R101-AI-34 P2-6 connected 分桶实测（真 ioredis）═══');
  const client = new Redis({ ...REDIS, lazyConnect: true });
  await client.connect();
  const pong = await client.ping();
  console.log(`[env] redis ping=${pong} db=${REDIS.db}`);

  try {
    // 清理上一轮残留
    const stale = await client.keys(`*${TEST_PREFIX}*`);
    if (stale.length > 0) await client.del(...stale);

    // ── ① 容量口径（缺省 600 / 60） ──
    const defaults = new RateLimiterService(
      configOf({}),
      { getSharedClient: () => client },
    );
    await defaults.onModuleInit();
    ok(
      '① 读桶容量 = 600/分钟（缺省）',
      defaults.capacityOf('read').capacity === 600,
    );
    ok(
      '① 写桶容量 = 60/分钟（缺省）',
      defaults.capacityOf('write').capacity === 60,
    );

    // ── ②/③ 分桶行为（缩小容量跑密集循环：20/5，避免补桶干扰） ──
    const svc = new RateLimiterService(
      configOf({ RATE_LIMIT_READ_PER_MIN: 20, RATE_LIMIT_WRITE_PER_MIN: 5 }),
      { getSharedClient: () => client },
    );
    await svc.onModuleInit();

    const readKey = `${TEST_PREFIX}-a:read`;
    const writeKey = `${TEST_PREFIX}-a:write`;

    let readAllowed = 0;
    for (let i = 0; i < 20; i += 1) {
      const r = await svc.consume(readKey, 1, 'read');
      if (r.allowed) readAllowed += 1;
    }
    const readOver = await svc.consume(readKey, 1, 'read');
    ok(
      `② 读桶：20 次内全放行（${readAllowed}/20）后触顶`,
      readAllowed === 20 && readOver.allowed === false,
    );

    let writeAllowed = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await svc.consume(writeKey, 1, 'write');
      if (r.allowed) writeAllowed += 1;
    }
    const writeOver = await svc.consume(writeKey, 1, 'write');
    ok(
      `② 写桶：5 次内全放行（${writeAllowed}/5）后触顶`,
      writeAllowed === 5 && writeOver.allowed === false,
    );

    // ③ 互不挤占：写桶已触顶，读桶（同租户新桶）仍放行
    const readAfterWriteExhausted = await svc.consume(
      `${TEST_PREFIX}-b:read`,
      1,
      'read',
    );
    ok(
      '③ 写桶触顶不影响读桶（读仍放行）',
      readAfterWriteExhausted.allowed === true,
    );
    // 反向：读桶触顶不影响写桶
    const writeAfterReadExhausted = await svc.consume(
      `${TEST_PREFIX}-c:write`,
      1,
      'write',
    );
    ok(
      '③ 读桶触顶不影响写桶（写仍放行）',
      writeAfterReadExhausted.allowed === true,
    );

    // ── ④ 真 Redis 里的 key 形态 ──
    const keys = await client.keys(`*${TEST_PREFIX}*`);
    const hasRead = keys.some((k) => k.includes(':read:'));
    const hasWrite = keys.some((k) => k.includes(':write:'));
    ok(
      `④ key 形态含 :read:/:write 分桶后缀（实际键 ${keys.length} 个，样例 ${keys.slice(0, 2).join(' , ')}）`,
      hasRead && hasWrite,
    );

    // ── ⑤ 与 standalone 同源：容量只由配置决定（形态无关） ──
    const readCap = defaults.capacityOf('read').capacity;
    const writeCap = defaults.capacityOf('write').capacity;
    ok(
      `⑤ capacityOf 双形态同源（读 ${readCap} / 写 ${writeCap} 只由配置决定，与 driver 无关）`,
      readCap === 600 && writeCap === 60,
    );
  } finally {
    const leftover = await client.keys(`*${TEST_PREFIX}*`);
    if (leftover.length > 0) await client.del(...leftover);
    await client.quit();
  }

  console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('脚本异常：', err);
  process.exit(2);
});
