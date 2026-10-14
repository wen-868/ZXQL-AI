-- R101-AI-30 standalone 单基线（乙案）
--
-- 生成方式：node scripts/sqlite-baseline/generate-baseline.cjs
-- 方言：better-sqlite3（INTEGRATION_MODE=standalone）
-- 覆盖：AI_ENTITIES 全部实体（含 F1 char→varchar / F2 mediumtext→text /
--       F3 bigint 主键→integer / F8 enum→varchar 的最终形态）
--
-- ⚠️ 本文件是**桌面端首次建库**的唯一基线；后续结构变更请新增增量脚本
--    （migrations-sqlite/001_xxx.sql），**不要**重新生成 000 覆盖。
--
-- 注意：MySQL/云端形态**不使用**本文件（生产仍走 migrations/ 的 17 个迁移）。

CREATE TABLE "t_ai_audit_log" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "user_id" varchar(36), "session_id" varchar(64), "provider" varchar(32), "model" varchar(64), "intent" varchar(64), "lane" varchar(16), "categories" json, "employee_uid" varchar(40), "user_message" text, "triage_lane" varchar(16), "triage_categories" varchar(128), "tool_calls" json, "prompt_tokens" integer NOT NULL DEFAULT (0), "completion_tokens" integer NOT NULL DEFAULT (0), "latency_ms" integer, "success" tinyint NOT NULL DEFAULT (1), "error_message" text, "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_audit_log__idx_session" ON "t_ai_audit_log" ("session_id");

CREATE INDEX "t_ai_audit_log__idx_tenant_created" ON "t_ai_audit_log" ("tenant_id", "created_at");

CREATE INDEX "t_ai_audit_log__idx_created_at" ON "t_ai_audit_log" ("created_at");

CREATE INDEX "t_ai_audit_log__idx_tenant_id" ON "t_ai_audit_log" ("tenant_id");

CREATE TABLE "t_ai_usage_daily" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "stat_date" date NOT NULL, "chat_count" integer NOT NULL DEFAULT (0), "tool_call_count" integer NOT NULL DEFAULT (0), "prompt_tokens" bigint NOT NULL DEFAULT (0), "completion_tokens" bigint NOT NULL DEFAULT (0), "total_tokens" bigint NOT NULL DEFAULT (0), "prompt_cost" decimal(12,4) NOT NULL DEFAULT (0), "completion_cost" decimal(12,4) NOT NULL DEFAULT (0), "total_cost" decimal(12,4) NOT NULL DEFAULT (0), "provider" varchar(32) NOT NULL DEFAULT ('unknown'), "model" varchar(64) NOT NULL DEFAULT ('unknown'), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE UNIQUE INDEX "uk_tenant_date_provider" ON "t_ai_usage_daily" ("tenant_id", "stat_date", "provider");

CREATE INDEX "t_ai_usage_daily__idx_date" ON "t_ai_usage_daily" ("stat_date");

CREATE INDEX "t_ai_usage_daily__idx_tenant_date" ON "t_ai_usage_daily" ("tenant_id", "stat_date");

CREATE INDEX "t_ai_usage_daily__idx_tenant_created" ON "t_ai_usage_daily" ("tenant_id", "created_at");

CREATE INDEX "t_ai_usage_daily__idx_created_at" ON "t_ai_usage_daily" ("created_at");

CREATE INDEX "t_ai_usage_daily__idx_tenant_id" ON "t_ai_usage_daily" ("tenant_id");

CREATE TABLE "t_platform_ai_config" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "default_provider" varchar(32) NOT NULL DEFAULT ('glm'), "default_model" varchar(64) NOT NULL DEFAULT ('glm-4-flash'), "default_api_key" varchar(512), "default_endpoint" varchar(255), "default_temperature" decimal(2,1) NOT NULL DEFAULT (0.3), "default_max_tokens" integer NOT NULL DEFAULT (2048), "default_system_prompt" text, "ollama_fallback_enabled" tinyint NOT NULL DEFAULT (1), "evolution_auto_activate" tinyint NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE TABLE "t_tenant_ai_config" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "enabled" tinyint NOT NULL DEFAULT (1), "provider" varchar(32) NOT NULL DEFAULT ('glm'), "api_key" varchar(512), "api_endpoint" varchar(255), "model" varchar(64) NOT NULL DEFAULT ('glm-4-flash'), "temperature" decimal(2,1) NOT NULL DEFAULT (0.3), "max_tokens" integer NOT NULL DEFAULT (2048), "system_prompt" text, "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_b348564a220e73396635757547e" UNIQUE ("tenant_id"));

