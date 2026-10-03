# AI 底座数据库迁移（migrations/）

> 依据：`docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md` 第 7 章（数据库设计）、22.7（审计与撤销）、26（进化底座 ai_db）。
> 状态：独立仓库迁移目录已建立；`001_ai_tables.sql` 随 P1-1（ai_db 认知闭环）落地时补齐。

## 一、目录定位

- 所有建表/加列/索引变更统一放本目录，**不在业务仓库重复维护**（业务库表结构由管理系统侧维护，AI 底座只声明自身相关表）。
- 与业务库物理隔离：AI 底座私有库 `ai_db`（经验/纠错/样本/进化版本）走独立迁移段；业务侧 AI 表（审计/配置/用量等）走业务库迁移段。

## 二、文件规范

1. **命名**：`NNN_描述.sql`，`NNN` 为 3 位递增序号（001、002…），描述用中文短语，如 `002_ai_db_evolution_tables.sql`。
2. **文件头无注释**：自动迁移器按 `;` 分号拆分逐条执行，文件头若带说明性注释会被当作语句拆分，因此**禁止在 SQL 文件首行写注释**；说明统一写本 README 或独立 `*.md`。
3. **幂等（2026-09-27 更正）**：建表用 `CREATE TABLE IF NOT EXISTS`（MySQL ✅ 支持）。
   **加列/加索引不能用 `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS`——那是 MariaDB 语法，MySQL 8.0 不支持**（此前本 README 误标为"MySQL 8.0 支持"，据此写出的 008/009 在生产执行会直接语法报错）。
   正确写法：`information_schema` 判定 + `PREPARE` 动态 SQL（见 007 / 008 末段 / 009 现行版本）。
   ⚠️ 该写法依赖 **MySQL 会话变量**，因此迁移文件必须**整文件执行**（`mysql -u<user> -p <db> < migrations/NNN_x.sql`），不可按分号拆分到多条独立连接逐条执行，否则变量丢失。
4. **对齐实体**：SQL 与 `src/database/entities/*.entity.ts` 保持一一对应，字段名/类型/索引一致。
5. **迁移文件不做版本回滚**：回滚走反向迁移文件（如 `002_revert`），不做 `DROP` 误删。

## 三、执行方式

- 本地开发：`mysql -u<user> -p<pass> <db> < migrations/001_ai_tables.sql`
- 服务器部署：`deploy/ai-base-deploy.sh` 启动前自动执行本目录未应用迁移（按 NNN 序号记录到 `schema_migrations` 表，P1-1 落地）。

## 四、表清单（规划）

| 迁移段 | 表 | 归属 | 状态 |
|---|---|---|---|
| 001 | t_ai_audit_log / t_ai_usage_daily / t_platform_ai_config / t_tenant_ai_config / t_tenant_ai_billing / t_ai_external_model | 业务库（现有实体已建，SQL 待归档） | 待补齐 |
| 001 | ai_experience / ai_correction / ai_sample / ai_evolution_version | ai_db（P1-1 独立库） | 待落地 |
| 002 | t_mcp_token（MCP 对接令牌，P0-3） | 业务库 | ✅ 已建（002_mcp_token.sql） |
| 003 | ai_db 独立库 + ai_experience/ai_correction/ai_sample/ai_evolution_version（认知闭环，P1-1） | ai_db（独立 schema） | ✅ 已建（003_ai_db_evolution.sql） |
| 004 | t_platform_ai_config 增加 ollama_fallback_enabled（本地兜底开关，P1-3） | 业务库 | ✅ 已建（004_platform_ai_config_fallback.sql） |
| 005 | t_ai_session_archive（会话冷备归档）+ t_tenant_ai_billing 补 balance 列（计费扣减，批次1） | 业务库 | ✅ 已建（005_session_archive_billing.sql） |
| 006 | ai_execution_plan（Agent 自主执行计划，第22章） | 业务库 | ✅ 已建（006_ai_execution_plan.sql） |
| 007 | t_platform_ai_config 补 evolution_auto_activate（E5 自治开关）+ ai_evolution_version 补 regression_accuracy/regression_evaluated_at（回归评测落库） | 业务库 + ai_db | ✅ 已建（007_e5_auto_close.sql） |
| 008 | t_ai_employee（岗位档案，含 dispatch_uids 边表）+ t_ai_employee_task（任务留痕）+ t_ai_audit_log 补 employee_uid（审计署名） | 业务库 | ✅ 已建（008_digital_employee.sql） |
| 009 | t_ai_audit_log 补 lane VARCHAR(16) / categories **JSON**（取证埋点，方案 12.4）+ idx_lane 索引 | 业务库 | ✅ 已建（009_audit_lane_categories.sql） |
| 010 | t_ai_employee_task 补 task_type / rating_result（评分回流产品化）+ t_ai_audit_log 补 triage_lane / triage_categories（意图分诊埋点） | 业务库 | ✅ 已建（010_rating_and_triage.sql） |

