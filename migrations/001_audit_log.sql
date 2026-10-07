-- 迁移 001：t_ai_audit_log 建表（补齐「全仓无 CREATE TABLE 却被 ALTER」的缺口）
-- 依据：src/database/entities/ai-audit-log.entity.ts（列名/类型/长度/nullable/default 逐字反推）
--
-- 背景：本表是 AI 调用审计明细（高频写入）。此前全仓没有任何 CREATE TABLE，
--       但 008 / 009 / 010 三处迁移都直接 ALTER 它。新环境从零部署时：
--         008 查 information_schema.COLUMNS 查不到 employee_uid ⇒ 判定需 ALTER
--         ⇒ 对不存在的表 ALTER ⇒ MySQL 报 ERROR 1146（表不存在）
--         ⇒ 1146 不在部署脚本的错误白名单内 ⇒ 整个 AI 底座部署被阻断。
--       本文件补上建表，使「按序全量重放 migrations」在空库上能跑通。
--
-- 幂等：CREATE TABLE IF NOT EXISTS（MySQL 8.0 支持），对已存在的表是 no-op，
--       因此不影响任何已执行过迁移的库，可安全重复执行。
--
-- 列归属（遵循 migrations/README.md「列归属约定」——同一列只由一处声明，避免类型冲突）：
--   本文件只声明实体基线列；
--   employee_uid       → 008_digital_employee.sql
--   lane / categories  → 009_audit_lane_categories.sql（categories 为 JSON）
--   triage_lane / triage_categories → 010_rating_and_triage.sql
--   按 001 → 008 → 009 → 010 顺序重放后，表结构与实体完全一致。
--
-- 索引：本文件建实体声明的 idx_tenant_id / idx_created_at / idx_tenant_created / idx_session；
--       idx_lane 由 009 补建（009 用 information_schema.STATISTICS 判定，重跑安全）。
--
-- ⚠️ 注释规范：行注释引导符后必须留一个空白，否则 MySQL 报 1064。

CREATE TABLE IF NOT EXISTS t_ai_audit_log (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id          VARCHAR(36)     NOT NULL                COMMENT '租户ID',
  user_id            VARCHAR(36)     NULL                    COMMENT '用户ID',
  session_id         VARCHAR(64)     NULL                    COMMENT '会话ID',
  provider           VARCHAR(32)     NULL                    COMMENT 'AI服务商',
  model              VARCHAR(64)     NULL                    COMMENT '模型名称',
  intent             VARCHAR(64)     NULL                    COMMENT '意图标签',
  user_message       TEXT            NULL                    COMMENT '用户消息原文',
  tool_calls         JSON            NULL                    COMMENT '工具调用记录（JSON数组）',
  prompt_tokens      INT             NOT NULL DEFAULT 0      COMMENT '提示Token数',
  completion_tokens  INT             NOT NULL DEFAULT 0      COMMENT '完成Token数',
  latency_ms         INT             NULL                    COMMENT '本次调用延迟毫秒',
  success            TINYINT         NOT NULL DEFAULT 1      COMMENT '是否成功: 1=成功 0=失败',
  error_message      TEXT            NULL                    COMMENT '错误信息（失败时记录）',
  created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  INDEX idx_tenant_id (tenant_id),
  INDEX idx_created_at (created_at),
  INDEX idx_tenant_created (tenant_id, created_at),
  INDEX idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI调用审计日志';
