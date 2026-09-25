-- 数字员工 MVP：岗位档案表 + 任务留痕表 + 审计署名列
-- 依据：AI数字员工组织系统设计方案 v0.2（Capability Scoping 版）

CREATE TABLE IF NOT EXISTS t_ai_employee (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  tenant_id VARCHAR(32) NOT NULL COMMENT '所属租户',
  employee_uid VARCHAR(40) NOT NULL COMMENT '员工唯一标识',
  name VARCHAR(64) NOT NULL COMMENT '员工名称',
  post VARCHAR(64) NOT NULL COMMENT '岗位',
  department VARCHAR(64) NOT NULL COMMENT '部门',
  persona_prompt TEXT NULL COMMENT '岗位人设系统提示词',
  tool_categories JSON NULL COMMENT '工具业务域子集',
  data_scope JSON NULL COMMENT '数据权限范围',
  dispatch_uids JSON NULL COMMENT '可调用的员工employeeUid列表（边表）',
  reply_style VARCHAR(128) NULL COMMENT '对话风格',
  status TINYINT DEFAULT 1 COMMENT '状态：1启用 0停用',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  UNIQUE KEY uk_emp_uid (employee_uid),
  KEY idx_emp_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='数字员工岗位档案';

CREATE TABLE IF NOT EXISTS t_ai_employee_task (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  employee_id INT UNSIGNED NOT NULL COMMENT '执行员工ID',
  task TEXT NOT NULL COMMENT '任务描述',
  dispatched_by VARCHAR(64) DEFAULT 'user' COMMENT '派发来源',
  result_summary TEXT NULL COMMENT '执行结果摘要',
  status VARCHAR(16) DEFAULT 'running' COMMENT '状态：running/completed/failed',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  KEY idx_emp_task_emp (employee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='数字员工任务留痕';

ALTER TABLE t_ai_audit_log
  ADD COLUMN IF NOT EXISTS employee_uid VARCHAR(40) NULL COMMENT '数字员工UID';
