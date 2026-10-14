/**
 * 方言适配回归测试（R101-AI-30 / ADR-001）
 *
 * 守两条硬红线：
 * 1. **connected（缺省）元数据零变化** —— 实体列类型/unsigned 必须与改造前逐键一致
 *    （生产 MySQL 路径不受影响；此测试即"零改动"的可执行证据）
 * 2. **standalone 元数据 SQLite 可用** —— F1 char→varchar、F2 mediumtext→text、
 *    F3 主键 bigint→integer、F8 enum→varchar
 *
 * standalone 分支不依赖 better-sqlite3（纯元数据判定），真正的驱动装配在运行时双模式单完成。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import {
  dialectColumnType,
  isStandaloneMode,
  primaryGeneratedColumn,
  resolveIntegrationMode,
  STANDALONE_DB_RELATIVE_PATH,
} from './dialect';
import { AiAuditLogEntity } from './entities/ai-audit-log.entity';
import { AiUsageDailyEntity } from './entities/ai-usage-daily.entity';
import { AiIdempotencyEntity } from './entities/ai-idempotency.entity';
import { AiExecutionPlanEntity } from './entities/ai-execution-plan.entity';

/** 任意实体类（避免使用被 lint 禁止的 Function 类型） */
type AnyClass = abstract new (...args: never[]) => object;

/** 列选项的窄视图（避免依赖 TypeORM 未从包根导出的内部类型） */
interface ColView {
  type?: unknown;
  unsigned?: unknown;
  comment?: unknown;
  length?: unknown;
  enum?: unknown;
  name?: unknown;
}

/** 取某实体类的列选项（按列名索引） */
function columnsOf(target: AnyClass): Record<string, ColView> {
  const out: Record<string, ColView> = {};
  for (const col of getMetadataArgsStorage().columns) {
    if ((col.target as unknown) !== (target as unknown)) {
      continue;
    }
    const opts = col.options as ColView;
    const name =
      typeof opts.name === 'string'
        ? opts.name
        : String(col.propertyName ?? '');
    out[name] = opts;
  }
  return out;
}

describe('方言判定（R101-AI-30）', () => {
  const saved = process.env.INTEGRATION_MODE;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.INTEGRATION_MODE;
    } else {
      process.env.INTEGRATION_MODE = saved;
    }
  });

  it('缺省/空/非法值 ⇒ connected（安全默认，生产不受影响）', () => {
    delete process.env.INTEGRATION_MODE;
    expect(resolveIntegrationMode()).toBe('connected');
    expect(isStandaloneMode()).toBe(false);

    process.env.INTEGRATION_MODE = '';
    expect(resolveIntegrationMode()).toBe('connected');

    process.env.INTEGRATION_MODE = 'STANDALONE ';
    expect(resolveIntegrationMode()).toBe('connected'); // 严格匹配，不猜

    process.env.INTEGRATION_MODE = 'standalone';
    expect(resolveIntegrationMode()).toBe('standalone');
  });

  it('standalone 库路径常量为 data/app.db', () => {
    expect(STANDALONE_DB_RELATIVE_PATH).toBe('data/app.db');
  });

  it('dialectColumnType：connected 返回 MySQL 类型；standalone 返回 SQLite 等价类型', () => {
    delete process.env.INTEGRATION_MODE;
    expect(dialectColumnType('char', 'varchar')).toBe('char');
    expect(dialectColumnType('mediumtext', 'text')).toBe('mediumtext');

    process.env.INTEGRATION_MODE = 'standalone';
    expect(dialectColumnType('char', 'varchar')).toBe('varchar');
    expect(dialectColumnType('mediumtext', 'text')).toBe('text');
    expect(dialectColumnType('enum', 'varchar')).toBe('varchar');
  });

  it('primaryGeneratedColumn 是装饰器工厂（返回函数）', () => {
    expect(typeof primaryGeneratedColumn('bigint')).toBe('function');
  });
});

