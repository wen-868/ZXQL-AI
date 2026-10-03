-- 员工任务表补齐租户归属（安全修复 P1-5）
-- 依据：2026-10-04 审查报告 P1-5 —— t_ai_employee_task 只有 employeeId、无 tenantId，
--       而 getTaskById / completeTask / markTaskRated 均按自增 id 裸查裸改：
--       评分端点 office-evolution.rate() 可枚举别家租户的任务，将其 task/resultSummary
--       原文写进自己的 ai_sample / ai_correction 样本池（泄漏 + 投毒双重）。
--
-- 本迁移做三件事：
--   1) 加列 tenant_id（可空 —— 存量表不能直接 NOT NULL，否则加列失败）
--   2) 加索引 idx_emp_task_tenant（与实体 @Index 对齐）
--   3) 回填历史行：按 employee_id 关联 t_ai_employee 推导租户
--      （员工表本身有 tenant_id，可无损回填；回填不到的孤儿行留 NULL，
--        由服务侧"按 id 操作必须显式带租户"的校验挡住，不会被误读成公共资源）
--
-- ⚠️ 幂等：information_schema 判定 + PREPARE 动态 SQL（MySQL 兼容，可安全重跑）。
-- ⚠️ 依赖会话变量（PREPARE）与 @ai_db，本文件必须**整文件执行**，
--    不可按分号拆分到多连接逐条执行。

SET @ai_db := DATABASE();

-- 1) 加列
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_employee_task'
      AND COLUMN_NAME = 'tenant_id') = 0,
  'ALTER TABLE t_ai_employee_task ADD COLUMN tenant_id VARCHAR(32) NULL COMMENT ''所属租户（迁移 011 补齐；历史行回填后非空）''',
  'SELECT ''tenant_id 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 索引（判定 information_schema.STATISTICS，重跑不报 duplicate key）
SET @idx_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_ai_employee_task'
      AND INDEX_NAME = 'idx_emp_task_tenant'
);
SET @ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE t_ai_employee_task ADD INDEX idx_emp_task_tenant (tenant_id)',
  'SELECT ''idx_emp_task_tenant 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 回填历史行（按员工表推导租户；幂等，重复执行只会更新仍为 NULL 的行）
UPDATE t_ai_employee_task t
  JOIN t_ai_employee e ON e.id = t.employee_id
   SET t.tenant_id = e.tenant_id
 WHERE t.tenant_id IS NULL;

-- 回填结果提示（运维执行时可见：应显示 0 行待回填）
SELECT
  (SELECT COUNT(*) FROM t_ai_employee_task WHERE tenant_id IS NULL) AS remaining_null_tenant_rows,
  (SELECT COUNT(*) FROM t_ai_employee_task) AS total_task_rows;
