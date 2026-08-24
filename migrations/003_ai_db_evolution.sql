-- AI 底座私有库 ai_db（P1-1）：先建库，再建 4 张进化表
CREATE DATABASE IF NOT EXISTS ai_db DEFAULT CHARACTER SET utf8mb4;

USE ai_db;

CREATE TABLE IF NOT EXISTS ai_experience (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_correction (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_sample (
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ai_evolution_version (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  artifact VARCHAR(64) NOT NULL,
  from_version VARCHAR(32),
  to_version VARCHAR(32) NOT NULL,
  change_summary TEXT,
  trigger VARCHAR(16) DEFAULT 'auto_learn',
  status VARCHAR(16) DEFAULT 'staged',
  approved_by VARCHAR(32),
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_evv_artifact (artifact),
  INDEX idx_evv_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
