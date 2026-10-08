# 跨仓迁移债· 卡 M1 · `t_ai_audit_log` 建表缺失导致新环境部署必然失败

- 派发日期：2026-10-08
- 派发方：林夕
- 仓库：`D:\Users\ZXQL\ZXQL-AI`（**本卡可在 ZXQL-AI 内完成，不需要跨仓**）
- 基线：`1b40d22`
- 优先级：**P1**（生产老库不受影响，但「新环境从零部署」这条路完全不通）

---

## 一、缺陷陈述（审查方实测，逐条可复现）

审计日志表`t_ai_audit_log`（AI 调用明细，高频写入）**全仓没有任何 CREATE TABLE**，但有三处迁移ALTER 它。

### 取证一：migrations 里CREATE 了哪些表

```
$ grep -ohiE "CREATE TABLE (IF NOT EXISTS )?`?[a-z_]+`?" migrations/*.sql | sort -u
CREATE TABLE IF NOT EXISTS ai_correction
CREATE TABLE IF NOT EXISTS ai_evolution_version
CREATE TABLE IF NOT EXISTS ai_execution_plan
CREATE TABLE IF NOT EXISTS ai_experience
CREATE TABLE IF NOT EXISTS ai_sample
CREATE TABLE IF NOT EXISTS t_ai_employee
CREATE TABLE IF NOT EXISTS t_ai_employee_task
CREATE TABLE IF NOT EXISTS t_ai_session_archive
CREATE TABLE IF NOT EXISTS t_mcp_token
```
**9 张表，无 `t_ai_audit_log`。**

### 取证二：谁在 ALTER 它

```
$ grep -ln "t_ai_audit_log" migrations/*.sql
migrations/008_digital_employee.sql← employee_uid
migrations/009_audit_lane_categories.sql              ← lane / categories / idx_lane
migrations/010_rating_and_triage.sql                  ← triage_lane / triage_categories
```
三处**全部只做 `information_schema.COLUMNS` 判定后 ADD COLUMN**，都假定基表已存在。

### 取证三：部署脚本的失败白名单不含 1146

跨仓脚本 `wen-ssystem/deploy/ai-base-deploy.sh:84`：
```bash
grep -vE '^[[:space:]]*ERROR[[:space:]]+(1060|1061|1050|1091)([[:space:]]|\(|:|$)'
```
白名单只有 **1060(列已存在) / 1061(索引已存在) / 1050(表已存在) / 1091(索引已删)**。
**不含 1146（表不存在）** ⇒ 判定为真失败 ⇒ `:355` `ai_migration_fail` ⇒ **阻断整个部署**。

---

## 二、失效链（新环境从零部署）

1. `t_ai_audit_log` 不存在
2. `008:39-42` 查 `information_schema.COLUMNS ... COLUMN_NAME='employee_uid'` ⇒ 0 行 ⇒ 判定「需 ALTER」
3. `PREPARE` 执行 `ALTER TABLE t_ai_audit_log ADD COLUMN employee_uid ...` ⇒ MySQL 报 **ERROR 1146 (42S02): Table 'db.t_ai_audit_log' doesn't exist**
4. 1146 不在白名单 ⇒ `ai_mig_error_all_tolerated` 返回非 0
5. ⇒ `ai_migration_fail "数据库迁移失败，已阻断本次 AI 底座部署"`
   （`:355`，且**不重启 pm2**，旧版本继续服务 —— 这点脚本设计是对的）

**症状**：新环境首次部署必然停在 008，且报错指向「迁移失败」，排查者需要自己反推「缺建表脚本」。生产老库能跑，是因为 2026-10-05 手工补齐过。

---

## 三、实施要求

### R1 补建表脚本，**编号方案二选一（需你确认，见第六节）**

DDL 可从实体定义完整反推：`src/database/entities/ai-audit-log.entity.ts`（17 列 + 4 个索引，字段注释齐全）。

