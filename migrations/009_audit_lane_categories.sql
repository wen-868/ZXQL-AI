-- 取证埋点（方案 12.4）：审计记录补 lane / categories
-- 用途：统计「跨域占比 = 涉及 ≥2 业务域的任务占比」，为是否从 MVP 扩展
--       流水线编排提供数据依据（占比高→扩展，占比低→MVP 即稳态）。
-- lane：执行车道（此前无字段，只能按 intent 反推）
-- categories：本次调用触及的业务域（ToolCategory 数组，去重）

ALTER TABLE t_ai_audit_log
  ADD COLUMN IF NOT EXISTS lane VARCHAR(16) NULL COMMENT '执行车道：chat/agent/graph/proactive/evidence/tool',
  ADD COLUMN IF NOT EXISTS categories JSON NULL COMMENT '触及的业务域（ToolCategory 数组，去重）';

-- 按车道聚合统计（跨域占比与车道分布均以此为分组键）
ALTER TABLE t_ai_audit_log
  ADD INDEX IF NOT EXISTS idx_lane (lane);
