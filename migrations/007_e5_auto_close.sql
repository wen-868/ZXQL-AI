-- E5 自治闭环：总台策略开关 + 进化版本回归评测结果落库
-- 依据：权威文档 26 章 E5（自动 staging→回归→激活闭环，策略显式开启，默认人工放行）
-- 依据：2026-09-05 工作文件核查——E5 框架此前为模拟实现，本迁移支撑真实评测与策略门控

-- 1) 平台配置：E5 自治开关（默认 0=人工放行，总台显式开启后才自动激活/拦截）
ALTER TABLE t_platform_ai_config
  ADD COLUMN evolution_auto_activate TINYINT(1) DEFAULT 0
  COMMENT 'E5 自治开关：1=回归达标自动激活/未达标自动拦截 0=人工放行（默认）'
  AFTER ollama_fallback_enabled;

-- 2) 进化版本：回归评测结果（基线=上一 active 版本最近一次评测值）
ALTER TABLE ai_evolution_version
  ADD COLUMN regression_accuracy DECIMAL(5, 4) NULL
  COMMENT '最近一次 E5 回归评测准确率（0-1）',
  ADD COLUMN regression_evaluated_at DATETIME NULL
  COMMENT '最近一次回归评测时间';
