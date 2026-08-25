-- 22.7：Agent 自主执行内核新增表（业务库侧，断点续跑）
-- 依据：docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md 第 22.7 节
CREATE TABLE IF NOT EXISTS ai_execution_plan (
  id INT PRIMARY KEY AUTO_INCREMENT,
  tenant_id VARCHAR(32) NOT NULL,
  goal TEXT,
  steps TEXT,
  state ENUM('pending','running','success','failed','suspended','skipped') DEFAULT 'pending',
  created_by VARCHAR(32),
  created_at DATETIME DEFAULT NOW(),
  updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