describe('connected（缺省）实体元数据 = 改造前（生产零改动证据）', () => {
  beforeAll(() => {
    delete process.env.INTEGRATION_MODE;
  });

  /**
   * 实体装饰器在**模块加载时**求值 ⇒ 若整个进程以 standalone 启动，
   * 这里读到的是 SQLite 方言元数据。为让本文件在两种形态下都可跑（不留红），
   * 期望值按**加载期形态**取值：connected 守"与改造前一致"，standalone 守"已适配 SQLite"。
   * （真正压 connected 形状的是缺省运行的那一次门禁。）
   */
  const LOADED_STANDALONE = isStandaloneMode();

  it('AiAuditLog.id：connected=bigint unsigned / standalone=integer（注释保留）', () => {
    const cols = columnsOf(AiAuditLogEntity);
    expect(cols.id.type).toBe(LOADED_STANDALONE ? 'integer' : 'bigint');
    if (!LOADED_STANDALONE) {
      expect((cols.id as { unsigned?: boolean }).unsigned).toBe(true);
    }
    expect(cols.id.comment).toBe('主键ID');
  });

  it('AiUsageDaily.id：connected=bigint unsigned / standalone=integer', () => {
    const cols = columnsOf(AiUsageDailyEntity);
    expect(cols.id.type).toBe(LOADED_STANDALONE ? 'integer' : 'bigint');
    if (!LOADED_STANDALONE) {
      expect((cols.id as { unsigned?: boolean }).unsigned).toBe(true);
    }
  });

  it('AiIdempotency：id/ idem_key / result_json 按形态取值', () => {
    const cols = columnsOf(AiIdempotencyEntity);
    expect(cols.id.type).toBe(LOADED_STANDALONE ? 'integer' : 'bigint');
    expect(cols.idem_key.type).toBe(LOADED_STANDALONE ? 'varchar' : 'char');
    expect(cols.idem_key.length).toBe(64);
    expect(cols.result_json.type).toBe(
      LOADED_STANDALONE ? 'text' : 'mediumtext',
    );
  });

  it('AiExecutionPlan.state：connected=enum（枚举选项保留）/ standalone=varchar', () => {
    const cols = columnsOf(AiExecutionPlanEntity);
    expect(cols.state.type).toBe(LOADED_STANDALONE ? 'varchar' : 'enum');
    expect(cols.state.enum).toEqual([
      'pending',
      'running',
      'success',
      'failed',
      'suspended',
      'skipped',
    ]);
  });

  it('不带 unsigned 的三个实体仍不带 unsigned（避免元数据出现 unsigned:false）', () => {
    // mcp-token / ai-execution-plan / ai-external-model 原本为 { type: 'int', comment }
    jest.isolateModules(() => {
      const { McpTokenEntity } = jest.requireActual<{
        McpTokenEntity: AnyClass;
      }>('./entities/mcp-token.entity');
      const cols = columnsOf(McpTokenEntity);
      expect(cols.id.type).toBe('int');
      expect(Object.prototype.hasOwnProperty.call(cols.id, 'unsigned')).toBe(
        false,
      );
    });
  });
});

describe('standalone 实体元数据 = SQLite 可用（F1/F2/F3/F8）', () => {
  const saved = process.env.INTEGRATION_MODE;
  beforeAll(() => {
    process.env.INTEGRATION_MODE = 'standalone';
  });
  afterAll(() => {
    if (saved === undefined) {
      delete process.env.INTEGRATION_MODE;
    } else {
      process.env.INTEGRATION_MODE = saved;
    }
  });

  it('隔离加载（standalone 环境）后：char→varchar、mediumtext→text、主键→integer、enum→varchar', () => {
    jest.isolateModules(() => {
      const { AiIdempotencyEntity: Idem } = jest.requireActual<{
        AiIdempotencyEntity: AnyClass;
      }>('./entities/ai-idempotency.entity');
      const { AiExecutionPlanEntity: Plan } = jest.requireActual<{
        AiExecutionPlanEntity: AnyClass;
      }>('./entities/ai-execution-plan.entity');

      const idemCols = columnsOf(Idem);
      // F3：SQLite 只接受 INTEGER PRIMARY KEY AUTOINCREMENT
      expect(idemCols.id.type).toBe('integer');
      expect(
        Object.prototype.hasOwnProperty.call(idemCols.id, 'unsigned'),
      ).toBe(false);
      // F1：char 不被支持
      expect(idemCols.idem_key.type).toBe('varchar');
      expect(idemCols.idem_key.length).toBe(64);
      // F2：mediumtext 不被支持
      expect(idemCols.result_json.type).toBe('text');

      // F8：enum 不被支持
      const planCols = columnsOf(Plan);
      expect(planCols.state.type).toBe('varchar');
      expect(planCols.id.type).toBe('integer');
    });
  });
});
