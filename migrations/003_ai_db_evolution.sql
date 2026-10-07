-- AI 底座私有库 ai_db（P1-1）：先建库，再建 4 张进化表
--
-- ⚠️ 跨库引用口径（2026-10-08 全链统一，见 migrations/README.md §二.6）：
--   本仓一律 **显式库名限定** `ai_db.<table>`，**不使用 `USE ai_db;`**。
--   为什么不用 USE：`USE` 改的是**会话当前库**，而部署脚本是一个文件一条连接、
--   按 NNN 顺序投放（`mysql <db> < 文件`）。一旦某文件以 `USE ai_db;` 收尾，
--   若连接被复用或脚本按分号拆分执行，后续本该落在业务库的语句会**静默落进 ai_db**。
--   显式限定与会话当前库无关，可安全重复执行、也便于 `rg -n 'ai_db\.'` 全量审计。
--   库名由本文件第 1 条语句固定；若私有库需改名，改这里 + 全仓 `rg -n 'ai_db\.'` 的全部命中点。
--
-- ⚠️ 这 4 张表是 AI 底座**独占**的（管理系统仓 docs/migrations 内无同名建表），
--   与业务库侧表物理隔离；不建任何物理外键，租户/任务只做逻辑关联。

CREATE DATABASE IF NOT EXISTS ai_db DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_db.ai_experience (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(32) NOT NULL,
  domain VARCHAR(16) NOT NULL,
  intent VARCHAR(64),
  input_hash CHAR(32),
  trajectory TEXT,
  outcome VARCHAR(16) NOT NULL,
  adopted TINYINT DEFAULT NULL,
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_exp_tenant (tenant_id),
  INDEX idx_exp_domain (domain),
  INDEX idx_exp_input_hash (input_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_db.ai_correction (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(32) NOT NULL,
  task_type VARCHAR(64) NOT NULL,
  wrong_payload JSON,
  right_payload JSON,
  reason VARCHAR(255),
  applied_to_version VARCHAR(32),
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_corr_tenant (tenant_id),
  INDEX idx_corr_type (task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_db.ai_sample (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(32) NOT NULL,
  task_type VARCHAR(64) NOT NULL,
  prompt TEXT,
  completion TEXT,
  quality TINYINT DEFAULT 1,
  used_for_training TINYINT DEFAULT 0,
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_sample_tenant (tenant_id),
  INDEX idx_sample_type (task_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_db.ai_evolution_version (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  artifact VARCHAR(64) NOT NULL,
  from_version VARCHAR(32),
  to_version VARCHAR(32) NOT NULL,
  change_summary TEXT,
  trigger_type VARCHAR(16) DEFAULT 'auto_learn',
  status VARCHAR(16) DEFAULT 'staged',
  approved_by VARCHAR(32),
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_evv_artifact (artifact),
  INDEX idx_evv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