CREATE INDEX "t_tenant_ai_config__idx_tenant_created" ON "t_tenant_ai_config" ("tenant_id", "created_at");

CREATE INDEX "t_tenant_ai_config__idx_created_at" ON "t_tenant_ai_config" ("created_at");

CREATE INDEX "t_tenant_ai_config__idx_tenant_id" ON "t_tenant_ai_config" ("tenant_id");

CREATE TABLE "t_tenant_ai_billing" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "plan_type" varchar(32) NOT NULL DEFAULT ('pay_as_you_go'), "free_chat_count" integer NOT NULL DEFAULT (100), "free_token_limit" bigint NOT NULL DEFAULT (100000), "overage_price" decimal(10,6) NOT NULL DEFAULT (0.001), "monthly_chat_limit" integer NOT NULL DEFAULT (0), "monthly_token_limit" bigint NOT NULL DEFAULT (0), "monthly_price" decimal(10,2) NOT NULL DEFAULT (0), "enabled" tinyint NOT NULL DEFAULT (1), "balance" decimal(12,2) NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_a218f6870fc15eec49273321986" UNIQUE ("tenant_id"));

CREATE INDEX "t_tenant_ai_billing__idx_tenant_created" ON "t_tenant_ai_billing" ("tenant_id", "created_at");

CREATE INDEX "t_tenant_ai_billing__idx_created_at" ON "t_tenant_ai_billing" ("created_at");

CREATE INDEX "t_tenant_ai_billing__idx_tenant_id" ON "t_tenant_ai_billing" ("tenant_id");

CREATE TABLE "t_ai_external_model" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" varchar(64) NOT NULL, "display_name" varchar(128) NOT NULL, "provider_base_url" varchar(255) NOT NULL, "api_key" varchar(512), "model_name" varchar(128) NOT NULL, "enabled" tinyint NOT NULL DEFAULT (1), "sort_order" integer NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE UNIQUE INDEX "uk_external_model_name" ON "t_ai_external_model" ("name");

CREATE TABLE "t_ai_model_price" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "provider" varchar(32) NOT NULL, "model" varchar(64) NOT NULL, "prompt_price" decimal(12,6) NOT NULL, "completion_price" decimal(12,6) NOT NULL, "currency" varchar(3) NOT NULL DEFAULT ('CNY'), "effective_from" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "enabled" tinyint NOT NULL DEFAULT (1), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_model_price__idx_ai_model_price_lookup" ON "t_ai_model_price" ("provider", "model", "enabled", "effective_from");

CREATE UNIQUE INDEX "uk_ai_model_price_provider_model_effective" ON "t_ai_model_price" ("provider", "model", "effective_from");

CREATE TABLE "t_ai_review_task" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "session_id" varchar(64), "graph_id" varchar(64), "node_id" varchar(64), "tool_name" varchar(64), "payload" json, "status" varchar(20) NOT NULL DEFAULT ('pending'), "reject_reason" varchar(500), "created_by" varchar(64), "reviewed_by" varchar(64), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "reviewed_at" datetime);

CREATE INDEX "t_ai_review_task__idx_review_tenant_status" ON "t_ai_review_task" ("tenant_id");

CREATE TABLE "t_ai_ltm_profile" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "entity_type" varchar(32) NOT NULL DEFAULT ('tenant'), "entity_id" varchar(64), "k" varchar(128) NOT NULL, "v_json" json, "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE UNIQUE INDEX "uk_ltm_profile" ON "t_ai_ltm_profile" ("tenant_id");

CREATE TABLE "t_ai_ltm_episodic" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "summary" varchar(1000), "what" varchar(1000), "why" varchar(1000), "outcome" varchar(32), "score" integer NOT NULL DEFAULT (0), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_ltm_episodic__idx_ltm_episodic_tenant" ON "t_ai_ltm_episodic" ("tenant_id");

CREATE TABLE "t_ai_ltm_archival" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "title" varchar(255) NOT NULL, "body" text, "source" varchar(64), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_ltm_archival__idx_ltm_archival_tenant" ON "t_ai_ltm_archival" ("tenant_id");

