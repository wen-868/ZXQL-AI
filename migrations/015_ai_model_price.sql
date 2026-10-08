-- 015 t_ai_model_price：AI 模型分档单价（prompt / completion，元/千Token）真实来源
-- 依据：R101-AI-07 阿坚派单卡；业主 2026-10-09 认可「甲：先补真实单价来源，再按分档写入」
--
-- 一、定位与归属
--   - 归属：业务库侧、本仓独占（与 002 t_mcp_token / 005 t_ai_session_archive /
--     006 ai_execution_plan / 008 t_ai_employee 同类）。裸写表名即落业务库，
--     不使用 USE 切库（migrations/README.md 二.6）。
--   - 用途：为 t_ai_usage_daily 的 prompt_cost / completion_cost / total_cost
--     提供**分档单价来源**（R101-AI-03 的实现依据），取代文档里的示例价格表。
--   - 与 t_tenant_ai_billing.overage_price 的区别：后者是 blended「超额价」，
--     只在「免费次数耗尽 + 非月套餐」时用于扣余额；本表是按 provider + model 的牌价。
--
-- 二、单价口径与运行时解析规则（与 AiConfigService.getModelPrice 一致）
--   - 单位：元/千Token。prompt_price 为输入单价，completion_price 为输出单价。
--   - 唯一键 (provider, model, effective_from)：同一 provider+model 可留多条调价记录。
--   - 运行时取「enabled=1 且 effective_from <= 当前时间」中 effective_from 最大者，
--     未来行不提前生效，历史行保留可追溯。
--   - **无匹配行 = 未配置**：调用方必须拿到 null，禁止回落成 0 冒充已配置。
--   - 显式写入 0 元（如本地 ollama / 免费额度档）表示「已配置且为 0」，
--     与「未配置」是两种语义，不得混用。
--   - 价格只能来自本表配置，禁止在代码里硬编码价格表（R101-AI-07 红线）。
--   - ⚠️ 本表按 provider + model 定价；t_ai_usage_daily.model 是 014 三列唯一键下
--     的「代表值」，不可用于定价，定价须取调用明细 t_ai_audit_log 的真实 model。
--
-- 三、幂等与执行
--   - 建表用 CREATE TABLE IF NOT EXISTS（MySQL 8.0 与 MariaDB 均支持），可重复执行。
--   - 本文件**只写不跑**：不得在本地/生产直接执行，由部署链路按 NNN 顺序投放。
--   - 注释内不得出现分号（部署器按分号拆分语句），本文件已遵守。
--   - 执行方式：mysql -u<user> -p <业务库> < migrations/015_ai_model_price.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-09

CREATE TABLE IF NOT EXISTS t_ai_model_price (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  provider         VARCHAR(32)    NOT NULL COMMENT 'AI服务商（与 t_ai_usage_daily.provider 同口径）',
  model            VARCHAR(64)    NOT NULL COMMENT '模型名（精确匹配，不使用通配）',
  prompt_price     DECIMAL(12,6)  NOT NULL COMMENT '输入单价（元/千Token）',
  completion_price DECIMAL(12,6)  NOT NULL COMMENT '输出单价（元/千Token）',
  currency         CHAR(3)        NOT NULL DEFAULT 'CNY' COMMENT '币种（ISO 4217）',
  effective_from   DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '生效时间（取不晚于当前时间的最大者）',
  enabled          TINYINT        NOT NULL DEFAULT 1 COMMENT '是否启用 1=启用 0=停用',
  created_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at       DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_model_price_provider_model_effective (provider, model, effective_from),
  KEY idx_ai_model_price_lookup (provider, model, enabled, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI模型分档单价（元/千Token）';

-- 四、配置示例（运维 DML，勿写入本迁移文件，价格必须由配置侧按环境填写）
--   注意：以下只是**语句形状**示例，其中数值不是定价依据，不得照抄为真实价格。
--     INSERT INTO t_ai_model_price
--       (provider, model, prompt_price, completion_price, effective_from, enabled)
--     VALUES
--       ('deepseek', 'deepseek-chat', <输入单价>, <输出单价>, NOW(), 1)
--   调价：追加一条更大 effective_from 的行（不做 UPDATE 覆盖历史）。
--   停用：UPDATE t_ai_model_price SET enabled = 0 WHERE provider = ? AND model = ?
--
-- 五、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--   回滚 = 反向迁移，单独执行下列语句（刻意不在注释内写句末分号，避免破坏分号拆分）：
--     DROP TABLE IF EXISTS t_ai_model_price
--   注意：DROP 会连同单价历史一起删除，执行前须确认无在用依赖
--   （readiness 探针会把缺表报为 degraded）
