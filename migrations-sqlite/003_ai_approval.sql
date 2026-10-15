-- R101-AI-38 步骤 1 · 桌面端（standalone）增量 003：审批实例表
--
-- 约定（R101-AI-30 乙案）：基线 000 不重生成；结构变更走增量；applier 自动按序应用（除 000）
-- 本文件**纯 DDL / 幂等**（全部 IF NOT EXISTS）；本增量**无需条件加列**（新表）
--
-- 边界：AI 底座原生轻量审批；不替代 MS 审批；单级审批（多级/会签不做）
-- 负责人: 阿坚 | 创建日期: 2026-10-16

CREATE TABLE IF NOT EXISTS "t_ai_approval" (
  "id" integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  "tenant_id" varchar(36) NOT NULL,
  "title" varchar(255) NOT NULL,
  "type" varchar(64) NOT NULL,
  "applicant" varchar(128) NOT NULL,
  "approver" varchar(128) NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT ('draft'),
  "payload" text,
  "decision_reason" varchar(500),
  "related_biz" varchar(128),
  "created_by" varchar(64),
  "created_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  "updated_at" datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

-- sqlite 索引名是库级唯一（F9 教训）⇒ 统一表名前缀
CREATE UNIQUE INDEX IF NOT EXISTS "t_ai_approval__uk_ai_approval_dedupe"
  ON "t_ai_approval" ("tenant_id", "applicant", "type", "related_biz");
CREATE INDEX IF NOT EXISTS "t_ai_approval__idx_ai_approval_status"
  ON "t_ai_approval" ("tenant_id", "status");
CREATE INDEX IF NOT EXISTS "t_ai_approval__idx_ai_approval_applicant"
  ON "t_ai_approval" ("tenant_id", "applicant");
CREATE INDEX IF NOT EXISTS "t_ai_approval__idx_ai_approval_approver"
  ON "t_ai_approval" ("tenant_id", "approver", "status");
