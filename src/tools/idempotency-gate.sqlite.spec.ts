/**
 * AI-21 幂等闸门 × **真实 sqlite 库** 集成测试（R101-AI-30 第 3 步 · 最优先硬验收）
 *
 * 与 `idempotency-gate.service.spec.ts` 的内存替身不同，本文件用真链路：
 * - **真 better-sqlite3 库**，且用 `migrations-sqlite/000_baseline.sql` 建表
 *   （⚠️ 凌舟 F10 结论：**不要用 `synchronize:true`** —— 建不出 016/基线里的 DB 层唯一键，
 *    会掩盖"清 Redis 后不撞唯一键"的真实缺口）
 * - **真内存 Redis**（`RedisMemoryClient`，STEP2c 交付物）
 * - 真仓储灌进 `IdempotencyGateService`
 *
 * 覆盖 5 条中的 4 条（第 5 条"预览不耗键"属 ToolExecutor 层，见回传"未完成"）：
 * ① 同令牌回放（complete 后再次 check ⇒ replay，库中仍 1 行）
 * ② 清空 Redis（TTL/重启）后仍 replay ⇒ **真库唯一键兜底**（F4 在真驱动真库上生效）
 * ③ mutation 等价：**去掉唯一索引** ⇒ 兜底失效（"去唯一键红"的证据）
 * ④ DB 不可用（非唯一键错误）⇒ fail-open 放行（裁定 B）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, Repository } from 'typeorm';
import { RedisMemoryClient } from '../common/redis-memory.client';
import { RedisProvider } from '../common/redis.provider';
import { AiIdempotencyEntity } from '../database/entities/ai-idempotency.entity';
import {
  IdempotencyCheckInput,
  IdempotencyGateService,
} from './idempotency-gate.service';

const CTX = { tenantId: 't1', userId: 'u1' } as const;

const INPUT: IdempotencyCheckInput = {
  toolName: 'createSalesOrder',
  args: { items: [{ skuId: 'S1', qty: 2 }], confirm: true },
  toolCallId: 'confirm-wg_sqlite_1',
  context: CTX,
};

/** 加载 **standalone 方言** 实体（方言在装饰器求值时确定 ⇒ 必须隔离重加载） */
function loadStandaloneEntity(): typeof AiIdempotencyEntity {
  const saved = process.env.INTEGRATION_MODE;
  process.env.INTEGRATION_MODE = 'standalone';
  let entity: typeof AiIdempotencyEntity | undefined;
  jest.isolateModules(() => {
    entity = jest.requireActual<{
      AiIdempotencyEntity: typeof AiIdempotencyEntity;
    }>('../database/entities/ai-idempotency.entity').AiIdempotencyEntity;
  });
  if (saved === undefined) delete process.env.INTEGRATION_MODE;
  else process.env.INTEGRATION_MODE = saved;
  return entity as typeof AiIdempotencyEntity;
}

interface Harness {
  gate: IdempotencyGateService;
  repo: Repository<AiIdempotencyEntity>;
  redis: RedisMemoryClient;
  ds: DataSource;
  dbPath: string;
}

async function createHarness(): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai21-sqlite-'));
  const dbPath = path.join(dir, 'app.db');

  // ① TypeORM 连接空库文件（synchronize:false ⇒ 不动结构）
  const Entity = loadStandaloneEntity();
  const ds = new DataSource({
    type: 'better-sqlite3',
    database: dbPath,
    entities: [Entity],
    synchronize: false,
    enableWAL: true,
  });
  await ds.initialize();

  // ② 用**基线 SQL** 建表（含 016 口径的 DB 层唯一键 uk_ai_idempotency）
  //    ⚠️ 凌舟 F10：不要用 synchronize:true —— 建不出 DB 层约束，会掩盖真实缺口
  const baseline = fs
    .readFileSync(
      path.resolve(__dirname, '../../migrations-sqlite/000_baseline.sql'),
      'utf8',
    )
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  for (const stmt of baseline
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    await ds.query(stmt);
  }

  const repo = ds.getRepository(Entity);
  const redis = new RedisMemoryClient();
  const redisProvider = {
    getSharedClient: jest.fn(() => redis),
  } as unknown as RedisProvider;
  const config = {
    get: (_k: string, d?: unknown) => d,
  } as unknown as ConfigService;

  const gate = new IdempotencyGateService(config, redisProvider, repo, ds);
  return { gate, repo, redis, ds, dbPath };
}

