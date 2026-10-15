-- R101-AI-35 S1 · 桌面端（standalone）增量：文档中心建表
--
-- 约定（R101-AI-30 乙案）：
--   - `000_baseline.sql` 是**桌面端首次建库**的基线（由实体同步生成一次固化），**不得重生成覆盖**
--   - 结构变更一律走**增量文件**（本文件是第一条），由 applier 按序应用：000 → 001
--   - 本文件保持**纯 DDL**（全部 `CREATE ... IF NOT EXISTS`，可重复应用）
--   - ⚠️ sqlite 无 `ADD COLUMN IF NOT EXISTS` ⇒ "条件加列"（`t_ai_knowledge_chunks.doc_id`）
--     由 applier 用 `PRAGMA table_info` 判定后执行，**不写在纯 SQL 里**（否则重复应用会报错）
--
-- 应用方式：node scripts/sqlite-baseline/apply-baseline.cjs [库文件]
-- 负责人: 阿坚 | 创建日期: 2026-10-15

-- ── 1. 文档主表 ──
CREATE TABLE IF NOT EXISTS "t_ai_doc" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "title" varchar(255) NOT NULL,
  "category" varchar(64) NOT NULL DEFAULT ('default'),
  "owner" varchar(64),
  "source_type" varchar(16) NOT NULL DEFAULT ('upload'),
  "content_hash" varchar(64) NOT NULL,
  "tags" text,
  "rag_status" varchar(16) NOT NULL DEFAULT ('pending'),
  "storage_path" varchar(512),
  "status" varchar(16) NOT NULL DEFAULT ('active'),
  "version" integer NOT NULL DEFAULT (1),
  "created_by" varchar(64),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_ai_doc_tenant_hash" ON "t_ai_doc" ("tenant_id", "content_hash");
CREATE INDEX IF NOT EXISTS "t_ai_doc__idx_ai_doc_tenant_category" ON "t_ai_doc" ("tenant_id", "category");
CREATE INDEX IF NOT EXISTS "t_ai_doc__idx_ai_doc_tenant_status" ON "t_ai_doc" ("tenant_id", "status");

-- ── 2. 文档 ACL ──
CREATE TABLE IF NOT EXISTS "t_ai_doc_acl" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "doc_id" bigint NOT NULL,
  "principal_type" varchar(16) NOT NULL,
  "principal_id" varchar(64) NOT NULL,
  "perm" varchar(16) NOT NULL DEFAULT ('read'),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_ai_doc_acl_principal" ON "t_ai_doc_acl" ("doc_id", "principal_type", "principal_id");
CREATE INDEX IF NOT EXISTS "t_ai_doc_acl__idx_ai_doc_acl_doc" ON "t_ai_doc_acl" ("doc_id");
CREATE INDEX IF NOT EXISTS "t_ai_doc_acl__idx_ai_doc_acl_principal" ON "t_ai_doc_acl" ("tenant_id", "principal_type", "principal_id");

-- ── 3. 补建 RAG 分块表（暗坑：000 基线里没有，代码却在用） ──
-- 列严格对齐 vector-store.service.ts：tenant_id / doc_name / chunk_index / chunk_text / embedding / created_at
-- embedding 为 JSON 文本（JSON.stringify）⇒ sqlite 用 TEXT
CREATE TABLE IF NOT EXISTS "t_ai_knowledge_chunks" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "doc_name" varchar(255) NOT NULL,
  "chunk_index" integer NOT NULL,
  "chunk_text" text NOT NULL,
  "embedding" text,
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

CREATE INDEX IF NOT EXISTS "t_ai_knowledge_chunks__idx_kc_tenant_doc_name" ON "t_ai_knowledge_chunks" ("tenant_id", "doc_name");

-- 注：`doc_id` 列（可空）由 applier 条件加列 —— 见文件头说明