> **列归属约定**：`lane` / `categories` 只由 009 声明（与实体 `type:'json'` 对齐）；
> `triage_lane` / `triage_categories` 只由 010 声明。两文件**不得重复声明同一列**——
> 重复且类型不一致时，谁先执行决定最终列类型（2026-10-03 已修正，见 010 文件头）。

## 五、生产补齐（2026-09-27 首次，2026-10-03 复测仍未执行）

**探测结论（对生产实测，非推断）**：生产 AI 底座进程健康，但**迁移只执行到 006**，007 及之后全部未应用 —— 导致的后果：

| 端点 | 生产实测 | 根因 |
|---|---|---|
| `GET /ai-api/api/health` | ✅ 200 `{"status":"ok","service":"zhixiang-ai-base"}` | 进程正常 |
| `POST /api/chat`（任意对话） | ❌ 500 `Unknown column 'PlatformAiConfigEntity.evolution_auto_activate' in 'field list'` | **007 未执行**，走 AiConfigService 即崩，**所有对话全挂** |
| `GET /api/ai/employees` | ❌ 500 `Table 'liquor_inventory.t_ai_employee' doesn't exist` | **008 未执行**，数字员工功能生产完全不可用 |
| `GET /api/chat/models`、`/api/chat/confirmations`、`/api/ai/agent/plans` | ✅ 200 | 依赖 001–006，已应用 |
| `POST /api/admin/auth/demo-login` | ⚠️ 200（空 body 即返回 `SUPER_ADMIN` 令牌） | **P0 安全问题**，见 `docs/规范/生产安全核查.md` |

> **2026-10-03 复测**：上述状态与 2026-09-27 首次探测**完全一致**，期间无人执行补齐。

即：**部署（代码）已完成，但数据库结构没跟上，服务实际不可用**。

**补齐命令**（在数据库所在机器执行，业务库为 `liquor_inventory`，AI 私有库为 `ai_db`）：

```bash
# 业务库：007 的 t_platform_ai_config 段 + 008 + 009 + 010
mysql -u<user> -p liquor_inventory < migrations/007_e5_auto_close.sql
mysql -u<user> -p liquor_inventory < migrations/008_digital_employee.sql
mysql -u<user> -p liquor_inventory < migrations/009_audit_lane_categories.sql
mysql -u<user> -p liquor_inventory < migrations/010_rating_and_triage.sql
```

> 007 分两段：`t_platform_ai_config` 在业务库，另一段脚本内已显式写成 `ai_db.ai_evolution_version`，
> 因此对业务库执行一次即可（前提是 MySQL 账号对 `ai_db` 也有权限；如无权限则单独对 ai_db 执行该段）。
> 四个脚本均已改为幂等（information_schema 判定），**可安全重复执行**，重复跑只会输出"已存在，跳过"。

> ⚠️ 执行顺序：009 必须早于 010（`lane`/`categories` 由 009 声明为 JSON，与实体一致；
> 010 不再声明这两列，故顺序不会影响最终类型）。

**验证**：

```bash
curl https://saas.onepan.cn/ai-api/api/health                 # 应 200
# 对话不再报 Unknown column
# GET /api/ai/employees 不再报 Table doesn't exist
```

补齐后再跑性能/能力基准（`scripts/perf-bench.js`、`tool-bench.js`）才有意义 —— 未补齐时 bench 拿到的全是错误响应
（TTFB 看着很快、但 tokens/迭代/工具调用全为 0，是假数据）。

## 六、根因分析：为什么迁移会"停滞 6 天"（2026-10-03 调查）

前五节讲"怎么补"，这一节讲"**为什么一直没补**"——不解决根因，下次新增迁移还会重演。

**调查结论**：本仓**没有任何执行迁移的入口**。

| 排查项 | 结果 |
|---|---|
| 本仓有无部署脚本 | ❌ 无（仅 `scripts/dev-stack-restart.sh` 等本地开发脚本） |
| 有无 npm script 跑迁移 | ❌ 无（`package.json` 只有 build/start/lint/test 系） |
| 有无 CI 配置引用 `migrations/` | ❌ 无 |
| 部署流水线做了什么 | 由**管理系统仓**的 `auto-deploy.sh` → `deploy/ai-base-deploy.sh` 负责，本仓只被当作"代码包"拉取编译重启 |
| 结果 | **代码每次发布自动部署，数据库迁移需人工执行**，而这一步没有任何提示/校验/阻断，于是被漏掉 |

**这解释了三个此前想不通的现象**：

1. **为什么 `/api/health` 一直 200**——健康检查只验证进程存活，不校验表结构，迁移缺失完全不可见。
2. **为什么代码侧工作持续推进、生产却零进展**——两条链路完全解耦，代码发版不触发迁移。
3. **为什么拖了 6 天**——因为没人会"想起来"去执行它；没有失败信号提醒，就一直搁着。

**根治方向（需跨仓，需你决策）**：