硬性要求（沿用项目迁移约定）：
- 用 `CREATE TABLE IF NOT EXISTS` ⇒ 天然幂等（对齐 002/003/006 的既有风格）
- ⚠️ **MySQL 8.0 不支持 `CREATE TABLE IF NOT EXISTS ... ADD COLUMN IF NOT EXISTS` 混写**；加列仍须 `information_schema` 判定 + `PREPARE`
- ⚠️ SQL 注释 `--` 后必须至少留一个空白，否则 1064；**中英文混排、全角括号紧跟 `--` 极易踩**（007/009 各中过一次）
- 自检：`grep -nE "^\s*--[^ \t-]" migrations/0NN_*.sql` 应无输出
- `categories` / `tool_calls` 是 `json` 类型
- 索引按实体声明：`idx_tenant_id` / `idx_created_at` / `idx_tenant_created` / `idx_session`
- ⚠️ 列名/类型必须与实体**逐字一致**（如 `tenant_id varchar(36)`、`id bigint unsigned AUTO_INCREMENT`、`success tinyint DEFAULT 1`），否则 TypeORM 运行时映射会错

### R2 顺带修`007` 的硬编码跨库名

`migrations/007_e5_auto_close.sql:30/40` 直接写 `ALTER TABLE ai_db.ai_evolution_version ...`，而同脚本的 `information_schema` 判定用会话变量 `@ai_db` ⇒ 库名不叫 `ai_db` 时判定与实际执行库不一致 ⇒ 静默失效。

要求：去掉硬编码库名前缀，与同脚本的 `@ai_db` 变量口径统一。**改动必须保持对已执行过007 的库仍然幂等。**

### R3 验收必须连真实 MySQL 8.0 跑

**静态 grep 不足以证明正确**（项目教训：验收脚本可能恒绿）。必须：
- 起真实 MySQL 8.0 实例（本机已有 `%TEMP%/mysql80/`，端口 3307；本机自带库是 MariaDB 11.4.5，**不能拿它当生产可跑**）
- 建空库 → 从 `002`起**按序连跑全部迁移** → 必须零失败
- 第二遍再跑一遍 → 必须全部「已存在，跳过」
- 查 `information_schema.COLUMNS` 确认 `t_ai_audit_log` 的 17 列+ 4 索引**真实存在**（不是只看 stdout）

⚠️ 复现失效链再确认修复有效：**修复前**在空库上跑到 008 应报 1146；**修复后**应全部通过。

---

## 四、门禁

同阶段 4-1（纯净 HEAD 独立 worktree、一次性全量）：
```
npx eslint . --ext .ts --max-warnings=0
npx tsc -p tsconfig.build.json --noEmit
npx tsc -p tsconfig.json --noEmit        # 含 spec，CI 不查这个
npx jest# 全量
```

---

## 五、纪律

1. **不改跨仓脚本**。`wen-ssystem/deploy/ai-base-deploy.sh` 的白名单（`1060|1061|1050|1091`）**不要动** —— 本卡修的是「缺建表」，白名单不该为缺表兜底（那是掩盖问题）。
2. **DDL 从实体反推，逐字对齐**。写完把列名/类型/长度/nullable/default 与 `ai-audit-log.entity.ts` 逐项核对一遍。
3. **数字必须真跑出来**，不许引用本卡或历史报告里的数字。
4. 提交信息用中文，写明改了什么+ 为什么。
5. `git add` 用显式路径，不用 `-A`。

---

## 六、编号（用户已拍板，2026-10-08）

✅ **采用方案 A：新建 `migrations/001_audit_log.sql`**。

理由与连带影响：
- 缺口本身就是债，补上才对得起部署脚本「按序全量重放」的逻辑
- `CREATE TABLE IF NOT EXISTS` 对已存在的表是 no-op ⇒ **不影响任何已执行过迁移的库**
- ⚠️ 编号 `013` 已被阶段 4-1 的 `013_backfill_sample_task_type.sql` 占用；阶段 3 的幂等表顺延到 **`015`** 起（`014` 分配给 D-2 用量表唯一键修复）

---

## 七、交付物

1. `migrations/` 新增建表脚本（编号待确认）+ `007` 硬编码修正
2. `docs/reports/跨仓迁移债-M1-audit_log建表-执行报告.md`，含**真实 MySQL 8.0 的三轮跑验证输出**（空库首跑 / 二跑幂等 / information_schema 实际结构）
3. 最终回复给出：空库首跑结果、二跑结果、`information_schema` 里该表实际列数与索引数
