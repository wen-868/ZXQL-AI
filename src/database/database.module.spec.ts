/**
 * 双形态存储装配测试（R101-AI-30）
 *
 * 守两条：
 * 1. **connected（缺省）⇒ MySQL 选项逐键与改造前一致**（生产零改动）
 * 2. **standalone ⇒ better-sqlite3 + data/app.db + WAL**，且首启自动建目录
 *
 * 用导出的 `buildTypeOrmOptions()` 直接断言选项对象，**不真连库**（双形态都可跑、零外部依赖）。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { AI_ENTITIES, buildTypeOrmOptions } from './database.module';

function configOf(env: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: unknown) => env[key] ?? fallback,
  } as unknown as ConfigService;
}

describe('buildTypeOrmOptions（R101-AI-30 双形态装配）', () => {
  const savedMode = process.env.INTEGRATION_MODE;
  const savedPath = process.env.STANDALONE_DB_PATH;
  afterEach(() => {
    if (savedMode === undefined) delete process.env.INTEGRATION_MODE;
    else process.env.INTEGRATION_MODE = savedMode;
    if (savedPath === undefined) delete process.env.STANDALONE_DB_PATH;
    else process.env.STANDALONE_DB_PATH = savedPath;
  });

  it('connected（缺省）⇒ MySQL：选项逐键与改造前一致（生产零改动）', () => {
    delete process.env.INTEGRATION_MODE;
    const options = buildTypeOrmOptions(
      configOf({
        DB_HOST: 'db.internal',
        DB_PORT: '3307',
        DB_USERNAME: 'ai_user',
        DB_PASSWORD: 'secret',
        DB_DATABASE: 'ai_db',
      }),
    ) as Record<string, unknown>;

    expect(options.type).toBe('mysql');
    expect(options.host).toBe('db.internal');
    expect(options.port).toBe('3307');
    expect(options.username).toBe('ai_user');
    expect(options.password).toBe('secret');
    expect(options.database).toBe('ai_db');
    expect(options.entities).toBe(AI_ENTITIES);
    expect(options.synchronize).toBe(false);
    expect(options.timezone).toBe('+08:00');
    expect(options.charset).toBe('utf8mb4');
    expect(options.poolSize).toBe(10);
    expect(options.extra).toEqual({ connectionLimit: 10 });
    // standalone 专属项不得出现
    expect(options.enableWAL).toBeUndefined();
  });

  it('connected 缺省值：host/port/database 回退与改造前一致', () => {
    delete process.env.INTEGRATION_MODE;
    const options = buildTypeOrmOptions(configOf()) as Record<string, unknown>;
    expect(options.host).toBe('127.0.0.1');
    expect(options.port).toBe(3306);
    expect(options.database).toBe('liquor_inventory');
  });

  it('standalone ⇒ better-sqlite3 + 指定库路径 + WAL，且自动创建父目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai30-db-'));
    const dbPath = path.join(dir, 'nested', 'app.db');
    process.env.INTEGRATION_MODE = 'standalone';
    process.env.STANDALONE_DB_PATH = dbPath;

    const options = buildTypeOrmOptions(configOf()) as Record<string, unknown>;

    expect(options.type).toBe('better-sqlite3');
    expect(options.database).toBe(dbPath);
    expect(options.enableWAL).toBe(true);
    expect(options.entities).toBe(AI_ENTITIES);
    expect(options.synchronize).toBe(false);
    // 首启可用：better-sqlite3 不建父目录 ⇒ 装配层必须建
    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    // MySQL 专属项不得出现
    expect(options.host).toBeUndefined();
    expect(options.poolSize).toBeUndefined();
    expect(options.charset).toBeUndefined();
  });

  it('standalone 未指定路径 ⇒ 默认 <cwd>/data/app.db（桌面"双击即用"）', () => {
    delete process.env.STANDALONE_DB_PATH;
    process.env.INTEGRATION_MODE = 'standalone';

    const options = buildTypeOrmOptions(configOf()) as Record<string, unknown>;
    expect(String(options.database).replace(/\\/g, '/')).toMatch(
      /\/data\/app\.db$/,
    );
    expect(String(options.database)).toBe(
      path.resolve(process.cwd(), 'data', 'app.db'),
    );
  });

  it('standalone 装配**真建连**：better-sqlite3 可初始化、WAL 生效、可建表读写', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai30-real-'));
    const dbPath = path.join(dir, 'app.db');
    process.env.INTEGRATION_MODE = 'standalone';
    process.env.STANDALONE_DB_PATH = dbPath;

    // ⚠️ 方言在**模块加载期**求值（装饰器）：必须让 database.module 与其实体在
    // standalone 环境下**重新加载**（真实桌面端是进程启动前就设好环境变量）。
    let standaloneModule: typeof import('./database.module') | undefined;
    jest.isolateModules(() => {
      standaloneModule =
        jest.requireActual<typeof import('./database.module')>(
          './database.module',
        );
    });
    const options = standaloneModule?.buildTypeOrmOptions(
      configOf(),
    ) as DataSourceOptions;

    const ds = new DataSource(options);
    try {
      await ds.initialize();
      expect(ds.isInitialized).toBe(true);
      // WAL 由 enableWAL 生效（驱动原生选项）
      const wal: unknown = await ds.query('PRAGMA journal_mode');
      const firstRow = Array.isArray(wal)
        ? (wal[0] as { journal_mode?: unknown })
        : undefined;
      expect(String(firstRow?.journal_mode).toLowerCase()).toBe('wal');
      // 读写真实落盘
      await ds.query('CREATE TABLE probe (id INTEGER PRIMARY KEY, v TEXT)');
      await ds.query("INSERT INTO probe (v) VALUES ('ok')");
      expect(await ds.query('SELECT v FROM probe')).toEqual([{ v: 'ok' }]);
    } finally {
      if (ds.isInitialized) await ds.destroy();
    }
  });
});
