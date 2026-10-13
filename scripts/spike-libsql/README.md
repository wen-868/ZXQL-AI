# R101-AI-29 · LibSQL 嵌入可行性验证（spike 证据包）

> 结论（一句话）：**LibSQL 直连不可行**（TypeORM 1.1.0 无 libsql driver；且本机 win32/arm64 无 libsql 原生绑定）
> ⇒ 推荐 **better-sqlite3 + WAL**（TypeORM 官方支持，本机已实测建表/读写/唯一键/累加/毫秒全通）
> 完整结论与改造量见 `docs/reports/R101-AI-29-阿坚-回传.md`

## 环境

| 项 | 值 |
|---|---|
| 主机 | `win32 / arm64`（Windows on ARM） |
| Node | v24.18.0 |
| TypeORM | **1.1.0**（本仓 `node_modules/typeorm`，`DatabaseType` 无 `libsql`） |
| better-sqlite3 | 12.11.1（SQLite **3.53.2**） |
| @libsql/client | 0.18.0 |
| libsql（原生绑定包） | 0.5.29（**无 win32-arm64 构建**） |
| 依赖安装位置 | `%TEMP%\ai29-libsql-spike`（**未写入本仓 package.json**） |

## 脚本与原始输出（可按序复跑）

| 脚本 | 输出 | 回答的问题 |
|---|---|---|
| `01-driver-probe.cjs` | `out-01.txt` | TypeORM 能否用 LibSQL 建 DataSource？driver 注入口子是否存在？ |
| `02-entity-mapping.cjs` | `out-02.txt` | 3 个代表性实体的列/类型/唯一键在 SQLite 下的映射差异 |
| `03-upsert-arbitration.cjs` | `out-03.txt` | `ON DUPLICATE KEY` vs `ON CONFLICT` 的等价性与仲裁行为 |

复跑方式（在装好依赖的目录内）：

```bash
node 01-driver-probe.cjs
node 02-entity-mapping.cjs
node 03-upsert-arbitration.cjs
```

依赖清单（供复现）：
```bash
npm i typeorm@1.1.0 better-sqlite3@12 @libsql/client@0.18 libsql@0.5.29 reflect-metadata
```

## 关键发现

| ID | 发现 | 证据 |
|---|---|---|
| V1 | TypeORM 1.1.0 **无 libsql driver**，`type:'libsql'` 直接被拒 | `out-01.txt` A 段：`Wrong driver: "libsql" given. Supported drivers are: …"better-sqlite3"…"sqljs"` |
| V2 | 本机 **win32/arm64 无 libsql 原生绑定**（上游 optionalDeps 无该平台） | `out-01.txt` B 段：`Cannot find module '@libsql/win32-arm64-msvc'` |
| V3 | TypeORM 支持 **`options.driver` 注入**（自带 driver 模块的扩展口子） | `out-01.txt` D 段 OK |
| V4 | better-sqlite3 + TypeORM **建连/建表/读写全通**（SQLite 3.53.2） | `out-01.txt` C 段 |
| F1 | 列类型 `char` **SQLite 驱动不支持** | `out-02.txt` 2.0：`DataTypeNotSupportedError: "char" … AiIdempotency.idemKey` |
| F2 | 列类型 `mediumtext` **不支持** ⇒ 须改 `text` | `out-02.txt`（同上，改 char 后暴露） |
| F3 | `bigint` 主键 + generated **不能建表**（`AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`）⇒ 须 `integer` | `out-02.txt` 2.2 |
| F4 | 唯一键冲突错误形态不同：SQLite `code=SQLITE_CONSTRAINT_UNIQUE`、**errno undefined**；MySQL `ER_DUP_ENTRY`/`1062` ⇒ 判重函数须按方言扩展 | `out-02.txt` 2.6 |
| F5 | `ON DUPLICATE KEY UPDATE` 在 SQLite **语法错误** ⇒ 4 处写点须改写 | `out-03.txt` A 段：`SQLITE_ERROR near "DUPLICATE"` |
| F6 | 数值类型读回不同：`decimal(12,4)` 在 SQLite 读回 **number**（MySQL 经 mysql2 读回 string） | `out-02.txt` 2.7 |
| E1 | **仲裁等价成立**：`ON CONFLICT(…) DO UPDATE` 命中同一行（`lastInsertRowid` 不变、行数恒 1） | `out-03.txt` B/C 段 |
| E2 | **累加等价成立**：4 次 UPSERT ⇒ `chat_count=4`、`total_cost=0.006`（与 MySQL `x = x + VALUES(x)` 同结果） | `out-03.txt` E 段 |
| E3 | `ON CONFLICT … DO NOTHING` 冲突时 `changes=0` ⇒ **可无异常判重**（比捕获异常更适合闸门） | `out-03.txt` D 段 |
| E4 | 条件重认领等价：`ON CONFLICT … DO UPDATE … WHERE status='failed'` ⇒ `changes=1/0` 对应 MySQL `UPDATE … WHERE` 的 affectedRows | `out-03.txt` C-4 |

## 读输出提示

- `out-02.txt` 的 `[2.0]` 段是**故意失败**（原样 MySQL 口径），用于暴露不支持的类型；`[2.1]` 起是改类型后的成功路径。
- `out-03.txt` 中 `[A-MySQL方言] FAIL（预期）` 同样是**故意的负向证据**。
