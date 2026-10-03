-- 数字员工评分回流产品化 + 审计取证埋点
-- 依据：12.8.3 🟢 可随时做清单（办公任务评分闭环产品化 + 跨域占比取证前置）

-- 1) 员工任务表：任务类型（派发时意图域）+ 评分回流结果
ALTER TABLE t_ai_employee_task
  ADD COLUMN task_type VARCHAR(64) NULL COMMENT '任务类型（派发时意图域）',
  ADD COLUMN rating_result VARCHAR(16) NULL COMMENT '评分回流结果：sample/correction';


-- 2) 审计表：意图分诊埋点（跨域占比统计与岗位化 ROI 度量的数据源）
--    + lane/categories 列（并行会话新增的审计字段，本地表补齐）
ALTER TABLE t_ai_audit_log
  ADD COLUMN triage_lane VARCHAR(16) NULL COMMENT '意图分诊通道：rules/llm/chat/fallback',
  ADD COLUMN triage_categories VARCHAR(128) NULL COMMENT '分诊业务域（逗号分隔）',
  ADD COLUMN lane VARCHAR(16) NULL COMMENT '业务域标记',
  ADD COLUMN categories VARCHAR(255) NULL COMMENT '工具域集合';
