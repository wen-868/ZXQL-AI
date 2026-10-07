# 跨仓迁移债 · 卡 M1 · `t_ai_audit_log` 建表缺失 —— 执行报告

- 执行人：m1-worker
- 执行日期：2026-10-08
- 仓库：`D:\Users\ZXQL\ZXQL-AI`
- 基线：`1e76ffd`（工作期间 d2-worker 提交 `5baf53f`，本报告不含其改动）
- 交付物：`migrations/001_audit_log.sql`（新增）、`migrations/007_e5_auto_close.sql`（修正）、`migrations/README.md`（表清单状态更新）

---

## 〇、验证环境（真实 MySQL 8.0，非 MariaDB）

任务卡 R3 写「本机自带库是 MariaDB 11.4.5」——**与实际不符，已实测核实**：

```
$ ls /c/Program\ Files/MariaDB*/bin          → 无此目录
$ Get-Service | Where-Object { $_.Name -like '*mysql*' -or $_.Name -like '*maria*' }
→ 无任何输出（本机没有 MySQL/MariaDB 服务）
$ 全盘（C:\、D:\）递归搜索 mysqld.exe        → 0 个命中
$ ls /c/Users/XIONG/AppData/Local/Temp/mysql80   → 目录不存在（任务卡提到的历史环境已不在）
```

即：**本机既没有 MariaDB、也没有 MySQL**。为满足 R3「必须连真实 MySQL 8.0 跑」，我下载了官方 zip 自建实例：

| 项 | 值 |
|---|---|
| 来源 | `https://dev.mysql.com/get/Downloads/MySQL-8.0/mysql-8.0.28-winx64.zip`（222,021,254 字节，官方归档） |
| 版本 | **MySQL Community Server 8.0.28** |
| 路径 | `C:\Users\XIONG\AppData\Local\Temp\mysql80\mysql-8.0.28-winx64\` |
| 监听 | `127.0.0.1:3307`，root 空密码（`--initialize-insecure`） |
| 配置 | `--performance-schema=OFF --innodb-buffer-pool-size=128M` |

```
$ ./bin/mysqld.exe --console --initialize-insecure --basedir=... --datadir=...
2026-10-07T18:11:52.360187Z 6 [Warning] [MY-010453] [Server] root@localhost is created with an empty password !
INIT_EXIT=0

