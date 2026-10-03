/**
 * ReadinessService — 迁移就绪探针（方案 B，2026-10-03）
 *
 * 背景（本仓代码审查发现的运维级缺陷）：
 *   `/api/health` 只验证**进程存活**，不校验表结构。本仓数据库迁移**没有任何执行入口**
 *   （无部署脚本 / 无 npm script / 无 CI 引用），代码由管理系统仓的部署流水线自动发布，
 *   迁移却需人工执行且无提示、无校验、无阻断 —— 结果 007~010 停滞 6 天，
 *   `/api/health` 始终 200，而依赖新列的对话/数字员工/进化版本三条链路全部 500。
 *   详见 migrations/README.md 第六节根因分析。
 *
 * 本服务把"迁移是否已应用"从"靠人去想"变成**可观测**：
 *   GET /api/health/ready → ready / degraded + 缺失清单
 *
 * 关键设计决策：
 *
 * 1. **期望清单从实体元数据自动派生，不硬编码**（严禁硬编码原则）。
 *    直接读 `DataSource.entityMetadatas` 拿表名与列名（`EntityMetadata.tableName` /
 *    `columns[].databaseName`），因此新增 Entity 或给 Entity 加字段后，
 *    本探针**自动**纳入检查，无需同步维护任何清单 —— 从根上消除"清单与代码脱节"这个
 *    本轮反复出现的病根（内联 DTO 失效、迁移与实体不一致都是同一类问题）。
 *
 * 2. **一次 SQL 取全量**。用 `information_schema.COLUMNS` + `TABLE_SCHEMA = DATABASE()`
 *    一条查询拿到该库所有表列，而非逐表 `SHOW COLUMNS`（20 张实体表 = 20 次往返）。
 *    `DATABASE()` 而非硬编码库名：主库与 ai_db 是两个独立 DataSource，
 *    各自连接到自己库，`DATABASE()` 天然限定在自身库内，不会跨库误判。
 *
 * 3. **degraded 不返 5xx**。就绪探针若返回 5xx，会被容器编排/pm2 判定为进程故障而重启，
 *    反而放大故障（重启也补不上缺失的列）。故始终 200，用 `status` 字段 +
 *    `X-AI-Readiness` 响应头区分，由外部监控/流水线自检读取。
 *
 * 4. **默认不缓存结果，只做并发去重**（经两轮真实降级验证定案，见 check() 注释）。
 *    保留 `AI_READINESS_TTL_MS` 仅供极端高频轮询兜底，默认 0（不缓存）。
 *    并发请求走 inFlight 去重：省掉 N 倍 DB 负载且不引入任何陈旧数据。
 *    真实降级验证脚本：`scripts/verify-readiness-probe.cjs`
 *    （建缓存 → 删列 → 期望立即报出表.列 → 恢复 → 回 ready）。
 *
 * 负责人: AI底座 | 创建日期: 2026-10-03
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AI_DB_CONNECTION } from '../database/ai-db.module';

/** 单个库的 schema 就绪情况 */
export interface DatabaseReadiness {
  /** 库作用域：main=业务主库 / ai_db=AI 进化库 */
  scope: 'main' | 'ai_db';
  /** 库是否连通（查不到 schema 视为不通过） */
  connected: boolean;
  /** 实体期望的表数 */
  expectedTables: number;
  /** 实体期望的列总数 */
  expectedColumns: number;
  /** 完全缺失的表 */
  missingTables: string[];
  /** 缺失的列（表存在但列缺 —— 迁移只执行了一半的典型症状） */
  missingColumns: Array<{ table: string; column: string }>;
  /** 缺失列过多时截断，避免响应体爆炸 */
  missingColumnsTruncated: boolean;
  /** 缺失列**真实总数**（> missingColumns.length 时说明已截断） */
  missingColumnTotal: number;
  /** 连通失败原因 */
  error?: string;
}

/** 就绪探针报告 */
export interface ReadinessReport {
  /** ready=期望的表列全部就位；degraded=有缺失或库不可达 */
  status: 'ready' | 'degraded';
  service: string;
  /** 本次**实际执行探测**的时间（缓存命中时为上一次探测时间） */
  checkedAt: string;
  /** 本次调用耗时（毫秒，缓存命中时近似 0） */
  durationMs: number;
  /** 是否来自缓存 */
  cached: boolean;
  databases: DatabaseReadiness[];
  /** 缺失汇总（两个库合计），便于监控只读一个数字 */
  summary: {
    missingTables: number;
    missingColumns: number;
  }; /** degraded 时的可执行指引（ready 时省略） */
  message?: string;
}

/** 缺失列清单最多返回条数（超出仅计数，避免响应体爆炸） */
const MAX_REPORTED_COLUMNS = 50;

/** 单库 schema 探测结果（内部） */
interface SchemaProbe {
  connected: boolean;
  /** 表名 → 该表实际存在的列名集合 */
  tableColumns: Map<string, Set<string>>;
  error?: string;
}

