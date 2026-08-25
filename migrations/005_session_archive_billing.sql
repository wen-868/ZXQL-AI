-- A4：会话冷备归档表（文档 12.5，L2 冷存储）
CREATE TABLE IF NOT EXISTS t_ai_session_archive (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  session_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32),
  messages_json JSON,
  message_count INT DEFAULT 0,
  started_at DATETIME,
  ended_at DATETIME,
  created_at DATETIME DEFAULT NOW(),
  INDEX idx_archive_session (session_id),
  INDEX idx_archive_tenant_user (tenant_id, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- B5：租户计费表增加预付费余额（决策 20 运行时扣减）
ALTER TABLE t_tenant_ai_billing
  ADD COLUMN balance DECIMAL(12,2) DEFAULT 0.00
  COMMENT '预付费余额（元）'
  AFTER enabled;
