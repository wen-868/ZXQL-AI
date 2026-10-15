-- R101-AI-37 步骤 1 · 桌面端（standalone）增量 002：待办表
--
-- 约定（R101-AI-30 乙案）：
--   - `000_baseline.sql` 为首次建库基线（不重生成）；结构变更走增量 `NNN_*.sql`
--   - applier 自动按序应用（除 000），本文件**纯 DDL / 幂等**（全部 `IF NOT EXISTS`）
--
-- ⚠️ 本文件**只建待办表**。ACL 通用化（`t_ai_doc_acl`→`t_ai_acl`、`doc_id`→`resource_id`、
--    加 `resource_type`、重建唯一键/索引）全部由 **applier 条件执行**，原因有二：
--    ① sqlite 无 `RENAME ... IF EXISTS` / `ADD COLUMN IF NOT EXISTS` ⇒ 纯 SQL 无法幂等
--    ② 若把 `t_ai_acl` 的索引写在本文件，**新库**在 applier 改名之前执行 ⇒ 表不存在而失败
--      （此顺序缺陷在编写时即被识别，避免了一次"跑起来才发现"）
--
-- 应用方式：node scripts/sqlite-baseline/apply-baseline.cjs [库文件]
-- 负责人: 阿坚 | 创建日期: 2026-10-16

-- ── 待办表 ──
CREATE TABLE IF NOT EXISTS "t_ai_todo" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "title" varchar(255) NOT NULL,
  "description" text,
  "assignee" varchar(128) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT ('pending'),
  "priority" varchar(16) NOT NULL DEFAULT ('normal'),
  "due_at" datetime(3),
  "source" varchar(16) NOT NULL DEFAULT ('user'),
  "created_by" varchar(64),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS "t_ai_todo__uk_ai_todo_dedupe"
  ON "t_ai_todo" ("tenant_id", "title", "assignee", "due_at");
CREATE INDEX IF NOT EXISTS "t_ai_todo__idx_ai_todo_assignee_status"
  ON "t_ai_todo" ("tenant_id", "assignee", "status");
CREATE INDEX IF NOT EXISTS "t_ai_todo__idx_ai_todo_due_at"
  ON "t_ai_todo" ("tenant_id", "due_at");