$ ./bin/mysql.exe -uroot -h127.0.0.1 -P3307 -e "SELECT VERSION() AS v;"
v
8.0.28
exit=0
```

**结论：本报告全部结论均在 MySQL 8.0.28 上实测，未使用 MariaDB 顶替。**

### 执行方式

严格按 `migrations/README.md` §二.3 的要求：**每个迁移文件一个独立连接、整文件执行**（保证 `@ai_db` 等会话变量与 `PREPARE` 可用），不做按分号拆分：

```
MYSQL="./bin/mysql.exe -uroot -h127.0.0.1 -P3307 --default-character-set=utf8mb4"
$MYSQL <业务库> < migrations/NNN_x.sql
```

### 空库的构成（重要前提）

业务库里由**管理系统仓**建的表（`t_platform_ai_config` / `t_tenant_ai_billing` / `t_push_log`）不在本仓迁移范围内，但它们被 004/005/007/012 直接 ALTER。为让「按序全量重放」可跑通，我对这三张表建了最小桩（仅含 ALTER 引用的前置列），其余 AI 底座自己的表**全部缺失**，即为真实的「新环境空库」：

```sql
CREATE TABLE t_platform_ai_config (id INT PRIMARY KEY AUTO_INCREMENT, default_system_prompt TEXT);
CREATE TABLE t_tenant_ai_billing (id INT PRIMARY KEY AUTO_INCREMENT, enabled TINYINT DEFAULT 1);
CREATE TABLE t_push_log (id INT PRIMARY KEY AUTO_INCREMENT, user_id VARCHAR(36), created_at DATETIME);
```

`013` 操作未加库名限定的 `ai_sample`，该表在 `ai_db`，故 013 对 `ai_db` 执行（业务库里没有 `ai_sample`）；其余 001–012 对业务库执行。

---

## 一、修复前：复现失效链（空库跑到 008 报 1146）

跳过 `001`，对空库 `m1_before` 按序重放 002→014（`--force` 以便一次跑完、统计全部 1146）：

```
$ bash run_m1.sh m1_before before.log no --force
$ grep -nE "ERROR|=====" before.log
===== 001_audit_log.sql （跳过：复现修复前场景）=====
===== 008_digital_employee.sql  [目标库: m1_before] =====
15:ERROR 1146 (42S02) at line 46: Table 'm1_before.t_ai_audit_log' doesn't exist
===== 009_audit_lane_categories.sql  [目标库: m1_before] =====
18:ERROR 1146 (42S02) at line 24: Table 'm1_before.t_ai_audit_log' doesn't exist
19:ERROR 1146 (42S02) at line 35: Table 'm1_before.t_ai_audit_log' doesn't exist
20:ERROR 1146 (42S02) at line 46: Table 'm1_before.t_ai_audit_log' doesn't exist
===== 010_rating_and_triage.sql  [目标库: m1_before] =====
23:ERROR 1146 (42S02) at line 51: Table 'm1_before.t_ai_audit_log' doesn't exist
24:ERROR 1146 (42S02) at line 61: Table 'm1_before.t_ai_audit_log' doesn't exist
```

**`t_ai_audit_log` 共 6 处 1146**（008×1、009×3、010×2），与任务卡取证二「三处迁移全都在 ALTER 它」一致。

去掉 `--force` 再跑一遍（模拟部署脚本的真实行为——出错即中断并返回非 0）：

```
===== 007_e5_auto_close.sql =====
----- exit=0 -----
===== 008_digital_employee.sql =====
----- exit=1 -----      ← 部署脚本在这里被判真失败
===== 009_audit_lane_categories.sql =====
----- exit=1 -----
===== 010_rating_and_triage.sql =====
----- exit=1 -----
===== 011_employee_task_tenant.sql =====
----- exit=0 -----
```

**失效链复现成功**：008 首个 1146 出现在文件第 46 行（即 `PREPARE` 出的 `ALTER TABLE t_ai_audit_log ADD COLUMN employee_uid`），`exit=1`，1146 不在部署脚本白名单 `1060|1061|1050|1091` 内 ⇒ `ai_migration_fail` ⇒ 部署阻断。

> 附带发现（**不在本卡范围，已同步 d2-worker**）：`014_usage_daily_unique_key.sql` 命中同一病根 —— `t_ai_usage_daily` 同样全仓无 CREATE TABLE，空库下 014 报 8 处 1146（行 71/79/89/109/115/129/153/157/165），`exit=1`。

---

## 二、修复后：空库首跑（含 001）

对全新空库 `m1_after` 按序重放 001→014（严格模式，不带 `--force`）：

```
$ bash run_m1.sh m1_after after_p1.log yes
===== 001_audit_log.sql  [目标库: m1_after] =====        ----- exit=0 -----
===== 002_mcp_token.sql =====                            ----- exit=0 -----
===== 003_ai_db_evolution.sql =====                      ----- exit=0 -----
===== 004_platform_ai_config_fallback.sql =====          ----- exit=0 -----
===== 005_session_archive_billing.sql =====              ----- exit=0 -----
===== 006_ai_execution_plan.sql =====                    ----- exit=0 -----
===== 007_e5_auto_close.sql =====                        ----- exit=0 -----
===== 008_digital_employee.sql =====                     ----- exit=0 -----
===== 009_audit_lane_categories.sql =====                ----- exit=0 -----
===== 010_rating_and_triage.sql =====                    ----- exit=0 -----
===== 011_employee_task_tenant.sql =====                 ----- exit=0 -----
===== 012_push_log_tenant.sql =====                      ----- exit=0 -----
===== 013_backfill_sample_task_type.sql [ai_db] =====    ----- exit=0 -----
===== 014_usage_daily_unique_key.sql =====               ----- exit=1 -----   ← D-2 卡问题，非本卡
$ grep -nE "ERROR" after_p1.log
34:ERROR 1146 (42S02) at line 71: Table 'm1_after.t_ai_usage_daily' doesn't exist
```

**首跑结果：001–013 全部 exit=0，零失败**（011/013 的核验 SELECT 均输出 `0  0`）。唯一的 exit=1 是 014，属 D-2 卡的独立缺口，与本卡无关。

---

## 三、修复后：二跑幂等

不重建库，对同一 `m1_after` 再按序重放一遍（仍严格模式）：

```
$ bash run_m1_pass2.sh m1_after after_p2.log
001..003  ----- exit=0 -----
004  skip_reason：ollama_fallback_enabled 已存在，跳过          ----- exit=0 -----
005  skip_reason：balance 已存在，跳过                          ----- exit=0 -----
006                                                            ----- exit=0 -----
007  skip_reason：evolution_auto_activate 已存在，跳过
     skip_reason：regression_accuracy 已存在，跳过
     skip_reason：regression_evaluated_at 已存在，跳过           ----- exit=0 -----