- **方案 A（推荐）：把迁移纳入部署流水线**。在管理系统的 `deploy/ai-base-deploy.sh` 末尾加一步"按序执行未应用的迁移"，并把执行结果纳入部署自检（失败则回滚/告警）。本仓配合：新增迁移时同步更新一个 `migrations/APPLIED.md` 标记文件，脚本据此判断哪些需要执行。
- **方案 B（低成本兜底）：加启动自检**。本仓可在启动时探测关键表/列是否存在，缺失时**打印醒目告警并把 `/api/health` 状态置为 `degraded`**（而非崩溃，避免生产挂掉），配合外部监控告警。可立即落地，但只是"更早发现"，不解决"没人执行"。
- **方案 C：维持现状 + 人工补齐**。仅当部署流水线的负责人明确表示"迁移由 DBA 统一管控"时才成立——那么需要在部署文档里写清"新增迁移后必须通知 DBA"，否则仍会漏。

> 当前采取的是「B 的雏形 + C 的操作手册」：README 本节即操作手册，脚本侧改造（本仓可做）见下。

## 七、已落地：迁移状态自检端点 `GET /api/health/ready`（2026-10-04）

由于部署脚本跨仓，本仓先把"**迁移是否已应用**"变成**可观测的**（而不是靠人去想）。方案 B 已实现：

```
GET /api/health/ready
→ { status: "ready" | "degraded",
    databases: [{ scope, expectedTables, expectedColumns, missingTables, missingColumns, ... }],
    summary: { missingTables, missingColumns },
    message?: "修复指引（degraded 时）" }
响应头：X-AI-Readiness: ready | degraded
```

**实现要点**（`src/ops/readiness.service.ts`）：

| 设计 | 做法 | 为什么 |
|---|---|---|
| 期望清单 | 从 `DataSource.entityMetadatas` **自动派生**（表名 + `columns[].databaseName`） | 新增实体/加字段后自动纳入检查，无需维护任何清单——从根上消除"清单与代码脱节"（内联 DTO 失效、迁移与实体不一致都是同一类病根） |
| 采集方式 | 每个库**一条** `information_schema.COLUMNS` + `TABLE_SCHEMA = DATABASE()` | 20 张表只 1 次往返（不是 20 次 `SHOW COLUMNS`）；`DATABASE()` 天然限定自身库，主库与 `ai_db` 互不误判 |
| 缺失计数 | `summary` 用**真实总数**，明细超 50 条才截断 | 报警数字必须可信——否则 60 个缺列被报成 50，运维会低估故障范围 |
| 状态码 | `degraded` **仍返 200** | 5xx 会被容器编排/pm2 判为进程故障而重启，而重启补不上缺失的列，只会把"数据层不完整"放大成"服务不可用" |
| 结果缓存 | **默认不缓存**（`AI_READINESS_TTL_MS=0`），只保留 inFlight 并发去重 | 见下方"踩过的坑" |
| 不可达 | DataSource 未注入/未初始化/查询失败 → 明确 `degraded` + error | 探针绝不能谎报 ready |

**踩过的坑（真实降级验证发现，单测无法暴露）**：

用"临时 DROP 一列 → 立即探测"的真实破坏性验证（而非只跑单测）才发现：

1. **v1 结果 TTL 缓存 30s** → 删列后立即探测**仍报 ready**，故障后 30 秒内完全静默，恰好在最需要报警的时刻丢掉信号。
2. **v2 改成"只缓存 ready、不缓存 degraded"** → 单测全绿，但**实测依旧漏报**：ready 缓存生效期间根本不进探测逻辑，删列后照样直接返回旧结论。
   （教训：**单测证明不了缓存期内的行为**，必须有真实降级验证。）
3. **定案：默认不缓存**。理由是**缓存与本探针的职责本质矛盾**——探针存在的意义就是"立刻发现结构漂移"，任何 TTL 都必然制造盲区；而实测单次全量探测仅 **27~45ms**，远低于漏报一次迁移事故的代价。
   仅保留 inFlight 并发去重：并发请求共享同一次探测，省掉 N 倍 DB 负载且**不引入任何陈旧数据**。

**实测验收结果**（本地真实 MySQL，默认配置）：

| 场景 | 结果 |
|---|---|
| 结构完整 | `ready`，主库 17 表/188 列 + `ai_db` 4 表/36 列，耗时 27ms |
| 连续探测 | `cached=false`（默认不缓存） |
| DROP `t_ai_audit_log.triage_lane` 后立即探测 | `degraded`，精确报出 `t_ai_audit_log.triage_lane`，`summary.missingColumns=1` |
| 恢复该列后 | 自动回 `ready` |

**代码**：`src/ops/readiness.service.ts` + 21 条单测（`readiness.service.spec.ts`）+ 端点 `src/app.controller.ts`。
**接入方式**：外部监控或流水线自检检查此端点，读 `status` 字段或 `X-AI-Readiness` 响应头。

> 仍待你决策：是否需要把 `/api/health` 也切成按 `ready` 返回状态？**目前刻意未改** —— `/api/health` 保持"仅表示进程存活"的原语义，避免影响现有监控与 pm2 判定；两个端点职责分离（存活 vs 就绪）也是 Kubernetes 惯例。

