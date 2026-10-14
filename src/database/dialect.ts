/**
 * 存储方言判定与列类型适配（R101-AI-30 / ADR-001）
 *
 * 双形态（按 `INTEGRATION_MODE` 装配）：
 * - **connected**（缺省；共享/云生产）⇒ **MySQL**，行为与改造前**逐字一致**（元数据零变化）
 * - **standalone**（桌面嵌入）⇒ **better-sqlite3**（单文件 `data/app.db` + WAL）
 *
 * ⚠️ 时序约束：TypeORM 装饰器在**模块加载时**求值，因此本模块读 `process.env.INTEGRATION_MODE`
 * 的时机即进程启动早期。**运行期不得切换形态**（同一进程内元数据与连接必须一致）。
 *
 * 方言差异来源（R101-AI-29 spike 实证，证据包 `scripts/spike-libsql/`）：
 * - F1 `char` 不被 better-sqlite3 驱动支持 ⇒ SQLite 侧用 `varchar`
 * - F2 `mediumtext` 不支持 ⇒ SQLite 侧用 `text`
 * - F3 `bigint` 主键 + generated 触发 `AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`
 *      ⇒ SQLite 侧主键必须 `integer`
 * - F8 `enum` 不支持（补充探针 4 发现，1 处）⇒ SQLite 侧用 `varchar`
 * 其余类型（varchar/text/int/tinyint/bigint(非主键)/decimal/json/date/datetime(3)/boolean）双方言均可用。
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-14
 */
import { PrimaryGeneratedColumn } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';

/** 集成形态 */
export type IntegrationMode = 'connected' | 'standalone';

/** standalone 的库文件默认相对路径（桌面端工作目录下） */
export const STANDALONE_DB_RELATIVE_PATH = 'data/app.db';

/**
 * 解析 standalone 库文件的**绝对路径**
 *
 * - 可用 `STANDALONE_DB_PATH` 覆盖（便于测试/多档案）
 * - 默认 = 进程工作目录下 `data/app.db`（桌面端"双击即用"）
 */
export function resolveStandaloneDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env.STANDALONE_DB_PATH;
  if (override && override.trim().length > 0) {
    return path.isAbsolute(override) ? override : path.resolve(cwd, override);
  }
  return path.resolve(cwd, STANDALONE_DB_RELATIVE_PATH);
}

/**
 * 确保 standalone 库文件所在目录存在
 *
 * better-sqlite3 **不会自动创建父目录** ⇒ 首启（`data/` 尚不存在）会直接失败。
 * 由装配层在连接前调用；已存在则无副作用。
 */
export function ensureStandaloneDbDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 解析形态：**仅显式 `INTEGRATION_MODE=standalone` 才走嵌入**
 * （缺省/拼错/为空一律 connected ⇒ 生产不受影响，安全默认）
 */
export function resolveIntegrationMode(): IntegrationMode {
  return process.env.INTEGRATION_MODE === 'standalone'
    ? 'standalone'
    : 'connected';
}

/** 是否 standalone（桌面嵌入）形态 */
export function isStandaloneMode(): boolean {
  return resolveIntegrationMode() === 'standalone';
}

/**
 * 列类型按方言选择
 *
 * 返回类型保留 **MySQL 侧字面量类型**（`T`），以便直接用于 `@Column({ type })` 的
 * 字面量联合约束；standalone 时**运行期值**换成 SQLite 等价类型（编译期不体现差异）。
 *
 * @param mysqlType  connected 形态使用的类型（保持既有值 ⇒ 元数据零变化）
 * @param sqliteType standalone 形态使用的等价类型
 */
export function dialectColumnType<T extends string>(
  mysqlType: T,
  sqliteType: string,
): T {
  return (isStandaloneMode() ? sqliteType : mysqlType) as T;
}

/**
 * 自增主键装饰器（F3 方言适配）
 *
 * - connected：等价于既有的 `@PrimaryGeneratedColumn({ type: 'bigint'|'int', unsigned?, comment? })`
 *   （**逐键一致**：原本不带 unsigned 的实体仍不带，避免元数据出现 `unsigned:false`）
 * - standalone：SQLite 只接受 `INTEGER PRIMARY KEY AUTOINCREMENT`
 *   ⇒ 返回 `{ type: 'integer', comment? }`（SQLite 无 unsigned 概念）
 *
 * 以"装饰器工厂"形式提供，避免依赖 TypeORM 未从包根导出的内部选项类型。
 *
 * @param mysqlType MySQL 侧类型（'bigint' 缺省，个别实体为 'int'）
 * @param opts.unsigned MySQL 是否 UNSIGNED（缺省 true；三个实体原本就不带 unsigned）
 * @param opts.comment  列注释（两形态均保留）
 */
export function primaryGeneratedColumn(
  mysqlType: 'bigint' | 'int' = 'bigint',
  opts: { unsigned?: boolean; comment?: string } = {},
): PropertyDecorator {
  const { unsigned = true, comment } = opts;
  if (isStandaloneMode()) {
    return comment
      ? PrimaryGeneratedColumn({ type: 'integer', comment })
      : PrimaryGeneratedColumn({ type: 'integer' });
  }
  // connected：与改造前逐键一致
  return unsigned
    ? comment
      ? PrimaryGeneratedColumn({ type: mysqlType, unsigned: true, comment })
      : PrimaryGeneratedColumn({ type: mysqlType, unsigned: true })
    : comment
      ? PrimaryGeneratedColumn({ type: mysqlType, comment })
      : PrimaryGeneratedColumn({ type: mysqlType });
}
