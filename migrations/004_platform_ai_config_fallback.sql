-- P1-3：平台 AI 配置增加「本地 Ollama 兜底开关」
-- 默认开启（1），云端 GLM 不可用/超时/失败时自动降级本地 Ollama
ALTER TABLE t_platform_ai_config
  ADD COLUMN ollama_fallback_enabled TINYINT(1) DEFAULT 1
  COMMENT '本地 Ollama 兜底开关：1=开启 0=关闭'
  AFTER default_system_prompt;