CREATE TABLE "t_ai_learning_log" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "exp_id" bigint, "hint_key" varchar(64), "applied_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "effect" varchar(32), "note" varchar(500));

CREATE INDEX "t_ai_learning_log__idx_learning_tenant" ON "t_ai_learning_log" ("tenant_id");

CREATE TABLE "t_ai_evolution" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "target" varchar(16) NOT NULL, "version" integer NOT NULL DEFAULT (1), "status" varchar(20) NOT NULL DEFAULT ('proposed'), "current_snapshot" text, "proposed_diff" text, "rationale" varchar(1000), "review_id" bigint, "gray_percent" integer NOT NULL DEFAULT (0), "proposed_by" varchar(64), "reviewed_by" varchar(64), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "rolled_out_at" datetime);

CREATE INDEX "t_ai_evolution__idx_evolution_tenant" ON "t_ai_evolution" ("tenant_id");

CREATE TABLE "t_mcp_token" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(32) NOT NULL, "token" varchar(128) NOT NULL, "name" varchar(64), "enabled" tinyint NOT NULL DEFAULT (1), "expires_at" datetime, "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_mcp_token__idx_mcp_tenant" ON "t_mcp_token" ("tenant_id");

CREATE UNIQUE INDEX "uk_mcp_token" ON "t_mcp_token" ("token");

CREATE TABLE "t_ai_session_archive" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "session_id" varchar(64) NOT NULL, "tenant_id" varchar(32) NOT NULL, "user_id" varchar(32), "messages_json" json, "message_count" integer NOT NULL DEFAULT (0), "started_at" datetime, "ended_at" datetime, "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_session_archive__idx_archive_session" ON "t_ai_session_archive" ("session_id");

CREATE INDEX "t_ai_session_archive__idx_archive_tenant_user" ON "t_ai_session_archive" ("tenant_id");

CREATE TABLE "ai_execution_plan" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(32) NOT NULL, "goal" text, "steps" text, "state" varchar CHECK( "state" IN ('pending','running','success','failed','suspended','skipped') ) NOT NULL DEFAULT ('pending'), "created_by" varchar(32), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "ai_execution_plan__idx_tenant" ON "ai_execution_plan" ("tenant_id");

CREATE TABLE "t_ai_idempotency" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(36) NOT NULL, "tool_name" varchar(64) NOT NULL, "idem_key" varchar(64) NOT NULL, "key_source" varchar(16) NOT NULL, "status" varchar(16) NOT NULL DEFAULT ('in_flight'), "result_json" text, "error_text" varchar(512), "first_seen_at" datetime NOT NULL, "completed_at" datetime, "created_at" datetime NOT NULL, "updated_at" datetime NOT NULL);

CREATE TABLE "t_ai_dead_letter" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "op" varchar(64) NOT NULL, "tenant_id" varchar(36), "detail" text, "error" text NOT NULL, "stack" text, "level" varchar(16) NOT NULL DEFAULT ('best_effort'), "at" datetime(3) NOT NULL, "created_at" datetime NOT NULL);

CREATE TABLE "t_ai_employee" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(32) NOT NULL, "employee_uid" varchar(40) NOT NULL, "name" varchar(64) NOT NULL, "post" varchar(64) NOT NULL, "department" varchar(64) NOT NULL, "persona_prompt" text, "tool_categories" json, "data_scope" json, "dispatch_uids" json, "reply_style" varchar(128), "status" tinyint NOT NULL DEFAULT (1), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), "updated_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_employee__idx_emp_tenant" ON "t_ai_employee" ("tenant_id");

CREATE INDEX "t_ai_employee__idx_emp_uid" ON "t_ai_employee" ("employee_uid");

CREATE TABLE "t_ai_employee_task" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "tenant_id" varchar(32), "employee_id" integer NOT NULL, "task" text NOT NULL, "dispatched_by" varchar(64) NOT NULL DEFAULT ('user'), "result_summary" text, "status" varchar(16) NOT NULL DEFAULT ('running'), "task_type" varchar(64), "rating_result" varchar(16), "created_at" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP));

CREATE INDEX "t_ai_employee_task__idx_emp_task_tenant" ON "t_ai_employee_task" ("tenant_id");

CREATE INDEX "t_ai_employee_task__idx_emp_task_emp" ON "t_ai_employee_task" ("employee_id");
