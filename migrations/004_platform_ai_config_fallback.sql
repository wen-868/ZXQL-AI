-- P1-3：平台 AI 配置增加「本地 Ollama 兜底开关」
-- 默认开启（1），云端 GLM 不可用/超时/失败时自动降级本地 Ollama
--
-- P2 幂等改写（2026-10-06）：原脚本直接 `ALTER TABLE ... ADD COLUMN`
-- （无 information_schema 判定），生产已应用过，重放报 1060 Duplicate column。
-- MySQL 8.0 也不支持 `ADD COLUMN IF NOT EXISTS`（那是 MariaDB 语法），
-- 故统一改为 information_schema 判定 + PREPARE 动态 SQL，可安全重复执行。

SET @ai_db := DATABASE();

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = @ai_db
      AND TABLE_NAME = 't_platform_ai_config'
      AND COLUMN_NAME = 'ollama_fallback_enabled') = 0,
  'ALTER TABLE t_platform_ai_config ADD COLUMN ollama_fallback_enabled TINYINT(1) DEFAULT 1 COMMENT ''本地 Ollama 兜底开关：1=开启 0=关闭'' AFTER default_system_prompt',
  'SELECT ''ollama_fallback_enabled 已存在，跳过'' AS skip_reason'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;