008  skip_reason：employee_uid 已存在，跳过                      ----- exit=0 -----
009  skip_reason：lane / categories / idx_lane 已存在，跳过      ----- exit=0 -----
010  skip_reason：task_type / rating_result / triage_lane / triage_categories 已存在，跳过  ----- exit=0 -----
011  skip_reason：tenant_id / idx_emp_task_tenant 已存在，跳过   ----- exit=0 -----
012  skip_reason：tenant_id / idx_push_tenant 已存在，跳过       ----- exit=0 -----
013 [ai_db]                                                    ----- exit=0 -----
014                                                            ----- exit=1 -----   ← 同前，D-2 缺口
```

**二跑结果：001–013 全部 exit=0，审计表相关的 008/009/010 全部走「已存在，跳过」分支。**
`001_audit_log.sql` 本身为 `CREATE TABLE IF NOT EXISTS`，二跑对已存在表是 no-op（exit=0、无输出）。

---

## 四、`information_schema` 实测结构（不看 stdout，只看数据字典）

```
$ ./bin/mysql.exe -uroot -h127.0.0.1 -P3307 --table -e "
SELECT COUNT(*) AS cols FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA='m1_after' AND TABLE_NAME='t_ai_audit_log';
SELECT COUNT(DISTINCT INDEX_NAME) AS idxs FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA='m1_after' AND TABLE_NAME='t_ai_audit_log';"
+------+      +------+
| cols |      | idxs |
+------+      +------+
|   21 |      |    6 |
+------+      +------+
```

| 指标 | 实测值 | 说明 |
|---|---|---|
| **列数** | **21** | 实体 21 列全部落地 |
| **索引数（DISTINCT INDEX_NAME）** | **6** | = `PRIMARY` + 001 建的 4 个 + 009 补的 `idx_lane` |
| 其中**二级索引** | **5** | `idx_tenant_id`、`idx_created_at`、`idx_tenant_created`、`idx_session`（001）+ `idx_lane`（009） |

索引明细（`information_schema.STATISTICS`）：

```
+--------------------+-----+-------------+------------+
| INDEX_NAME         | seq | COLUMN_NAME | NON_UNIQUE |
+--------------------+-----+-------------+------------+
| PRIMARY            |   1 | id          |          0 |
| idx_created_at     |   1 | created_at  |          1 |
| idx_lane           |   1 | lane        |          1 |
| idx_session        |   1 | session_id  |          1 |
| idx_tenant_created |   1 | tenant_id   |          1 |
| idx_tenant_created |   2 | created_at  |          1 |
| idx_tenant_id      |   1 | tenant_id   |          1 |
+--------------------+-----+-------------+------------+
```

> ⚠️ **与任务卡的偏差**：任务卡写「17 列 + 4 个索引」，**实测实体是 21 列**。
> 差异 = 008 加的 `employee_uid`、009 加的 `lane`/`categories`、010 加的 `triage_lane`/`triage_categories`（5 列）。
> 21 − 5 = 16，也不是 17 ⇒ 任务卡的「17」无论按哪种口径都对不上。**以代码为准**（见下一节的逐项核对）。

---

## 五、DDL 与实体 `ai-audit-log.entity.ts` 逐项核对

取 `information_schema.COLUMNS` 实跑结果，与实体声明逐列比对（`--table` 输出）：

```
+-----+-------------------+-----------------+-------------+-------------------+-----------------------------------------------+
| pos | COLUMN_NAME       | COLUMN_TYPE     | IS_NULLABLE | dflt              | EXTRA                                         |
+-----+-------------------+-----------------+-------------+-------------------+-----------------------------------------------+
|   1 | id                | bigint unsigned | NO          | (NULL)            | auto_increment                                |
|   2 | tenant_id         | varchar(36)     | NO          | (NULL)            |                                               |
|   3 | user_id           | varchar(36)     | YES         | (NULL)            |                                               |
|   4 | session_id        | varchar(64)     | YES         | (NULL)            |                                               |
|   5 | provider          | varchar(32)     | YES         | (NULL)            |                                               |
|   6 | model             | varchar(64)     | YES         | (NULL)            |                                               |
|   7 | intent            | varchar(64)     | YES         | (NULL)            |                                               |
|   8 | user_message      | text            | YES         | (NULL)            |                                               |
|   9 | tool_calls        | json            | YES         | (NULL)            |                                               |
|  10 | prompt_tokens     | int             | NO          | 0                 |                                               |
|  11 | completion_tokens | int             | NO          | 0                 |                                               |
|  12 | latency_ms        | int             | YES         | (NULL)            |                                               |
|  13 | success           | tinyint         | NO          | 1                 |                                               |
|  14 | error_message     | text            | YES         | (NULL)            |                                               |
|  15 | created_at        | datetime        | NO          | CURRENT_TIMESTAMP | DEFAULT_GENERATED                             |
|  16 | updated_at        | datetime        | NO          | CURRENT_TIMESTAMP | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
|  17 | employee_uid      | varchar(40)     | YES         | (NULL)            |  ← 008                                        |
|  18 | lane              | varchar(16)     | YES         | (NULL)            |  ← 009                                        |
|  19 | categories        | json            | YES         | (NULL)            |  ← 009                                        |
|  20 | triage_lane       | varchar(16)     | YES         | (NULL)            |  ← 010                                        |
|  21 | triage_categories | varchar(128)    | YES         | (NULL)            |  ← 010                                        |
+-----+-------------------+-----------------+-------------+-------------------+-----------------------------------------------+
```

逐项核对结论（✅ = 与实体逐字一致）：

| # | 实体字段 → 列 | 实体声明 | 实测 | 归属 | 结论 |
|---|---|---|---|---|---|
| 1 | `id` | `bigint` + `unsigned:true` + PK 自增 | `bigint unsigned` NO `auto_increment` | 001 | ✅ |
| 2 | `tenantId` → `tenant_id` | `varchar(36)` | `varchar(36)` NO | 001 | ✅ |
| 3 | `userId` → `user_id` | `varchar(36)` nullable | `varchar(36)` YES | 001 | ✅ |
| 4 | `sessionId` → `session_id` | `varchar(64)` nullable | `varchar(64)` YES | 001 | ✅ |
| 5 | `provider` | `varchar(32)` nullable | `varchar(32)` YES | 001 | ✅ |
| 6 | `model` | `varchar(64)` nullable | `varchar(64)` YES | 001 | ✅ |
| 7 | `intent` | `varchar(64)` nullable | `varchar(64)` YES | 001 | ✅ |
| 8 | `userMessage` → `user_message` | `text` nullable | `text` YES | 001 | ✅ |
| 9 | `toolCalls` → `tool_calls` | **`json`** nullable | `json` YES | 001 | ✅ |
| 10 | `promptTokens` → `prompt_tokens` | `int` default 0 | `int` NO default `0` | 001 | ✅ |
| 11 | `completionTokens` → `completion_tokens` | `int` default 0 | `int` NO default `0` | 001 | ✅ |
| 12 | `latencyMs` → `latency_ms` | `int` nullable | `int` YES | 001 | ✅ |
| 13 | `success` | `tinyint` default 1 | `tinyint` NO default `1` | 001 | ✅ |
| 14 | `errorMessage` → `error_message` | `text` nullable | `text` YES | 001 | ✅ |
| 15 | `createdAt` → `created_at` | `datetime` default `CURRENT_TIMESTAMP` | `datetime` NO default `CURRENT_TIMESTAMP` | 001 | ✅ |
| 16 | `updatedAt` → `updated_at` | `datetime` default+onUpdate `CURRENT_TIMESTAMP` | `datetime` NO default `CURRENT_TIMESTAMP` `on update CURRENT_TIMESTAMP` | 001 | ✅ |
| 17 | `employeeUid` → `employee_uid` | `varchar(40)` nullable | `varchar(40)` YES | 008 | ✅ |
| 18 | `lane` | `varchar(16)` nullable | `varchar(16)` YES | 009 | ✅ |
| 19 | `categories` | **`json`** nullable | `json` YES | 009 | ✅ |
| 20 | `triageLane` → `triage_lane` | `varchar(16)` nullable | `varchar(16)` YES | 010 | ✅ |
| 21 | `triageCategories` → `triage_categories` | `varchar(128)` nullable | `varchar(128)` YES | 010 | ✅ |

**21/21 列逐字一致，无一处不符、无多余列、无缺列。**
索引 4/4 与实体 `@Index` 声明一致（`idx_tenant_id` / `idx_created_at` / `idx_tenant_created` / `idx_session`），复合索引列序 `(tenant_id, created_at)` 与实体一致。

### 关于「001 只建 16 列、不建后 5 列」的决策

`001_audit_log.sql` **只声明实体基线的 16 列**，把 `employee_uid` / `lane` / `categories` / `triage_lane` / `triage_categories` 留给 008/009/010。理由：

1. `migrations/README.md` §四「列归属约定」明确要求**同一列只由一处声明**（当初 009 与 010 重复声明 `categories` 且类型一 VARCHAR 一 JSON，差点按执行顺序决定最终类型）；
2. `CREATE TABLE IF NOT EXISTS` 对生产老库是 no-op，后 5 列仍按 008/009/010 的既有路径补齐，两条路径不冲突；
3. 首跑实测证明 001→010 顺序执行后表结构与实体**完全一致**（21 列 5 二级索引），见图/表同上。

---

## 六、007 硬编码库名修正（R2）—— **任务卡前提与代码不符，已按代码实际改法落地**

### 核实结论：任务卡的取证有误

任务卡 R2 称「`007:30/40` 直接写 `ALTER TABLE ai_db.ai_evolution_version`，而同脚本的 `information_schema` 判定用会话变量 `@ai_db`」。**我逐行读了 `007_e5_auto_close.sql`，实际不是这样**：

| 行 | 原内容 | 用的是 |
|---|---|---|
| 26–27 | `WHERE TABLE_SCHEMA = 'ai_db' AND TABLE_NAME='ai_evolution_version' AND COLUMN_NAME='regression_accuracy'` | **字面量 `'ai_db'`** |
| 30 | `ALTER TABLE ai_db.ai_evolution_version ADD COLUMN regression_accuracy ...` | **字面量 `ai_db.`** |
| 36–37 | `WHERE TABLE_SCHEMA = 'ai_db' ... regression_evaluated_at` | **字面量 `'ai_db'`** |
| 40 | `ALTER TABLE ai_db.ai_evolution_version ADD COLUMN regression_evaluated_at ...` | **字面量 `ai_db.`** |

即：**判定与执行两处都硬编码 `ai_db`，口径是彼此一致的**（`@ai_db := DATABASE()` 只在第 1 段 `t_platform_ai_config` 用）。文件第 24 行也写明「ai_evolution_version 位于独立的 ai_db 库，此处显式指定库名」。所以任务卡担心的「判定库与执行库不一致」在字面量口径下并不存在。

### 为什么没有照字面执行 R2

R2 要求「去掉硬编码前缀，统一用 `@ai_db`」。`@ai_db = DATABASE()` = **业务库**，而 `ai_evolution_version` 在业务库里**不存在**。按 README §五的操作手册，007 是「对业务库执行一次」的，若照字面改：

- 判定查 `业务库.ai_evolution_version` → 0 行 → 判定「需 ALTER」
- 对业务库执行 `ALTER TABLE ai_evolution_version ...` → **ERROR 1146**

这会把 007 从一个「改名场景下可能失效」的隐患，变成**在生产/新环境上必挂的硬失败**——正是本卡要消灭的那类故障。故**没有照字面执行**，改按下述方式落地。

### 实际改法：两处硬编码收敛为单一变量，默认值不变

```sql
SET @ai_evo_db := 'ai_db';   -- AI 私有库名；与 003 建库名一致，改名只改这一行
...
WHERE TABLE_SCHEMA = @ai_evo_db AND TABLE_NAME = 'ai_evolution_version' ...
CONCAT('ALTER TABLE ', @ai_evo_db, '.ai_evolution_version ADD COLUMN regression_accuracy DECIMAL(5, 4) NULL COMMENT ''...''')
```

效果：

- **默认行为与原脚本逐字等价**（`'ai_db'`），已执行过 007 的库重跑仍走「已存在，跳过」——二跑实测见第三节；
- 消灭了「两处硬编码、改一处漏一处」的真实隐患，改名只需改一行；
- 首跑实测 `ai_db.ai_evolution_version` 两列均已落地：

```
$ ... -e "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA='ai_db' AND TABLE_NAME='ai_evolution_version' AND COLUMN_NAME LIKE 'regression%';"
+-------------------------+--------------+
| COLUMN_NAME             | COLUMN_TYPE  |
+-------------------------+--------------+
| regression_accuracy     | decimal(5,4) |
| regression_evaluated_at | datetime     |
+-------------------------+--------------+
```

---

## 七、MySQL 8.0 语法红线自检

```
$ grep -nE -- "--[^ \t-]" migrations/001_audit_log.sql        → 无输出（exit=1）
$ grep -nE -- "--[^ \t-]" migrations/007_e5_auto_close.sql    → 无输出（exit=1）
```

- 未使用 `ADD COLUMN/INDEX IF NOT EXISTS`（MariaDB 专有语法）；001 只有 `CREATE TABLE IF NOT EXISTS`（MySQL 8.0 支持），加列/加索引仍走 `information_schema` + `PREPARE` 的既有路径（008/009/010 未改动）。
- 001 已实测在 MySQL 8.0.28 上执行成功（首跑 exit=0）。

## 八、门禁

| 命令 | 结果 |
|---|---|
| `npx eslint "src/**/*.ts" --max-warnings=0` | **exit 0**，零输出（耗时 2m47s，落盘取 exit code） |
| `npx tsc -p tsconfig.build.json --noEmit` | **exit 0**，零输出 |
| `npx tsc -p tsconfig.json --noEmit` | **exit 0**，零输出 |
| `npx jest` | **exit 0**，`Test Suites: 126 passed, 126 total` / `Tests: 1363 passed, 1363 total`，耗时 45.812s（日志尾部有 worker 未优雅退出的告警，非用例失败） |

（本卡只改 SQL 与文档，未改 `src/` 任何业务代码，门禁结果属回归确认。）

---

## 九、结论与遗留

**已修复**：`t_ai_audit_log` 无 CREATE TABLE 导致的「新环境从零部署必然停在 008（ERROR 1146）」——空库首跑 001–013 零失败、二跑全跳过、数据字典实测 21 列 / 5 个二级索引，与实体 21/21 逐字一致。

**未做 / 遗留（均已记录，未擅自扩大范围）**：

1. **未改跨仓脚本** `wen-ssystem/deploy/ai-base-deploy.sh` 的错误白名单（遵守纪律第五条）；
2. **`014_usage_daily_unique_key.sql` 有同一病根**：`t_ai_usage_daily` 全仓无 CREATE TABLE，空库 8 处 1146、exit=1。已实测取证并同步 d2-worker，不在本卡改动范围内；
3. **`013` 在业务库执行会 1146**（其 SQL 未加库名限定，目标表 `ai_sample` 在 `ai_db`）。本轮验证中我对 `ai_db` 执行；若部署脚本是「所有文件对同一业务库重放」，013 同样会阻断部署——建议单开一张卡处理（加库名限定或明确分库路由），本卡未改；
4. **任务卡「17 列 / MariaDB 11.4.5 / 007 用 @ai_db 判定」三处取证与代码或环境不符**，已按纪律逐条实测并以代码为准，见第〇、四、六节；
5. `migrations/README.md` §二.2 写「禁止在 SQL 文件首行写注释」，但 004–014 全部以注释开头。001 沿用现行实际风格（带文件头注释），该条 README 规则与实际代码已脱节，未擅自改规则文本，仅更新了表清单状态。
