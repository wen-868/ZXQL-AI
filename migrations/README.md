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
