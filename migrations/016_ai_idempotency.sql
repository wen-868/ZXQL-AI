-- 016 t_ai_idempotency：AI 写工具幂等键（阶段 3 幂等键 · MySQL 唯一索引兜底层）
-- 依据：R101-AI-20 方案卡（docs/plans/阶段3-幂等键-方案.md，2026-10-12）
--
-- 一、定位与归属
--   - 归属：业务库侧、本仓独占（与 002 t_mcp_token / 005 / 006 / 008 / 015 同类）。
--     裸写表名即落业务库，不使用 USE 切库（migrations/README.md 二.6）。
--   - 作用：写工具调用的「至多一次落单」最终防线 —— Redis SET NX 只做前置快筛，
--     本表的唯一键负责并发互斥与持久兜底（Redis 宕机/重启/被 FLUSH 后仍生效）。
--   - 唯一执行入口：src/tools/tool-executor.ts 的 executeToolCall()（闸门插在熔断之后、
--     执行之前，仅对 isWriteOperation=true 且 args.confirm=true 的真实写生效）。
--
-- 二、键与状态语义（与方案 §1 一致）
--   - idem_key = sha256(tenant_id + '|' + tool_name + '|' + key_material)，CHAR(64) hex。
--   - key_source 记录键的来源，便于评估键质量：confirm_token / explicit / business_key / payload_hash。
--     （business_key 由 R101-AI-25 引入：工具声明 idempotencyKeyFields 时以业务字段指纹取键）
--   - status：in_flight（已认领、执行中）/ succeeded（可回放 result_json）/ failed（可重试）。
--   - ⚠️ 唯一键是并发仲裁点：认领必须发生在 tool.execute 之前（INSERT in_flight），
--     冲突方读既有行后回放或返回「处理中」，不得直接执行。
--
-- 三、清理与保留期
--   - 保留 30 天（方案 §1.3）：覆盖对账/追溯窗口，远大于任何重试窗口。
--   - 清理走每日 03:00 批量 DELETE（LIMIT 5000 循环），依赖 idx_ai_idempotency_cleanup。
--   - 清理任务与降级开关属实现单（R101-AI-21），本迁移不含任何 DML。
--
-- 四、幂等与执行
--   - 建表用 CREATE TABLE IF NOT EXISTS（MySQL 8.0 支持），可重复执行。
--   - **本文件只写不跑**：不得在本地/生产直接执行，由部署链路按 NNN 顺序投放。
--   - 注释内不得出现分号（部署器按分号拆分语句），本文件已遵守。
--   - 执行方式：mysql -u<user> -p <业务库> < migrations/016_ai_idempotency.sql
--
-- 负责人: 阿坚 | 创建日期: 2026-10-12

CREATE TABLE IF NOT EXISTS t_ai_idempotency (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '主键ID',
  tenant_id     VARCHAR(36)  NOT NULL COMMENT '租户ID（幂等键第一段，多租户隔离）',
  tool_name     VARCHAR(64)  NOT NULL COMMENT '工具名（幂等键第二段）',
  idem_key      CHAR(64)     NOT NULL COMMENT '幂等键 sha256 hex（第三段）',
  key_source    VARCHAR(16)  NOT NULL COMMENT '键来源 confirm_token/explicit/business_key/payload_hash',
  status        VARCHAR(16)  NOT NULL DEFAULT 'in_flight' COMMENT '状态 in_flight/succeeded/failed',
  result_json   MEDIUMTEXT   NULL COMMENT '首次执行结果（ToolResult JSON，供重复请求回放）',
  error_text    VARCHAR(512) NULL COMMENT '失败摘要（脱敏，仅排障）',
  first_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '认领时刻',
  completed_at  DATETIME     NULL COMMENT '完成时刻（in_flight 超时看护用）',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_idempotency (tenant_id, tool_name, idem_key),
  KEY idx_ai_idempotency_cleanup (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AI写工具幂等键（至多一次落单）';

-- 五、预检与处置（**文档，勿执行**；见方案 §7.3）
--   本表为新建表 ⇒ 建表时无存量行，不存在「存量重复导致唯一键建立失败」。
--   若后续往已有表补唯一键，先跑预检确认无冲突（应返回空集）：
--     SELECT tenant_id, tool_name, idem_key, COUNT(*) AS c
--     FROM t_ai_idempotency
--     GROUP BY tenant_id, tool_name, idem_key
--     HAVING c > 1
--   有冲突则先保留最早一行并归档其余行，复核后再加唯一键（详见方案 §7.3，DML 须业主批准后由 DBA 执行）
--
-- 六、回滚 SQL（文档·勿执行；按 migrations/README.md 二.5，回滚走反向迁移）
--   回滚 = 反向迁移，单独执行下列语句（刻意不在注释内写句末分号，避免破坏分号拆分）：
--     DROP TABLE IF EXISTS t_ai_idempotency
--   注意：DROP 会丢失幂等与回放凭据，执行前须确认闸门已下线（代码回滚完成）
