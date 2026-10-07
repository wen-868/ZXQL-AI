-- t_ai_usage_daily 补齐 (tenant_id, stat_date, provider, model) 唯一键（D-2 · 用量表静默膨胀修复）
-- 依据：docs/reports/D-2-用量表唯一键-执行报告.md
--   写入侧 src/bridge/audit-logger.ts:441-454 用
--   INSERT ... ON DUPLICATE KEY UPDATE 做日用量汇总（UPSERT）。
--   该语法只有撞上唯一约束（含主键）时才走 UPDATE 分支，而 INSERT 不带 id，
--   主键自增永不冲突 ⇒ 能否去重完全取决于表里有没有覆盖上述四列的唯一键。
--   实体 ai-usage-daily.entity.ts 声明的 5 个索引全部非唯一，
--   本机 liquor_inventory 库实测也只有 PRIMARY + 5 个非唯一 KEY ⇒ UPSERT 退化为
--   纯 INSERT，表按请求数膨胀。
--
-- ⚠️ 执行前必须备份：
--   CREATE TABLE t_ai_usage_daily_bak_014 AS SELECT * FROM t_ai_usage_daily;
--   或 mysqldump 单表备份。去重步骤会 DELETE 多余行（数值已先 SUM 合并回保留行）。
--
-- ⚠️ 数据安全性：去重采用「SUM 合并到一行 + 删除其余行」，不是直接删行。
--   合并列 = 8 个度量列：chat_count / tool_call_count / prompt_tokens /
--   completion_tokens / total_tokens / prompt_cost / completion_cost / total_cost。
--   （任务卡只列了前 5 个；但 UPSERT 之外的通路可能写费用列，
--     只合并 5 列会让被删行携带的 cost 永久丢失，违反「保留全部用量数值」硬约束，
--     故此处按表实际度量列全量合并。）
--   保留行 = 组内 MIN(id)，created_at 统一改写为组内 MIN(created_at)。
--
-- ⚠️ 幂等：加索引用 information_schema 判定 + PREPARE 动态 SQL
--   （MySQL 8.0 不支持 ADD INDEX IF NOT EXISTS，该写法是 MariaDB 专有）。
--   去重步骤本身天然幂等：临时聚合表只收 COUNT(*)>1 的组，
--   无重复时 UPDATE/DELETE 命中 0 行。
--
-- ⚠️ 依赖会话变量（PREPARE），本文件必须**整文件执行**，不可按分号拆分。
--
-- ⚠️ 注释规范：破折号后必须留一个空白，否则 MySQL 报 1064。
--
-- ⚠️ 残留风险（本迁移不解决，见报告第 5 节）：provider / model 列可空，
--   MySQL/MariaDB 唯一键对 NULL 不去重 ⇒ provider 或 model 为 NULL 的行仍会膨胀。
--   需要改写入侧（audit-logger 传空串而非 NULL）才能根治，不属于本迁移范围。

SET @main_db := DATABASE();

-- ── 1) 检测：是否已有覆盖四列的唯一键 ────────────────────────────────
-- 判据 A：名为 uk_usage_daily 且 NON_UNIQUE=0
-- 判据 B：任意非主键唯一索引恰好覆盖 tenant_id/stat_date/provider/model 四列
--   （避免生产上已有同名不同义或异名同义的唯一键时重复建冗余索引）
SET @uk_by_name := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @main_db
     AND TABLE_NAME = 't_ai_usage_daily'
     AND INDEX_NAME = 'uk_usage_daily'
     AND NON_UNIQUE = 0
);
SET @uk_by_cols := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = @main_db
       AND TABLE_NAME = 't_ai_usage_daily'
       AND NON_UNIQUE = 0
       AND COLUMN_NAME IN ('tenant_id', 'stat_date', 'provider', 'model')
     GROUP BY INDEX_NAME
    HAVING COUNT(DISTINCT COLUMN_NAME) = 4
  ) AS s
);
SET @uk_exists := IF(@uk_by_name + @uk_by_cols > 0, 1, 0);

SET @ddl := IF(
  @uk_exists = 1,
  'SELECT ''uk_usage_daily 已存在，跳过后续去重与建键'' AS skip_reason',
  'SELECT ''uk_usage_daily 不存在，继续执行去重与建键'' AS next_step'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2) 查重（只读，供人工核对规模）──────────────────────────────────
SELECT COUNT(*) AS dup_groups
  FROM (
    SELECT tenant_id, stat_date, provider, model
      FROM t_ai_usage_daily
     GROUP BY tenant_id, stat_date, provider, model
    HAVING COUNT(*) > 1
  ) AS dups;