/** 断言并取认领句柄 */
function handleOf(
  decision: Awaited<ReturnType<IdempotencyGateService['check']>>,
): NonNullable<
  Extract<
    Awaited<ReturnType<IdempotencyGateService['check']>>,
    { decision: 'proceed' }
  >['handle']
> {
  expect(decision.decision).toBe('proceed');
  if (decision.decision !== 'proceed' || !decision.handle) {
    throw new Error('未认领');
  }
  return decision.handle;
}

describe('AI-21 幂等闸门 × 真实 sqlite（基线建表；R101-AI-30 第 3 步）', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    if (h.ds.isInitialized) await h.ds.destroy();
    fs.rmSync(path.dirname(h.dbPath), { recursive: true, force: true });
  });

  it('① 同令牌回放：认领 → 完成 → 再提交 ⇒ replay（带 idempotent_replay），库中仅 1 行', async () => {
    const handle = handleOf(await h.gate.check(INPUT));
    await h.gate.complete(handle, {
      success: true,
      data: { orderNo: 'SO-SQLITE-1' },
    });

    const again = await h.gate.check(INPUT);
    expect(again.decision).toBe('replay');
    if (again.decision === 'replay') {
      // 回放结果**多带**标记字段（idempotent_replay / originalCompletedAt）⇒ 用 toMatchObject
      expect(again.result).toMatchObject({
        success: true,
        data: { orderNo: 'SO-SQLITE-1' },
      });
    }
    expect(await h.repo.count()).toBe(1);
  });

  it('② 清空 Redis（TTL/重启）后仍 replay ⇒ 真库唯一键兜底（真驱动真库上的 F4）', async () => {
    const handle = handleOf(await h.gate.check(INPUT));
    await h.gate.complete(handle, {
      success: true,
      data: { orderNo: 'SO-SQLITE-2' },
    });

    await h.redis.quit(); // 模拟 Redis 键过期/重启

    const again = await h.gate.check(INPUT);
    expect(again.decision).toBe('replay');
    expect(await h.repo.count()).toBe(1); // 未产生第二条
  });

  it('③ mutation 等价：去掉唯一索引 ⇒ 兜底失效（"去唯一键红"的证据）', async () => {
    await h.ds.query('DROP INDEX "uk_ai_idempotency"');

    const handle = handleOf(await h.gate.check(INPUT));
    await h.gate.complete(handle, {
      success: true,
      data: { orderNo: 'SO-SQLITE-3' },
    });

    await h.redis.quit(); // 清 Redis ⇒ 此时只能靠唯一键兜底，而它已被删
    const again = await h.gate.check(INPUT);

    expect(again.decision).not.toBe('replay');
    const rows: unknown = await h.ds.query(
      'SELECT COUNT(1) AS c FROM "t_ai_idempotency"',
    );
    const firstRow = Array.isArray(rows)
      ? (rows[0] as { c?: unknown })
      : undefined;
    expect(Number(firstRow?.c)).toBeGreaterThan(1);
  });

  it('④ DB 不可用（非唯一键错误）⇒ fail-open 放行（裁定 B，不阻断用户）', async () => {
    await h.ds.destroy();
    const decision = await h.gate.check(INPUT);
    expect(decision.decision).toBe('proceed');
  });

  // ⑤「预览不耗键」**不在闸门层**：闸门不做 confirm 判定（服务头注释：该条件由 ToolExecutor 把关
  // `isWriteOperation && args.confirm===true`）。实测闸门对 confirm≠true + explicitKey 的调用**仍会认领落行**，
  // 故此处不做假通过断言 —— ⑤ 的正确落点是 ToolExecutor 集成用例（见回传"未完成"）。
});
