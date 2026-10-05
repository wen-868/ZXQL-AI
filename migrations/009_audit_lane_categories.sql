-- 取证埋点（方案 12.4）：审计记录补 lane / categories
-- 用途：统计「跨域占比 = 涉及 ≥2 业务域的任务占比」，为是否从 MVP 扩展
--       流水线编排提供数据依据（占比高→扩展，占比低→MVP 即稳态）。
-- lane：执行车道（此前无字段，只能按 intent 反推）
-- categories：本次调用触及的业务域（ToolCategory 数组，去重）
--
-- ⚠️ 幂等写法（2026-09-27 修正）：MySQL 8.0 **不支持** `ADD COLUMN IF NOT EXISTS`
-- 与 `ADD INDEX IF NOT EXISTS`（那是 MariaDB 语法）。本仓数据库为 MySQL
-- （见 src/database/database.module.ts 的 `type: 'mysql'`），此前按 MariaDB 语法
-- 写的版本在生产执行会直接语法报错。改用 information_schema 判定 + PREPARE
-- 动态 SQL：既幂等、又兼容 MySQL，可安全重复执行。

SET @ai_db := DATABASE();

-- 1) lane：执行车道
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_audit_log'
      AND COLUMN_NAME = 'lane') = 0,
  'ALTER TABLE t_ai_audit_log ADD COLUMN lane VARCHAR(16) NULL COMMENT ''执行车道：chat/agent/graph/proactive/evidence/tool''',
  'SELECT ''lane 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) categories：触及的业务域（ToolCategory 数组，去重）
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_audit_log'
      AND COLUMN_NAME = 'categories') = 0,
  'ALTER TABLE t_ai_audit_log ADD COLUMN categories JSON NULL COMMENT ''触及的业务域（ToolCategory 数组，去重）''',
  'SELECT ''categories 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 按车道聚合统计（跨域占比与车道分布均以此为分组键）
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_audit_log'
      AND INDEX_NAME = 'idx_lane') = 0,
  'ALTER TABLE t_ai_audit_log ADD INDEX idx_lane (lane)',
  'SELECT ''idx_lane 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