SELECT
  (SELECT COUNT(*) FROM t_ai_usage_daily) AS rows_before,
  (SELECT COUNT(*) FROM (
     SELECT tenant_id, stat_date, provider, model
       FROM t_ai_usage_daily
      GROUP BY tenant_id, stat_date, provider, model
   ) AS g) AS groups_before;

-- ── 3) 重复组聚合到临时表（只收 COUNT(*)>1 的组）────────────────────
DROP TEMPORARY TABLE IF EXISTS tmp_usage_daily_dups;
CREATE TEMPORARY TABLE tmp_usage_daily_dups AS
SELECT tenant_id,
       stat_date,
       provider,
       model,
       MIN(id)                  AS keep_id,
       COUNT(*)                 AS dup_cnt,
       SUM(chat_count)          AS s_chat_count,
       SUM(tool_call_count)     AS s_tool_call_count,
       SUM(prompt_tokens)       AS s_prompt_tokens,
       SUM(completion_tokens)   AS s_completion_tokens,
       SUM(total_tokens)        AS s_total_tokens,
       SUM(prompt_cost)         AS s_prompt_cost,
       SUM(completion_cost)     AS s_completion_cost,
       SUM(total_cost)          AS s_total_cost,
       MIN(created_at)          AS s_created_at
  FROM t_ai_usage_daily
 GROUP BY tenant_id, stat_date, provider, model
HAVING COUNT(*) > 1;

SELECT COUNT(*) AS groups_to_merge,
       COALESCE(SUM(dup_cnt), 0) AS rows_in_groups,
       COALESCE(SUM(dup_cnt - 1), 0) AS rows_to_delete
  FROM tmp_usage_daily_dups;

-- ── 4) SUM 合并回保留行（keep_id = 组内 MIN(id)）────────────────────
UPDATE t_ai_usage_daily t
  JOIN tmp_usage_daily_dups d ON t.id = d.keep_id
   SET t.chat_count        = d.s_chat_count,
       t.tool_call_count   = d.s_tool_call_count,
       t.prompt_tokens     = d.s_prompt_tokens,
       t.completion_tokens = d.s_completion_tokens,
       t.total_tokens      = d.s_total_tokens,
       t.prompt_cost       = d.s_prompt_cost,
       t.completion_cost   = d.s_completion_cost,
       t.total_cost        = d.s_total_cost,
       t.created_at        = d.s_created_at;

-- ── 5) 删除多余行（数值已在第 4 步合并进保留行，此处无数据丢失）────
--    provider / model 可空，故用 NULL 安全比较运算符 <=>
DELETE t
  FROM t_ai_usage_daily t
  JOIN tmp_usage_daily_dups d
    ON  t.tenant_id <=> d.tenant_id
   AND  t.stat_date <=> d.stat_date
   AND  t.provider  <=> d.provider
   AND  t.model     <=> d.model
 WHERE t.id <> d.keep_id;

DROP TEMPORARY TABLE IF EXISTS tmp_usage_daily_dups;

-- ── 6) 建唯一键（条件执行，MySQL 8.0 / MariaDB 通用）────────────────
SET @uk_exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = @main_db
     AND TABLE_NAME = 't_ai_usage_daily'
     AND INDEX_NAME = 'uk_usage_daily'
     AND NON_UNIQUE = 0
);
SET @ddl := IF(
  @uk_exists > 0,
  'SELECT ''uk_usage_daily 已存在，跳过'' AS skip_reason',
  'ALTER TABLE t_ai_usage_daily ADD UNIQUE KEY uk_usage_daily (tenant_id, stat_date, provider, model)'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 7) 核验（人工阅读输出即可）──────────────────────────────────────
--  dup_groups 应为 0；rows_after 应等于 groups_after
SELECT COUNT(*) AS dup_groups_after
  FROM (
    SELECT tenant_id, stat_date, provider, model
      FROM t_ai_usage_daily
     GROUP BY tenant_id, stat_date, provider, model
    HAVING COUNT(*) > 1
  ) AS dups;

SELECT
  (SELECT COUNT(*) FROM t_ai_usage_daily) AS rows_after,
  (SELECT COUNT(*) FROM (
     SELECT tenant_id, stat_date, provider, model
       FROM t_ai_usage_daily
      GROUP BY tenant_id, stat_date, provider, model
   ) AS g) AS groups_after;

SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = @main_db
   AND TABLE_NAME = 't_ai_usage_daily'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;
