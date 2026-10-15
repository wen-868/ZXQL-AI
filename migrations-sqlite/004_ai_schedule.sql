-- R101-AI-39 步骤 1 · 桌面端（standalone）增量 004：日程表
--
-- 约定（R101-AI-30 乙案）：基线 000 不重生成；结构变更走增量；applier 自动按序应用（除 000）
-- 本文件**纯 DDL / 幂等**；新表 ⇒ 无需条件加列
--
-- 幂等键：唯一键取**全 NOT NULL 四列** `(tenant_id, title, owner, start_at)`
--   ⇒ DB 层有效（含 NULL 的唯一键不判重 ⇒ 刻意不让可空列进键）
-- 提醒：复用既有 proactive 推送 + @Cron；`reminded_at` 为提醒幂等标记
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS "t_ai_schedule" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "title" varchar(255) NOT NULL,
  "start_at" datetime(3) NOT NULL,
  "end_at" datetime(3),
  "owner" varchar(128) NOT NULL,
  "participants" text,
  "status" varchar(16) NOT NULL DEFAULT ('planned'),
  "remind_at" datetime(3),
  "reminded_at" datetime(3),
  "source" varchar(16) NOT NULL DEFAULT ('ai'),
  "created_by" varchar(64),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- sqlite 索引名库级唯一（F9 教训）⇒ 统一表名前缀
CREATE UNIQUE INDEX IF NOT EXISTS "t_ai_schedule__luk_ai_schedule_dedupe"
  ON "t_ai_schedule" ("tenant_id", "title", "owner", "start_at");
CREATE INDEX IF NOT EXISTS "t_ai_schedule__idx_ai_schedule_start_at"
  ON "t_ai_schedule" ("tenant_id", "start_at");
CREATE INDEX IF NOT EXISTS "t_ai_schedule__idx_ai_schedule_owner_status"
  ON "t_ai_schedule" ("tenant_id", "owner", "status");
CREATE INDEX IF NOT EXISTS "t_ai_schedule__idx_ai_schedule_remind"
  ON "t_ai_schedule" ("tenant_id", "status", "remind_at");
