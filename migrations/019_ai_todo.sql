-- 019 办公批次 2：待办表 t_ai_todo + ACL 通用化（t_ai_doc_acl → t_ai_acl）—— R101-AI-37 步骤 1
-- 依据：R101-AI-37 派单卡；设计裁定见凌舟 2026-10-16（ACL 方案①）
--
-- 一、本文件做两件事
--   1) 新建 `t_ai_todo`（办公待办/任务）
--   2) **ACL 通用化**：`t_ai_doc_acl` → `t_ai_acl`，`doc_id` → `resource_id`，新增 `resource_type`
--      ⇒ 待办/审批/日程**共用同一套权限判定**（不复制逻辑）
--
-- 二、为什么可以安全改名（这是方案①的前提）
--   - `t_ai_doc_acl` 由 018 在本批新建，**尚无任何数据**（实测 count=0）
--   ⇒ 列/表改名零数据迁移风险；趁 0 行把名字做对，避免留下"名不副实"的 `doc_id`
--
-- 三、幂等与执行
--   - 建表 `CREATE TABLE IF NOT EXISTS`；改名/加列走 `information_schema` + `PREPARE` 条件执行
--   - **本文件只写 + scratch 执行一次 + 幂等复跑一次**，不得在业务库/生产库执行
--   - 注释内不得出现分号（部署器按分号拆分语句）
--   - 执行：mysql -u<user> -p <业务库> < migrations/019_ai_todo.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-16

-- ═══════════════════ 1. ACL 通用化：t_ai_doc_acl → t_ai_acl ═══════════════════
-- 1.1 表改名（仅当旧表存在且新表不存在时）
SET @old_acl_exists := (
  SELECT COUNT(1) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_doc_acl'
);
SET @new_acl_exists := (
  SELECT COUNT(1) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl'
);

SET @acl_rename_ddl := IF(
  @old_acl_exists = 1 AND @new_acl_exists = 0,
  'RENAME TABLE t_ai_doc_acl TO t_ai_acl',
  'SELECT 1'
);

PREPARE acl_rename_stmt FROM @acl_rename_ddl;
EXECUTE acl_rename_stmt;
DEALLOCATE PREPARE acl_rename_stmt;

-- 1.2 列改名 doc_id → resource_id（仅当旧列存在且新列不存在时）
SET @doc_id_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl' AND COLUMN_NAME = 'doc_id'
);
SET @resource_id_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl' AND COLUMN_NAME = 'resource_id'
);

SET @acl_col_ddl := IF(
  @doc_id_exists = 1 AND @resource_id_exists = 0,
  'ALTER TABLE t_ai_acl CHANGE COLUMN doc_id resource_id BIGINT UNSIGNED NOT NULL COMMENT ''资源ID（doc/todo/... 的 id）''',
  'SELECT 1'
);

PREPARE acl_col_stmt FROM @acl_col_ddl;
EXECUTE acl_col_stmt;
DEALLOCATE PREPARE acl_col_stmt;

-- 1.3 新增 resource_type（默认 doc ⇒ 既有文档 ACL 语义不变）
SET @resource_type_exists := (
  SELECT COUNT(1) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl' AND COLUMN_NAME = 'resource_type'
);

SET @acl_type_ddl := IF(
  @resource_type_exists = 0,
  'ALTER TABLE t_ai_acl ADD COLUMN resource_type VARCHAR(16) NOT NULL DEFAULT ''doc'' COMMENT ''资源类型 doc/todo/approval/schedule''',
  'SELECT 1'
);

PREPARE acl_type_stmt FROM @acl_type_ddl;
EXECUTE acl_type_stmt;
DEALLOCATE PREPARE acl_type_stmt;

-- 1.4 通用唯一键（资源类型 + 资源 + 主体）——替换原 doc 维度的唯一键
SET @uk_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl'
     AND INDEX_NAME = 'uk_ai_acl_principal'
);
SET @uk_ddl := IF(
  @uk_exists = 0,
  'ALTER TABLE t_ai_acl ADD UNIQUE KEY uk_ai_acl_principal (resource_type, resource_id, principal_type, principal_id)',
  'SELECT 1'
);
PREPARE acl_uk_stmt FROM @uk_ddl;
EXECUTE acl_uk_stmt;
DEALLOCATE PREPARE acl_uk_stmt;

-- 1.5 通用索引（先租户、再资源）
SET @idx_exists := (
  SELECT COUNT(1) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 't_ai_acl'
     AND INDEX_NAME = 'idx_ai_acl_resource'
);
SET @idx_ddl := IF(
  @idx_exists = 0,
  'ALTER TABLE t_ai_acl ADD KEY idx_ai_acl_resource (tenant_id, resource_type, resource_id)',
  'SELECT 1'
);
PREPARE acl_idx_stmt FROM @idx_ddl;
EXECUTE acl_idx_stmt;
DEALLOCATE PREPARE acl_idx_stmt;

-- ═══════════════════ 2. 新建待办表 t_ai_todo ═══════════════════
CREATE TABLE IF NOT EXISTS t_ai_todo (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id   VARCHAR(36)  NOT NULL COMMENT '租户ID',
  title       VARCHAR(255) NOT NULL COMMENT '待办标题',
  description MEDIUMTEXT   NULL COMMENT '详细说明',
  assignee    VARCHAR(128) NOT NULL COMMENT '负责人（user:{id} 或 employee:{id}）',
  status      ENUM('pending','in_progress','done','cancelled') NOT NULL DEFAULT 'pending' COMMENT '状态',
  priority    ENUM('low','normal','high') NOT NULL DEFAULT 'normal' COMMENT '优先级',
  due_at      DATETIME(3)  NULL COMMENT '截止时间（可空；参与建单幂等键）',
  source      ENUM('user','ai','employee') NOT NULL DEFAULT 'user' COMMENT '来源',
  created_by  VARCHAR(64)  NULL COMMENT '创建者',
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间（毫秒）',
  updated_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '更新时间（毫秒）',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_todo_dedupe (tenant_id, title, assignee, due_at),
  KEY idx_ai_todo_assignee_status (tenant_id, assignee, status),
  KEY idx_ai_todo_due_at (tenant_id, due_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='办公-待办/任务';

-- 三、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--     ALTER TABLE t_ai_acl DROP COLUMN resource_type
--     ALTER TABLE t_ai_acl CHANGE COLUMN resource_id doc_id BIGINT UNSIGNED NOT NULL
--     RENAME TABLE t_ai_acl TO t_ai_doc_acl
--     DROP TABLE IF EXISTS t_ai_todo
--   注意：回滚会丢失待办与通用 ACL 数据，执行前须确认办公工具已下线并已导出备份
