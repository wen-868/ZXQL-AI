-- 数字员工评分回流产品化 + 审计意图分诊埋点
-- 依据：12.8.3 🟢 可随时做清单（办公任务评分闭环产品化 + 跨域占比取证前置）
-- 提交 a4e7674；本文件 2026-10-03 三处修正（见下方说明）
--
-- ⚠️ 本次修正（2026-10-03，QA 核查）：
-- 1. 文件名从 009_ 改为 010_：原 009_ 与 009_audit_lane_categories.sql 序号冲突，
--    违反 migrations/README.md「NNN 三位递增」规范；
-- 2. 幂等：原为裸 `ALTER TABLE ADD COLUMN`，重跑报 duplicate column。改为与 007/008/009
--    一致的 information_schema 判定 + PREPARE 动态 SQL（MySQL 兼容，可安全重复执行）；
-- 3. 去掉 `lane` / `categories` 两列：这两个列已由 009_audit_lane_categories.sql 负责
--    （`lane` VARCHAR(16)、`categories` **JSON**，与实体 ai-audit-log.entity.ts 对齐）。
--    原文件在本文件里再声明一次且 `categories` 写成 VARCHAR(255) —— 与实体的
--    `type: 'json'` 冲突，且两个文件谁先执行会导致最终列类型不确定。本文件只补
--    自己独占的 triage_* 两列。
--
-- ⚠️ 依赖会话变量（PREPARE），本文件必须**整文件执行**，不可按分号拆分到多连接逐条执行。

SET @ai_db := DATABASE();

-- 1) 员工任务表：任务类型（派发时意图域）+ 评分回流结果
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_employee_task'
      AND COLUMN_NAME = 'task_type') = 0,
  'ALTER TABLE t_ai_employee_task ADD COLUMN task_type VARCHAR(64) NULL COMMENT ''任务类型（派发时意图域）''',
  'SELECT ''task_type 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_employee_task'
      AND COLUMN_NAME = 'rating_result') = 0,
  'ALTER TABLE t_ai_employee_task ADD COLUMN rating_result VARCHAR(16) NULL COMMENT ''评分回流结果：sample/correction''',
  'SELECT ''rating_result 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 审计表：意图分诊埋点（跨域占比统计与岗位化 ROI 度量的数据源）
--    注：lane / categories 由 009_audit_lane_categories.sql 负责，此处不重复声明。
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_audit_log'
      AND COLUMN_NAME = 'triage_lane') = 0,
  'ALTER TABLE t_ai_audit_log ADD COLUMN triage_lane VARCHAR(16) NULL COMMENT ''意图分诊通道：rules/llm/chat/fallback''',
  'SELECT ''triage_lane 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_audit_log'
      AND COLUMN_NAME = 'triage_categories') = 0,
  'ALTER TABLE t_ai_audit_log ADD COLUMN triage_categories VARCHAR(128) NULL COMMENT ''分诊业务域（逗号分隔）''',
  'SELECT ''triage_categories 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
