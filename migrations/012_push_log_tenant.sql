-- 推送日志表补齐租户归属（阶段0 止血 B-1 前置，第九轮审查 A-5 假设证伪）
-- 依据：2026-10-07 第九轮审查 B-1 —— weekly-plan 的 SQL 无租户条件，
--       本计划预案 A-5 假设 t_push_log 已有 tenant_id 列；经查
--       backend/docs/migrations/066_add_push_log.sql 实锤**没有该列**
--       （user_id/template_id/push_type/channel/title/content/status/...），
--       且 AI 底座 proactive-push.service.ts 的 INSERT 也从未写入租户。
--       ⇒ B-1 的修法按预案升级为：先加列（本迁移），再同步写入与查询两侧。
--
-- 本迁移做两件事：
--   1) 加列 tenant_id（可空 —— 存量行无法回填归属，留 NULL；
--      NULL 行不属于任何租户，"WHERE tenant_id = ?" 永不命中，安全方向正确）
--   2) 加索引 idx_push_tenant（weekly-plan 按租户+时间窗查询）
--
-- ⚠️ 幂等：information_schema 判定 + PREPARE 动态 SQL（MySQL 兼容，可安全重跑）。
-- ⚠️ 依赖会话变量（PREPARE），本文件必须**整文件执行**，不可按分号拆分。

SET @main_db := DATABASE();

-- 1) 加列
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @main_db
      AND TABLE_NAME = 't_push_log'
      AND COLUMN_NAME = 'tenant_id') = 0,
  'ALTER TABLE t_push_log ADD COLUMN tenant_id VARCHAR(36) NULL COMMENT ''所属租户（迁移 012 补齐；AI 底座主动推送写入，存量行 NULL=无归属）'' AFTER user_id',
  'SELECT ''tenant_id 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 加索引
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = @main_db
      AND TABLE_NAME = 't_push_log'
      AND INDEX_NAME = 'idx_push_tenant') = 0,
  'ALTER TABLE t_push_log ADD INDEX idx_push_tenant (tenant_id, created_at)',
  'SELECT ''idx_push_tenant 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
