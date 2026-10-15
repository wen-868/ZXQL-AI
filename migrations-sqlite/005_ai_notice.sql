-- R101-AI-40 步骤 1 · 桌面端（standalone）增量 005：站内通知表
--
-- 约定（R101-AI-30 乙案）：基线 000 不重生成；结构变更走增量；applier 自动按序应用（除 000）
-- 本文件**纯 DDL / 幂等**；新表 ⇒ 无需条件加列
--
-- 去重：唯一键 (tenant_id, dedupe_key)，但 dedupe_key 可空 ⇒ **业务幂等承重**（NULL 不判重）
-- receiver：首尾逗号归一化 principal 串 ⇒ 库层 LIKE '%,me,%' 边界匹配（与日程 participants 同款）
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS "t_ai_notice" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "receiver" text NOT NULL,
  "title" varchar(255) NOT NULL,
  "content" text,
  "type" varchar(32) NOT NULL,
  "priority" varchar(16) NOT NULL,
  "read_at" datetime(3),
  "archived_at" datetime(3),
  "source" varchar(16) NOT NULL DEFAULT ('system'),
  "ref_id" varchar(128),
  "dedupe_key" varchar(191),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- sqlite 索引名库级唯一（F9 教训）⇒ 统一表名前缀
CREATE UNIQUE INDEX IF NOT EXISTS "t_ai_notice__luk_ai_notice_dedupe"
  ON "t_ai_notice" ("tenant_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "t_ai_notice__idx_ai_notice_receiver"
  ON "t_ai_notice" ("tenant_id", "receiver");
CREATE INDEX IF NOT EXISTS "t_ai_notice__idx_ai_notice_unread"
  ON "t_ai_notice" ("tenant_id", "read_at");
CREATE INDEX IF NOT EXISTS "t_ai_notice__idx_ai_notice_created"
  ON "t_ai_notice" ("tenant_id", "created_at");
