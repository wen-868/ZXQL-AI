CREATE TABLE IF NOT EXISTS t_mcp_token (
  id          INT PRIMARY KEY AUTO_INCREMENT,
  tenant_id   VARCHAR(32) NOT NULL,
  token       VARCHAR(128) NOT NULL UNIQUE,
  name        VARCHAR(64),
  enabled     TINYINT(1) DEFAULT 1,
  expires_at  DATETIME,
  created_at  DATETIME DEFAULT NOW(),
  updated_at  DATETIME DEFAULT NOW() ON UPDATE NOW(),
  INDEX idx_mcp_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
