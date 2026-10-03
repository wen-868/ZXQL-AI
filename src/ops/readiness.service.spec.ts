import { DataSource } from 'typeorm';
import { AI_DB_CONNECTION } from '../database/ai-db.module';
import { ReadinessService } from './readiness.service';

/**
 * ReadinessService 单元测试
 *
 * 设计要点：期望清单来自 `DataSource.entityMetadatas`（实体声明），
 * 因此测试用**伪造的实体元数据**驱动，而不是硬编码表名清单 ——
 * 与生产代码同源，也就不会出现"测试清单与真实实体脱节"的假绿。
 */
describe('ReadinessService', () => {
  const OLD_ENV = process.env.AI_READINESS_TTL_MS;

  afterEach(() => {
    if (OLD_ENV === undefined) {
      delete process.env.AI_READINESS_TTL_MS;
    } else {
      process.env.AI_READINESS_TTL_MS = OLD_ENV;
    }
  });

  /** 构造伪实体元数据：tableName + 列 databaseName 列表 */
  const meta = (table: string, columns: string[]) => ({
    tableName: table,
    columns: columns.map((databaseName) => ({ databaseName })),
  });

  /** 构造伪 DataSource */
  const ds = (opts: {
    metadatas: unknown[];
    rows?: Array<{ t: string; c: string }>;
    queryError?: string;
    isInitialized?: boolean;
  }): DataSource => {
    const query = jest.fn((): Promise<Array<{ t: string; c: string }>> => {
      if (opts.queryError) {
        return Promise.reject(new Error(opts.queryError));
      }
      return Promise.resolve(opts.rows ?? []);
    });
    return {
      isInitialized: opts.isInitialized ?? true,
      entityMetadatas: opts.metadatas,
      query,
    } as unknown as DataSource;
  };

  /** 把 rows（表列扁平数组）转成 Set 结构 */
  const rowsOf = (
    pairs: Array<[string, string]>,
  ): Array<{ t: string; c: string }> => pairs.map(([t, c]) => ({ t, c }));

  const newService = (main?: DataSource, aiDb?: DataSource): ReadinessService =>
    new ReadinessService(main, aiDb);

  beforeEach(() => {
    // 默认（不设 AI_READINESS_TTL_MS）应表现为不缓存，让每个用例都真实探测。
    // 需要缓存的用例在自己的 it 里显式设值。
    delete process.env.AI_READINESS_TTL_MS;
  });

  describe('期望清单来源（不硬编码）', () => {
    it('期望表/列取自 entityMetadatas 而非内置清单', async () => {
      // 只声明一张与任何内置清单都不同的表名：若实现存在硬编码清单，这里必然对不上
      const main = ds({
        metadatas: [meta('tbl_probe_only_for_test', ['alpha', 'beta'])],
        rows: rowsOf([
          ['tbl_probe_only_for_test', 'alpha'],
          ['tbl_probe_only_for_test', 'beta'],
        ]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('ready');
      expect(report.databases[0].expectedTables).toBe(1);
      expect(report.databases[0].expectedColumns).toBe(2);
    });

    it('表存在但列缺失 → degraded 且精确指出缺哪一列', async () => {
      const main = ds({
        metadatas: [meta('t_x', ['id', 'tenant_id', 'employee_uid'])],
        rows: rowsOf([
          ['t_x', 'id'],
          ['t_x', 'tenant_id'],
        ]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('degraded');
      expect(report.summary).toEqual({ missingTables: 0, missingColumns: 1 });
      expect(report.databases[0].missingColumns).toEqual([
        { table: 't_x', column: 'employee_uid' },
      ]);
    });

    it('整表缺失 → 计入 missingTables 并把该表期望列一并列为缺失', async () => {
      const main = ds({
        metadatas: [meta('t_gone', ['id', 'name']), meta('t_ok', ['id'])],
        rows: rowsOf([['t_ok', 'id']]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('degraded');
      expect(report.databases[0].missingTables).toEqual(['t_gone']);
      expect(report.summary).toEqual({ missingTables: 1, missingColumns: 2 });
    });

    it('只统计实体声明的列，不把库中多余列/表算作问题', async () => {
      const main = ds({
        metadatas: [meta('t_a', ['id'])],
        // 库里有额外的表和额外的列
        rows: rowsOf([
          ['t_a', 'id'],
          ['t_a', 'extra_col'],
          ['t_unrelated', 'whatever'],
        ]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('ready');
      expect(report.summary).toEqual({ missingTables: 0, missingColumns: 0 });
    });
  });

  describe('只查一次 information_schema（性能约束）', () => {
    it('每个库仅发起 1 次查询，不逐表往返', async () => {
      const main = ds({
        metadatas: [meta('t1', ['a']), meta('t2', ['a']), meta('t3', ['a'])],
        rows: rowsOf([
          ['t1', 'a'],
          ['t2', 'a'],
          ['t3', 'a'],
        ]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      await newService(main, aiDb).check();

      // 反测信号：若改成逐表 SHOW COLUMNS，这里会是 3 次
      const calls = (main.query as jest.Mock).mock.calls as Array<[string]>;
      expect(calls).toHaveLength(1);
      // 且必须限定在自身库（DATABASE()）而非跨库
      expect(calls[0][0]).toContain('information_schema.COLUMNS');
      expect(calls[0][0]).toContain('TABLE_SCHEMA = DATABASE()');
    });
  });

  describe('两库聚合', () => {
    it('主库与 ai_db 任一缺失都算 degraded，summary 合计两个库', async () => {
      const main = ds({
        metadatas: [meta('t_main', ['id'])],
        rows: rowsOf([['t_main', 'id']]),
      });
      const aiDb = ds({
        metadatas: [meta('ai_experience', ['id', 'tenant_id'])],
        rows: rowsOf([['ai_experience', 'id']]),
      });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('degraded');
      expect(report.summary).toEqual({ missingTables: 0, missingColumns: 1 });
      const aiDbScope = report.databases.find((d) => d.scope === 'ai_db');
      expect(aiDbScope?.missingColumns).toEqual([
        { table: 'ai_experience', column: 'tenant_id' },
      ]);
    });
  });

  describe('不可达场景不得谎报 ready', () => {
    it('DataSource 未注入 → degraded + 明确 error', async () => {
      const aiDb = ds({ metadatas: [], rows: [] });
      const report = await newService(undefined, aiDb).check();

      expect(report.status).toBe('degraded');
      const mainScope = report.databases.find((d) => d.scope === 'main');
      expect(mainScope?.connected).toBe(false);
      expect(mainScope?.error).toContain('未注入');
      expect(report.message).toContain('不可达');
    });

    it('DataSource 未初始化 → degraded（不静默跳过）', async () => {
      const main = ds({
        metadatas: [],
        rows: [],
        isInitialized: false,
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('degraded');
      expect(report.databases[0].error).toContain('未初始化');
    });

    it('schema 查询抛错 → degraded 并带出错误信息，且不向上抛', async () => {
      const main = ds({
        metadatas: [],
        rows: [],
        queryError: 'ER_NO_SUCH_TABLE',
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.status).toBe('degraded');
      expect(report.databases[0].error).toContain('ER_NO_SUCH_TABLE');
    });

    it('ai_db 走独立连接名 AI_DB_CONNECTION（不被主库顶替）', () => {
      expect(AI_DB_CONNECTION).toBe('ai_db');
    });
  });

  describe('degraded 指引文案', () => {
    it('表列缺失时指向迁移操作手册', async () => {
      const main = ds({ metadatas: [meta('t_x', ['id'])], rows: [] });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.message).toContain('migrations/README.md');
    });

    it('ready 时不带 message（不留过期指引）', async () => {
      const main = ds({
        metadatas: [meta('t_x', ['id'])],
        rows: rowsOf([['t_x', 'id']]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.message).toBeUndefined();
    });
  });

  describe('缺失列截断', () => {
    it('缺失列超上限时截断并置 truncated 标记', async () => {
      const cols = Array.from({ length: 60 }, (_, i) => `c${i}`);
      const main = ds({ metadatas: [meta('t_big', cols)], rows: [] });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      const mainScope = report.databases[0];
      expect(mainScope.missingColumns).toHaveLength(50);
      expect(mainScope.missingColumnsTruncated).toBe(true);
      // summary 仍报真实总数，便于监控准确判断严重程度。
      // 反测信号：若 summary 改用截断后的 length，这里会得到 50 而失败。
      expect(mainScope.missingColumnTotal).toBe(60);
      expect(report.summary.missingColumns).toBe(60);
    });

    it('未超上限时不置 truncated', async () => {
      const main = ds({ metadatas: [meta('t_x', ['a', 'b'])], rows: [] });
      const aiDb = ds({ metadatas: [], rows: [] });

      const report = await newService(main, aiDb).check();

      expect(report.databases[0].missingColumnsTruncated).toBe(false);
      expect(report.databases[0].missingColumns).toHaveLength(2);
      expect(report.databases[0].missingColumnTotal).toBe(2);
    });

    it('不可达的库 missingColumnTotal 为 0（不虚报缺失）', async () => {
      const report = await newService(undefined, undefined).check();

      expect(report.summary).toEqual({ missingTables: 0, missingColumns: 0 });
      expect(report.databases[0].missingColumnTotal).toBe(0);
    });
  });

  describe('默认不缓存（漏报盲区为零）', () => {
    it('未配置 AI_READINESS_TTL_MS 时每次都真实探测', async () => {
      delete process.env.AI_READINESS_TTL_MS;
      const main = ds({
        metadatas: [meta('t_x', ['id'])],
        rows: rowsOf([['t_x', 'id']]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });
      const service = newService(main, aiDb);

      const first = await service.check();
      const second = await service.check();

      // 反测信号：若默认开了缓存，这里会是 1 次
      expect((main.query as jest.Mock).mock.calls).toHaveLength(2);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(false);
    });

    it('ready 结论建立后紧接着缺列，下一次调用必须立刻报 degraded（缓存期内零盲区）', async () => {
      // 这是 v2 被真实降级验证打脸的那条：单测写"只缓存 ready"能过，
      // 实测却在缓存期内漏报。默认不缓存从根上消除该盲区。
      delete process.env.AI_READINESS_TTL_MS;
      const rows = rowsOf([['t_x', 'id']]);
      const main = ds({ metadatas: [meta('t_x', ['id'])], rows });
      const aiDb = ds({ metadatas: [], rows: [] });
      const service = newService(main, aiDb);

      expect((await service.check()).status).toBe('ready');
      rows.length = 0; // 列消失
      const after = await service.check();

      expect(after.status).toBe('degraded');
      expect(after.cached).toBe(false);
      expect(after.summary.missingColumns).toBe(1);
    });

    it('并发调用只打一次库（inFlight 去重，且不引入陈旧数据）', async () => {
      delete process.env.AI_READINESS_TTL_MS;
      const main = ds({
        metadatas: [meta('t_x', ['id'])],
        rows: rowsOf([['t_x', 'id']]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });
      const service = newService(main, aiDb);

      const results = await Promise.all([
        service.check(),
        service.check(),
        service.check(),
      ]);

      // 并发轮询不应把 information_schema 打成 3 倍负载
      expect((main.query as jest.Mock).mock.calls).toHaveLength(1);
      expect((aiDb.query as jest.Mock).mock.calls).toHaveLength(1);
      expect(results.every((r) => r.status === 'ready')).toBe(true);
      // 去重命中会标 cached，但状态是同一时刻的真实探测结果
      expect(results.filter((r) => r.cached)).toHaveLength(2);
    });
  });

  describe('显式开启 TTL 时的行为（仅供极端高频轮询兜底）', () => {
    it('TTL 内命中缓存，标记 cached 且沿用原探测时间', async () => {
      process.env.AI_READINESS_TTL_MS = '30000';
      const main = ds({
        metadatas: [meta('t_x', ['id'])],
        rows: rowsOf([['t_x', 'id']]),
      });
      const aiDb = ds({ metadatas: [], rows: [] });
      const service = newService(main, aiDb);

      const first = await service.check();
      const second = await service.check();

      expect((main.query as jest.Mock).mock.calls).toHaveLength(1);
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      // 缓存命中也要返回真实探测时间，不能伪造成"刚刚查过"
      expect(second.checkedAt).toBe(first.checkedAt);
    });

    it('degraded 不写缓存：故障态每次都真实探测', async () => {
      process.env.AI_READINESS_TTL_MS = '30000';
      const main = ds({ metadatas: [meta('t_x', ['id'])], rows: [] });
      const aiDb = ds({ metadatas: [], rows: [] });
      const service = newService(main, aiDb);

      await service.check();
      const second = await service.check();

      expect((main.query as jest.Mock).mock.calls).toHaveLength(2);
      expect(second.cached).toBe(false);
    });

    it('非法/负数 TTL 一律回退为不缓存（配置笔误不会静默制造盲区）', async () => {
      for (const bad of ['abc', '-1', '']) {
        process.env.AI_READINESS_TTL_MS = bad;
        const main = ds({
          metadatas: [meta('t_x', ['id'])],
          rows: rowsOf([['t_x', 'id']]),
        });
        const aiDb = ds({ metadatas: [], rows: [] });
        const service = newService(main, aiDb);

        await service.check();
        const second = await service.check();

        expect(second.cached).toBe(false);
        expect((main.query as jest.Mock).mock.calls).toHaveLength(2);
      }
    });
  });
});
