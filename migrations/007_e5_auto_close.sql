-- E5 自治闭环：总台策略开关 + 进化版本回归评测结果落库
-- 依据：权威文档 26 章 E5（自动 staging→回归→激活闭环，策略显式开启，默认人工放行）
-- 依据：2026-09-05 工作文件核查——E5 框架此前为模拟实现，本迁移支撑真实评测与策略门控
--
-- ⚠️ 幂等改写（2026-09-27）：原脚本直接 `ALTER TABLE ... ADD COLUMN`（无 IF NOT EXISTS），
-- 重复执行会报 duplicate column。MySQL 8.0 也不支持 `ADD COLUMN IF NOT EXISTS`
-- （MariaDB 语法），故统一改为 information_schema 判定 + PREPARE 动态 SQL，
-- 兼容 MySQL 且可安全重跑。

SET @ai_db := DATABASE();

-- 1) 平台配置：E5 自治开关（默认 0=人工放行，总台显式开启后才自动激活/拦截）
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_platform_ai_config'
      AND COLUMN_NAME = 'evolution_auto_activate') = 0,
  'ALTER TABLE t_platform_ai_config ADD COLUMN evolution_auto_activate TINYINT(1) DEFAULT 0 COMMENT ''E5 自治开关：1=回归达标自动激活/未达标自动拦截 0=人工放行（默认）''',
  'SELECT ''evolution_auto_activate 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 进化版本：回归评测结果（基线=上一 active 版本最近一次评测值）
--    注意：ai_evolution_version 位于独立的 AI 私有库，本段是跨库 DDL，
--    库名统一取自 @ai_evo_db（默认 ai_db，与 003_ai_db_evolution.sql 建库名一致）。
--
--    ⚠️ 2026-10-08 修正：此前判定写 `TABLE_SCHEMA = 'ai_db'`、执行写 `ALTER TABLE ai_db.xxx`
--    两处各自硬编码库名 —— 私有库改名（如新客户私有化部署不叫 ai_db）时必须同时改两处，
--    漏改一处就会出现「判定库与执行库不一致」的静默失效。现收敛为单一变量：
--    改名只需改上面这一行，判定与执行必然同源。
--    ⚠️ 未改成直接用 @ai_db（= DATABASE()，即业务库）：本文件按 README 的操作手册
--    是「对业务库执行一次」，业务库里并没有 ai_evolution_version，若按 @ai_db 执行
--    会对不存在的表 ALTER ⇒ ERROR 1146。故本段仍必须指向 AI 私有库。
SET @ai_evo_db := 'ai_db';

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_evo_db
      AND TABLE_NAME = 'ai_evolution_version'
      AND COLUMN_NAME = 'regression_accuracy') = 0,
  CONCAT('ALTER TABLE ', @ai_evo_db, '.ai_evolution_version ADD COLUMN regression_accuracy DECIMAL(5, 4) NULL COMMENT ''最近一次 E5 回归评测准确率（0-1）'''),
  'SELECT ''regression_accuracy 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_evo_db
      AND TABLE_NAME = 'ai_evolution_version'
      AND COLUMN_NAME = 'regression_evaluated_at') = 0,
  CONCAT('ALTER TABLE ', @ai_evo_db, '.ai_evolution_version ADD COLUMN regression_evaluated_at DATETIME NULL COMMENT ''最近一次回归评测时间'''),
  'SELECT ''regression_evaluated_at 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
