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
--
-- P2 幂等改写（2026-10-06）：原脚本直接 `ALTER TABLE ... ADD COLUMN`
-- （无 information_schema 判定），生产已应用过，重放报 1060 Duplicate column。
-- MySQL 8.0 不支持 `ADD COLUMN IF NOT EXISTS`（MariaDB 语法），
-- 故改为 information_schema 判定 + PREPARE 动态 SQL，可安全重复执行。

SET @ai_db := DATABASE();

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_tenant_ai_billing'
      AND COLUMN_NAME = 'balance') = 0,
  'ALTER TABLE t_tenant_ai_billing ADD COLUMN balance DECIMAL(12,2) DEFAULT 0.00 COMMENT ''预付费余额（元）'' AFTER enabled',
  'SELECT ''balance 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;