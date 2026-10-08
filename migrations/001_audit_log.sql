-- 迁移 001：t_ai_audit_log **存在性断言**（不再建表）
--
-- 🔴 裁定（凌舟 R101 验收回执 §四，2026-10-08，已拍板）：
--   `t_ai_audit_log` 归**管理系统仓**所有（`wen-ssystem/docs/migrations/121_ai_base_tables.sql:58`）。
--   本仓**撤销建表**，只做「读不建」。理由四条：
--     1) 表在业务库 ⇒ 业务库 schema 归业务仓，与其它业务表同源；
--        两条链路各建同名表必然结构性漂移（同一概念多个副本是本域反复出问题的病根）；
--     2) 归属单一后「列变更」只有一个落点，AI 底座不再有第二个改建入口；
--     3) 撤销**不是删文件**：本文件保留为断言脚本，并保留下方列归属约定作为文档；
--     4) 顺序依赖：管理系统仓迁移（后端启动期 runMigrations）**先于** AI 底座迁移，
--        当前部署顺序已满足。
--
-- 本文件行为（information_schema.TABLES 判定 TABLE_SCHEMA = DATABASE()，即当前库=业务库）：
--   表存在   → 打印「已存在，跳过建表（归属：管理系统仓 121）」，EXIT=0
--   表不存在 → 打印「该表应由管理系统仓 121_ai_base_tables.sql 建立；AI 底座不建表」，EXIT=0
--   ⚠️ 两个分支都是 EXIT=0：这是「存在性断言」的语义，不是 DDL 迁移。
--      缺表**不会**被本脚本吞成假绿 —— 两个分支都打印，运维在部署日志里看得见；
--      且结构完整性由 `/api/health/ready` 就绪探针终判（缺失表会报 degraded）。
--      对比：003/007 这类**结构必需**的 DDL 脚本缺表仍必须报错让部署红（见 README §二.6）。
--
-- ⚠️ 依赖会话变量，整文件执行：`mysql -u<user> -p<pass> <业务库> < migrations/001_audit_log.sql`。
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 【文档，勿执行】以下是本文件**撤销前**的建表语句，仅作为列归属约定的存档。
-- 建表职责已移交管理系统仓 121_ai_base_tables.sql:58（列集合与下述逐字一致）。
-- 下方语句已被全部注释掉，不在可执行区。
--
--   CREATE TABLE IF NOT EXISTS t_ai_audit_log (
--     id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
--     tenant_id          VARCHAR(36)     NOT NULL                COMMENT '租户ID',
--     user_id            VARCHAR(36)     NULL                    COMMENT '用户ID',
--     session_id         VARCHAR(64)     NULL                    COMMENT '会话ID',
--     provider           VARCHAR(32)     NULL                    COMMENT 'AI服务商',
--     model              VARCHAR(64)     NULL                    COMMENT '模型名称',
--     intent             VARCHAR(64)     NULL                    COMMENT '意图标签',
--     user_message       TEXT            NULL                    COMMENT '用户消息原文',
--     tool_calls         JSON            NULL                    COMMENT '工具调用记录（JSON数组）',
--     prompt_tokens      INT             NOT NULL DEFAULT 0      COMMENT '提示Token数',
--     completion_tokens  INT             NOT NULL DEFAULT 0      COMMENT '完成Token数',
--     latency_ms         INT             NULL                    COMMENT '本次调用延迟毫秒',
--     success            TINYINT         NOT NULL DEFAULT 1      COMMENT '是否成功: 1=成功 0=失败',
--     error_message      TEXT            NULL                    COMMENT '错误信息（失败时记录）',
--     created_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
--     updated_at         DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
--     PRIMARY KEY (id),
--     INDEX idx_tenant_id (tenant_id),
--     INDEX idx_created_at (created_at),
--     INDEX idx_tenant_created (tenant_id, created_at),
--     INDEX idx_session (session_id)
--   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI调用审计日志'
--   （上面刻意不写句末分号：README §二.2 要求迁移文件可被按分号拆分执行，注释里的分号会破坏拆分）
--
-- 【文档】列归属（遵循 migrations/README.md「列归属约定」—— 同一列只由一处声明，避免类型冲突）：
--   实体基线 16 列（含上述建表语句）→ 管理系统仓 121_ai_base_tables.sql:58
--   employee_uid                                → 008_digital_employee.sql（业务库侧 ALTER）
--   lane / categories（categories 为 JSON）    → 009_audit_lane_categories.sql
--   triage_lane / triage_categories             → 010_rating_and_triage.sql
--   按 管理系统仓 121 → 008 → 009 → 010 顺序重放后，表结构与实体完全一致
--   （001 已不建表，故序列里不再出现 001）
--
-- 【文档】索引：基线 idx_tenant_id / idx_created_at / idx_tenant_created / idx_session 由 121 建；
--         idx_lane 由 009 补建（009 用 information_schema.STATISTICS 判定，重跑安全）。
--
-- ⚠️ 注释规范：行注释引导符后必须留一个空白，否则 MySQL 报 1064。

-- 存在性断言：表在当前库（业务库）中是否存在
SET @ai_db := DATABASE();
SET @t_ai_audit_log_exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = @ai_db
     AND TABLE_NAME   = 't_ai_audit_log'
);

SET @ddl := IF(
  @t_ai_audit_log_exists > 0,
  'SELECT ''t_ai_audit_log 已存在，跳过建表（归属：管理系统仓 121_ai_base_tables.sql）'' AS assert_result',
  'SELECT ''t_ai_audit_log 不存在：该表应由管理系统仓 121_ai_base_tables.sql 建立；AI 底座不建表'' AS assert_result'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;