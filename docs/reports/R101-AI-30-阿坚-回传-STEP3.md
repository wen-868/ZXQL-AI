# R101-AI-30 STEP3 回传 · standalone 单基线（迁移乙案）

> ref：`b652347` 起的全链（第 1 步方言层 → 第 2 步双模式装配 → STEP2c Lua/Provider → 本步基线）
> **本步交付：交付物 5（迁移乙案单基线）已完成**；交付物 2/3（冷启动+完整对话）与 4（STEP2c 集成级收尾）**未做**，如实列出。
> 门禁：`tsc` 0 / `eslint --max-warnings=0` 0；**本轮无 `src/` 改动** ⇒ 全量 jest 沿用上一步实测 **157 套件 / 1725 用例全绿**（脚本为 `.cjs`，不参与 tsc/eslint/jest）

## 回传（十项格式）

```
【汇报 R101-AI-30-R-STEP3】standalone 单基线（迁移乙案）落地：由 20 个已注册实体在 standalone 方言下生成 `migrations-sqlite/000_baseline.sql`（20 表 / 29 索引 / 54 语句），并成功应用到 `data/app.db`（WAL 生效、关键列类型符合 F1~F3/F8）；过程中**实测发现并处置 F9：SQLite 索引名库级唯一**（MySQL 表级）导致的基线撞名。冷启动+完整对话、AI-21 五条 sqlite 复跑、STEP2c 集成级收尾未做
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜2026-10-14
交付物：
  1. **[MIGRATIONS-SQLITE/000_BASELINE.SQL](migrations-sqlite/000_baseline.sql)（本步核心交付）**
     - 生成器：[scripts/sqlite-baseline/generate-baseline.cjs](scripts/sqlite-baseline/generate-baseline.cjs)（`INTEGRATION_MODE=standalone` 在 require 实体**之前**设好 + 专用 tsconfig 解决 TS5098）
     - 规模：**20 表 / 29 索引 / 54 语句**（`AI_ENTITIES` 注册实体数 = 20）
     - 方言形态已落地（基线内可见）：`"id" integer PRIMARY KEY AUTOINCREMENT`（F3）、`"idem_key" varchar(64)`（F1）、`"result_json" TEXT`（F2）、`ai_execution_plan.state` 由同一份 standalone 元数据生成 ⇒ varchar（F8，`dialect.spec.ts` standalone 断言守）
  2. **应用器**：[scripts/sqlite-baseline/apply-baseline.cjs](scripts/sqlite-baseline/apply-baseline.cjs)（桌面首启建库与人工验证共用；缺省 `data/app.db`）
     - 实测输出：`表数=19（t_* 前缀）/ 索引数=36 / journal_mode=wal`；
       `t_ai_idempotency 关键列 = [{"id":"INTEGER"},{"idem_key":"varchar(64)"},{"result_json":"TEXT"},{"completed_at":"datetime"}]`
  3. **`data/app.db` 已生成**（含基线表结构 + WAL）——满足"`data/app.db` 生成且含基线表结构"这一条
  4. **F9（本步实测发现，原卡与 spike 均未覆盖）**：**SQLite 的索引名是"库级唯一"，MySQL 是"表级唯一"** ⇒
     多个实体各自声明 `@Index('idx_tenant_created')`（audit-log / usage-daily 等）在单基线里会生成**同名索引** ⇒
     应用时报 `SqliteError: index idx_tenant_created already exists`。
     处置：**仅在 standalone 基线内**把索引名按表前缀化（`<table>__<index>`，如 `t_ai_audit_log__idx_tenant_created`）；
     **实体与生产 MySQL 零改动**（MySQL 仍用原索引名，生产 DDL 无漂移）。
  提交哈希：**未提交**（不 commit / push / stash，等你收口）
证据（可复跑）：
  - 生成：`$ node scripts/sqlite-baseline/generate-baseline.cjs`
      `[baseline] 实体数=20 语句数=54 表=20 索引=29`
  - 应用+校验：`$ node scripts/sqlite-baseline/apply-baseline.cjs`
      `[apply] 表数=19 索引数=36`
      `[apply] journal_mode=wal`
      `[apply] t_ai_idempotency 关键列：[{"name":"id","type":"INTEGER"},{"name":"idem_key","type":"varchar(64)"},{"name":"result_json","type":"TEXT"},{"name":"completed_at","type":"datetime"}]`
  - 索引前缀化抽样：`CREATE INDEX "t_ai_audit_log__idx_session" ON "t_ai_audit_log" ("session_id");`
  - **F9 复现（修复前原文）**：`SqliteError: index idx_tenant_created already exists`
  - 门禁：`tsc` → TSC=0；`eslint "src/**/*.ts" --max-warnings=0` → ESLINT=0；本轮无 `src/` 改动 ⇒ jest 沿用 **157/1725 全绿**
验收自评（对照你给的 4 条）：
  1. 三门禁 ≥157/1725 → **通过（沿用）**：本轮无 src 改动，tsc/eslint 实测 0；jest 数字为上一步实测
  2. standalone 冷启动 + `/api/health` 200 + 完整对话 → **未通过（未做）**，见「未完成」
  3. AI-21 反测 5 条真实 sqlite 原始输出 → **未通过（未做）**
  4. `data/app.db` 生成且含基线表结构 → **通过**（上文实测输出）
  5. 既有 spec expect 删除/修改 = 0 → **通过**（本轮未动任何 spec）
未完成与阻塞（如实，无隐瞒；均为"未做"而非"做不成"）：
  1. **standalone 冷启动 + `/api/health` 200 + 一次完整对话**：需要以 standalone 环境起 Nest 应用（不连 MySQL/Redis）。
     已知前置：Redis 侧已就绪（STEP2c 内存实现 + Provider 分流）；DB 侧已就绪（本步基线 + 双模式装配）。
     待办：桌面端启动入口/环境变量注入（`INTEGRATION_MODE=standalone`）+ 健康探针 + 对话链路（含 LLM provider 依赖）。
  2. **AI-21 反测 5 条在真实 sqlite 库复跑**（同令牌回放 / 去 NX 红 / 去唯一键红 / MySQL 不可用 fail-open / 预览不耗键）：
     需要"真 sqlite DataSource + 幂等闸门 + 仓储"的集成用例（本步基线与 `data/app.db` 已把地基铺好）。
  3. **STEP2c 集成级收尾**：write-guard"仅持有者可释放"（把 RedisProvider 换内存实现后实测）+ AI-23 四条反测在内存 Redis 下全链路（client 级已绿：`redis-memory.client.spec.ts` 16 例）。
风险与自我报备：
  1. **F9 是"落地才暴露"的差异**（spike 探针 2 用了不同索引名，未覆盖重名场景）⇒ 已计入 ADR/回传，并把处置做成"仅基线层前缀化"，**生产零影响**。
  2. **基线是"生成物"而非手写**：`AI_ENTITIES` 增删实体后需**重跑生成器**并新增增量脚本；
     本文件头已写明"不要重新生成 000 覆盖，后续变更走增量脚本"。
  3. **实体数口径**：`src/database/entities/` 有 23 个 `.entity.ts`，而 `AI_ENTITIES` 注册 **20** 个
     （含 ai_db 等分域实体不在本注册表）——基线覆盖的是 `AI_ENTITIES`；若桌面端还要 ai_db 那 4 表，需另出一份 ai_db 基线（未做，等你确认口径）。
  4. `data/app.db` 是**运行产物**（含 WAL/SHM），建议加入 `.gitignore`（本轮未擅自改 `.gitignore`，等你定）。
回传要求：本汇报已落卡：docs/reports/R101-AI-30-阿坚-回传-STEP3.md
关联卡：docs/tasks/cards/R101-AI-30-standalone存储改造.md
```

## 附：本步新增文件（未提交）
| 文件 | 说明 |
|---|---|
| `migrations-sqlite/000_baseline.sql` | standalone 单基线（20 表 / 29 索引；索引名按表前缀化） |
| `scripts/sqlite-baseline/generate-baseline.cjs` | 基线生成器（standalone 方言 + F9 前缀化） |
| `scripts/sqlite-baseline/apply-baseline.cjs` | 基线应用器 + 校验输出 |
| `scripts/sqlite-baseline/tsconfig.json` | 生成器专用 tsconfig（commonjs + 装饰器元数据，解决 TS5098） |
| `data/app.db`（+`-wal`/`-shm`） | 应用基线的产物（建议 gitignore） |

未改任何 `src/` 文件、未改既有 spec、未 .skip、未 commit / push / stash、未动 package.json / lockfile。