/** information_schema 查询结果行（TABLE_NAME/别名 t、COLUMN_NAME/别名 c） */
interface SchemaRow {
  t: string;
  c: string;
}

@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);
  /**
   * 可选的结果缓存 TTL（毫秒）。
   *
   * 默认 0 = 不缓存 —— 因为本探针的职责是"立刻发现结构漂移"，
   * 任何 TTL 都会制造漏报盲区（真实降级验证已证实）。详见 check() 注释。
   */
  private readonly ttlMs: number;
  private cache: { report: ReadinessReport; at: number } | null = null;
  /** 在途探测（用于并发去重，避免监控并发轮询放大 DB 负载） */
  private inFlight: Promise<ReadinessReport> | null = null;

  constructor(
    @Optional()
    @InjectDataSource()
    private readonly dataSource?: DataSource,
    @Optional()
    @InjectDataSource(AI_DB_CONNECTION)
    private readonly aiDbDataSource?: DataSource,
  ) {
    // 默认 0（不缓存）：漏报一次迁移事故的代价 >> 每次 28~45ms 的探测开销
    const raw = Number(process.env.AI_READINESS_TTL_MS ?? '0');
    this.ttlMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * 执行就绪探测
   *
   * 语义：
   * - `ready`    两个库的实体期望表列全部存在
   * - `degraded` 有缺失的表/列，或某个库不可达
   *
   * **永不抛异常**：探测失败本身就是"未就绪"的信息，不该让探针 500。
   *
   * 缓存策略（2026-10-04 两轮真实降级验证后定案）：**默认不缓存，只做并发去重**。
   *
   * 走过的弯路（记录在此避免后人重犯）：
   * - v1 对所有结果做 30s TTL 缓存 → 实测"删列 → 立即探测"仍报 ready，故障后 30 秒完全静默。
   * - v2 改成"只缓存 ready、不缓存 degraded" → **单测全绿，但实测依旧漏报**：
   *   因为 ready 缓存生效期间根本不进探测逻辑，删列后照样直接返回旧结论。
   *   教训：单测证明不了缓存期内的行为，必须做真实降级验证才发现得了。
   *
   * 定案理由：**缓存与本探针的职责本质矛盾** —— 探针存在的意义就是"立刻发现结构漂移"，
   * 任何 TTL 都必然制造盲区。而实测单次全量探测仅 28~45ms（一条 information_schema 查询），
   * 远低于"漏报一次迁移事故"的代价。故默认 `AI_READINESS_TTL_MS=0`（不缓存）。
   * 保留该项仅为极端高频轮询兜底，启用它等于自愿接受最长 TTL 的发现延迟。
   *
   * 唯一保留的优化是 **inFlight 并发去重**：并发请求共享同一次探测，
   * 既省掉 N 倍 DB 负载，又**不引入任何陈旧数据**（所有请求看到的是同一时刻的真实状态）。
   */
  async check(): Promise<ReadinessReport> {
    const now = Date.now();
    if (
      this.ttlMs > 0 &&
      this.cache?.report.status === 'ready' &&
      now - this.cache.at < this.ttlMs
    ) {
      return { ...this.cache.report, cached: true, durationMs: 0 };
    }

    // 在途去重：若已有探测在进行，直接复用其结果。
    // 这是唯一保留的优化 —— 省 DB 负载的同时不引入陈旧数据。
    if (this.inFlight) {
      return { ...(await this.inFlight), cached: true, durationMs: 0 };
    }

    this.inFlight = this.probeBoth();
    let report: ReadinessReport;
    try {
      report = await this.inFlight;
    } finally {
      this.inFlight = null;
    }

    // 仅当显式配置了 TTL 时才写缓存；默认 ttlMs=0，永不缓存（见上方定案理由）
    if (this.ttlMs > 0 && report.status === 'ready') {
      this.cache = { report, at: Date.now() };
    } else {
      // 清掉旧的 ready 缓存：状态已反转，不能让上一个健康结论继续被复用
      this.cache = null;
    }
    return report;
  }

  /** 并行探测两个库并组装报告 */
  private async probeBoth(): Promise<ReadinessReport> {
    const started = Date.now();
    const [main, aiDb] = await Promise.all([
      this.probe('main', this.dataSource),
      this.probe('ai_db', this.aiDbDataSource),
    ]);

    const missingTables = main.missingTables.length + aiDb.missingTables.length;
    // 用真实总数而非截断后的长度：报警数字必须可信，
    // 否则 60 个缺列被报成 50，运维会低估故障范围。
    const missingColumns = main.missingColumnTotal + aiDb.missingColumnTotal;
    const connected = main.connected && aiDb.connected;
    const ready = connected && missingTables === 0 && missingColumns === 0;

    const report: ReadinessReport = {
      status: ready ? 'ready' : 'degraded',
      service: 'zhixiang-ai-base',
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      cached: false,
      databases: [main, aiDb],
      summary: { missingTables, missingColumns },
    };

    if (!ready) {
      report.message = this.buildMessage(main, aiDb);
      // 每次 degraded 打 warn：这是"部署完成但迁移没跑"的唯一信号源，
      // 日志留痕便于事后追溯（探针可能只被外部监控调，日志是本地证据）。
      this.logger.warn(
        `就绪探针 degraded：缺表 ${missingTables} 张、缺列 ${missingColumns} 个` +
          (connected ? '' : '（存在不可达的库）'),
      );
    }
    return report;
  }

  /**
   * 探测单个库的 schema 完整度
   *
   * 期望清单来源：`DataSource.entityMetadatas`（实体声明 = 代码的真实需求）。
   * DataSource 未注入或未初始化 → connected=false（不静默跳过，否则探针会说谎）。
   */
  private async probe(
    scope: 'main' | 'ai_db',
    dataSource?: DataSource,
  ): Promise<DatabaseReadiness> {
    const base: DatabaseReadiness = {
      scope,
      connected: false,
      expectedTables: 0,
      expectedColumns: 0,
      missingTables: [],
      missingColumns: [],
      missingColumnsTruncated: false,
      missingColumnTotal: 0,
    };

    if (!dataSource) {
      return { ...base, error: `${scope} DataSource 未注入` };
    }
    if (!dataSource.isInitialized) {
      return { ...base, error: `${scope} DataSource 未初始化` };
    }

    // 期望清单：实体元数据
    const expected = new Map<string, Set<string>>();
    for (const meta of dataSource.entityMetadatas) {
      // 无显式表名的实体其 tableName 为类名，仍是有效期望值
      expected.set(
        meta.tableName,
        new Set(meta.columns.map((c) => c.databaseName)),
      );
    }
    base.expectedTables = expected.size;
    base.expectedColumns = [...expected.values()].reduce(
      (sum, cols) => sum + cols.size,
      0,
    );

    // 实际清单：一条 information_schema 查询取全量
    let actual: SchemaProbe;
    try {
      // TypeORM 的 query() 签名返回 any。此处先落到 unknown 再收窄为已声明的行类型，
      // 让 any 不越过类型边界（直接写 `as SchemaRow[]` 会被 lint 的
      // no-unsafe-assignment autofix 删掉，因为它把断言本身视为问题）。
      const raw: unknown = await dataSource.query(
        'SELECT TABLE_NAME AS `t`, COLUMN_NAME AS `c` ' +
          'FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()',
      );
      const rows: SchemaRow[] = Array.isArray(raw) ? (raw as SchemaRow[]) : [];
      const tableColumns = new Map<string, Set<string>>();
      for (const { t, c } of rows) {
        let cols = tableColumns.get(t);
        if (!cols) {
          cols = new Set<string>();
          tableColumns.set(t, cols);
        }
        cols.add(c);
      }
      actual = { connected: true, tableColumns };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ...base, error: `${scope} schema 查询失败：${error}` };
    }

    // 逐表比对
    const missingColumns: Array<{ table: string; column: string }> = [];
    for (const [table, expectedCols] of expected) {
      const actualCols = actual.tableColumns.get(table);
      if (!actualCols) {
        base.missingTables.push(table);
        // 表整体缺失时，把该表所有期望列一并计入缺失列：
        // 运维需要知道"这张表要补"，而不只是"表没了"。
        for (const col of expectedCols) {
          missingColumns.push({ table, column: col });
        }
        continue;
      }
      for (const col of expectedCols) {
        if (!actualCols.has(col)) {
          missingColumns.push({ table, column: col });
        }
      }
    }

    base.missingTables.sort();
    base.connected = true;
    base.missingColumnTotal = missingColumns.length;
    if (missingColumns.length > MAX_REPORTED_COLUMNS) {
      base.missingColumns = missingColumns.slice(0, MAX_REPORTED_COLUMNS);
      base.missingColumnsTruncated = true;
    } else {
      base.missingColumns = missingColumns;
    }
    return base;
  }

  /**
   * 生成可执行修复指引
   *
   * 不猜"该执行哪个迁移"（迁移序号与实体耦合，猜错反而误导），
   * 只指向唯一权威操作手册，并区分"库都连不上"与"表列缺失"两种成因。
   */
  private buildMessage(
    main: DatabaseReadiness,
    aiDb: DatabaseReadiness,
  ): string {
    if (!main.connected || !aiDb.connected) {
      const down = [
        !main.connected && main.error,
        !aiDb.connected && aiDb.error,
      ]
        .filter(Boolean)
        .join('；');
      return `数据库不可达，无法判定就绪：${down}。先恢复数据库连接（就绪探针不校验表结构，数据库挂了请看 /api/admin/health）。`;
    }
    return (
      '数据库结构与代码期望不一致，通常是迁移未执行或只执行了一半。' +
      '按序执行 migrations/ 下未应用的脚本（操作手册见 migrations/README.md 第五节，' +
      '根因与根治方案见第六节），执行后本探针**下一次调用**即恢复 ready。'
    );
  }
}
