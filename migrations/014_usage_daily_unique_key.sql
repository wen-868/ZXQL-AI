-- t_ai_usage_daily 存量合并 + 归一化 + 补齐三列唯一键（P0 · 生产 1062 修复）
-- 依据：docs/reports/P0-014重做-生产1062修复-任务卡.md（凌舟 R101 追单 §三 R1-R6）
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 一、生产失败与根因（本轮在 MySQL 8.0.28 上复刻生产结构逐条复现，非推断）
-- ═══════════════════════════════════════════════════════════════════════════
-- 生产报错：
--   ERROR 1062 (23000) at line 87:
--   Duplicate entry 'default-2026-08-09-' for key 't_ai_usage_daily.uk_tenant_date_provider'
--
-- 生产实况：唯一键**已存在**，为 `uk_tenant_date_provider (tenant_id, stat_date, provider)`
--   —— 三列，不含 model；124 行 / 21 组（按三列去重）。
--
-- 原因 A（归一化让原本不受约束的行突然受约束 ⇒ 对应报错行 87）：
--   MySQL 唯一索引**允许多个 NULL** ⇒ 含可空列 provider 的唯一键对
--   `provider IS NULL` 的行**完全不生效** ⇒ 生产那 124 行的重复**全部是 NULL 行**。
--   旧脚本第 87 行 `SET provider = ''` 的**瞬间**，这些行第一次真正受该键约束
--   ⇒ 而它们彼此重复 ⇒ 1062。**修 A 单独做不够**（换任何哨兵值都会在同一处炸）。
--
-- 原因 B（去重口径比唯一键更宽 ⇒ 独立第二条失败路径，落在建键语句）：
--   旧脚本按四元组 (tenant_id, stat_date, provider, model) 去重，而生产键是**三列**。
--   三列更严格 ⇒ 同一 (tenant, date, provider) 下若有不同 model 的两行，
--   四元组去重**不会合并它们** ⇒ 建 uk_usage_daily 时撞上已有三列键。
--   已在 MySQL 8.0.28 上单独复现（provider 全非 NULL、模型各不相同）
--   ⇒ ERROR 1062 at line 27（建键语句），与原因 A 的 line 87 是两条独立路径。
--   **修 B 单独做也不够**（三列键下 NULL 行仍需合并）。
--
-- 原因 C（守卫漏检已存在的键）：
--   旧脚本 @uk_exists 只查 `uk_usage_daily` 这一个名字，不查生产已有的
--   `uk_tenant_date_provider` ⇒ 生产上算出 0 ⇒ 守卫全部放行。
--   本脚本 @uk_exists 改为：任意 NON_UNIQUE=0 且列集合包含
--   (tenant_id, stat_date, provider) 的索引（见第 3 步）。
--
-- ⚠️ 上一轮验证的漏洞：当时在**空库 / 无唯一键**的表上验证，结构与生产不同
--   ⇒ 冲突不显现。本轮改为**先复刻生产结构**（先建三列键 + 造 NULL 重复行）
--   再跑，见 docs/reports/P0-014重做-生产1062修复-执行报告.md 的反测矩阵。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 二、写入侧与唯一键口径（唯一键为何是**三列**而不是四列）
-- ═══════════════════════════════════════════════════════════════════════════
-- 写入侧 src/bridge/audit-logger.ts:455-479：
--   INSERT INTO t_ai_usage_daily (tenant_id, stat_date, ..., provider, model)
--   VALUES (...) ON DUPLICATE KEY UPDATE chat_count = chat_count + VALUES(...)
--
-- 该 UPSERT **命中哪一列的唯一键，就按哪一列的口径累加**。生产上
-- `uk_tenant_date_provider`（三列）**已经在生效**（非 NULL 行）⇒
-- **生产实际的累加口径早已是三列**，不同 model 的用量早被累加进同一行。
--   ⇒ 四元组键比真实口径**更宽**，既拦不住分叉，也与存量合并口径不一致。
--
-- 读侧无一处按 model 聚合本表（全部实跑核对）：
--   src/ops/usage-stats.service.ts:67-75 明细逐行直出（不 GROUP BY model）
--   src/ops/usage-stats.service.ts:99-107 / :142-152 / usage-alert.service.ts:78
--     均为 SUM 聚合，不含 model
--   ⇒ 收敛到三列键**不破坏任何现有读口径**。
--
-- ⇒ 唯一键统一为 **(tenant_id, stat_date, provider)**，与生产现存键同名同义
--   `uk_tenant_date_provider`，实体 ai-usage-daily.entity.ts 同步。
--
-- ⚠️ 代价与不可逆性（合并后 model 退化为「代表值」，本表不再能按 model 拆分）：
--   合并是**有损的语义降级**（数值无损、维度有损）。这是生产既有三列键
--   已经强加的现状（写入侧早已按三列累加），本迁移只是让存量与它对齐。
--   需要按 model 维度分析用量时，必须查明细表 t_ai_audit_log，
--   **不能**从本表按 model 分组。此约束由本次迁移确立，不得回退。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 三、哨兵值：三处必须完全一致（库默认值 / 迁移回填值 / 写入侧空值兜底）
-- ═══════════════════════════════════════════════════════════════════════════
-- 选定方案：**(a) 列改 NOT NULL DEFAULT 'unknown'**（不是生成列/函数索引）。
--   理由 1（可执行性）：生成列 + 唯一索引在 MySQL 需 8.0.13+ 的函数索引，
--     MariaDB 需 10.2+ 才支持持久化生成列索引；本仓迁移要求 MySQL/MariaDB 通用。
--     (a) 只是 MODIFY COLUMN，两个引擎行为一致且早已支持。
--   理由 2（语义统一）：(b) 只在**索引表达式**上绕过 NULL，列本身仍可空
--     ⇒ 库里继续存 NULL、写入侧继续存哨兵，两种空值语义并存
--     ⇒ 正是 R2 要消灭的静默失效。(a) 把唯一性约束落到**列定义**上，物理上无 NULL。
--   理由 3（读侧一致）：src/ops/usage-stats.service.ts:85-86 用 `?? null` 映射，
--     列可空时明细里仍会出现 null；(a) 之后该分支永不命中。
--
-- 哨兵值 = **'unknown'**（provider 与 model 同）：
--   * 不用 ''：空串与「有效但为空」不可区分，报表里表现为空值，
--     且极易被下轮迁移再次误判成"未设置"。
--   * 'unknown' 显式可读、可 GROUP BY、可在唯一键里正常去重（普通值）。
--
-- 三处一致性（本轮已同步落地，缺一处即静默失效）：
--   1. 库默认值     ：provider/model 均 NOT NULL DEFAULT 'unknown'（本脚本第 6 步）
--   2. 迁移回填值   ：NULL 与 '' 一律回填 'unknown'（本脚本第 5 步）
--   3. 写入侧兜底   ：audit-logger.ts 的 `params.provider ?? ''` / `?? ''`
--                     已同步改为 `?? 'unknown'`（两列同步）
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 四、合并口径与确定性规则（R1 / R2）
-- ═══════════════════════════════════════════════════════════════════════════
-- 合并分组键（**归一化后的三列**，不是三列原值，也不是四元组）：
--   (tenant_id, stat_date, COALESCE(NULLIF(provider,''),'unknown'))
--   把 NULL / '' / 'unknown' 视为**同一组**——它们归一化后本就是同一行。
--   ⚠️ 这一点是本脚本能同时修好 A 与 B 的关键：
--     若按「原值」分组，NULL 组与已存在的 'unknown' 组会分成两组，
--     合并后各留一行，再归一化就撞 1062（换到第 5 步炸）。
--     按「归一化值」分组 ⇒ 两者在同一步被合并 ⇒ 归一化永不产生新重复。
--
-- 度量列（8 列）全部求和，🚫 不得丢行：
--   chat_count / tool_call_count / prompt_tokens / completion_tokens /
--   total_tokens / prompt_cost / completion_cost / total_cost
--   （费用列必须一起合并：UPSERT 之外的通路会写费用，只合并计数与 token
--     会让被删行携带的 cost 永久丢失。）
--   🚫 不使用 INSERT IGNORE / REPLACE —— 二者都会静默丢行，本脚本一律
--     「UPDATE 合并回保留行 + DELETE 多余行」，且 DELETE 严格在 UPDATE 之前
--     （理由见第五步）。
--
-- 保留行：组内 MIN(id)；created_at 取组内 MIN(created_at)。
--
-- **合并后 model 的确定性规则**（R1 明确要求给出可复现规则）：
--   `keep_model = COALESCE(MIN(NULLIF(NULLIF(model,''),'unknown')), 'unknown')`
--   读作：**先剔除 NULL / '' / 'unknown'，再取字典序升序最小的 model；
--   若组内不含任何有效 model，则取 'unknown'**。
--   为什么不取「占比最大的 model」：
--     - 确定性：MIN 是纯函数，任何时刻对同一组数据重跑结果完全一致；
--       「取第一行」依赖物理行序，不可复现（明令禁止）。
--     - 占比口径需要窗口函数/自子查询，分区边界更易错，
--       且在 DELETE 已改变行集后重算会得到不同结果。
--     - 两者都只是「代表值」；既然必然有损，宁取规则最简、最易审计的一个。
--   为什么先剔除 'unknown' 再 MIN：否则一旦组内存在 'unknown'，
--     字典序最小的极可能就是它，会把同组内真实的 model 掩盖掉。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 五、执行顺序（**先 DELETE 后 UPDATE**，不可颠倒）
-- ═══════════════════════════════════════════════════════════════════════════
-- 若先 UPDATE 再 DELETE：把保留行的 provider 改成 'unknown' 的瞬间，
--   同组尚未删除的兄弟行会造成 (tenant, date, 'unknown') 瞬时重复
--   ⇒ 若表上已有三列键（生产就是），UPDATE 语句内触发 1062。
--   本脚本先把聚合结果落临时表，再 DELETE 掉除 MIN(id) 外的全部行，
--   最后才 UPDATE 保留行 ⇒ UPDATE 执行时每组只剩一行，物理上不可能重复。
--
-- ⚠️ 幂等：临时表只收 COUNT(*)>1 的组，无重复时为空 ⇒ DELETE/UPDATE 命中 0 行；
--   归一化 UPDATE 第二次跑命中 0 行；ALTER 与建键均有 information_schema 守卫。
--   ⇒ 同库连跑两遍：零错误码，行数与 8 列求和值均不变。
--
-- ⚠️ 依赖会话变量（PREPARE），本文件必须**整文件执行**，不可按分号拆分到
--   多连接逐条执行（否则会话变量丢失，动态 SQL 全部失败）。
--
-- ⚠️ 执行前必须备份：
--   CREATE TABLE t_ai_usage_daily_bak_014 AS SELECT * FROM t_ai_usage_daily;
--   或 mysqldump 单表备份。合并步骤会 DELETE 多余行（数值已先 SUM 合并回保留行）。
--
-- ⚠️ 缺表处理：本脚本**不做缺表跳过**，缺表直接 ERROR 1146 让部署红。
--   理由：t_ai_usage_daily 由管理系统仓 121_ai_base_tables.sql 建表
--   （见 migrations/README.md），本仓迁移在其后执行；表缺失属结构不完整，
--   与 003/007 等 DDL 脚本同口径。若在此处 EXIT=0 跳过，写入侧 UPSERT
--   将永久失去去重能力 ⇒ 表按请求数膨胀且无任何告警（假绿）。
--
-- ⚠️ 注释规范：行注释引导符 `--` 后必须留一个空白，否则 MySQL 报 1064。
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 六、顺序依赖（R6）
-- ═══════════════════════════════════════════════════════════════════════════
-- 本迁移**必须先于任何依赖该唯一键的写入路径生效**：
--   src/bridge/audit-logger.ts 的 upsertDailyUsage 用
--   `INSERT ... ON DUPLICATE KEY UPDATE` 汇总日用量，其去重能力**完全依赖**
--   本迁移建立的唯一键。唯一键建立前，INSERT 不带 id、主键自增永不冲突，
--   表上其余索引全非唯一 ⇒ UPDATE 分支永不命中 ⇒ 每次调用都 INSERT 新行，
--   用量报表与超阈值告警静默失真。
--   当前部署顺序：管理系统仓迁移（建表）→ AI 底座迁移（本脚本，编号 014）
--   → 服务启动后开始写入，满足该顺序依赖。**不得把本脚本移到服务启动之后**，
--   也不得在唯一键缺失期间放行流量。
--
-- 同时注意：本脚本建立/收敛的三列唯一键会立即对**后续所有写入**生效，
--   写入侧必须与本脚本的哨兵口径一致（见第三节第 3 条），否则写入会在
--   归一化与写入之间产生错配。

SET @main_db := DATABASE();

-- ── 1) 表存在性前置检查（缺表即报错，见上方说明）────────────────────────
SELECT COUNT(*) AS table_exists FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily';

-- ── 2) 迁移前基线（供人工逐列对账）──────────────────────────────────────
--   迁移后第 8 步会再打一次同样八列，两次必须**逐列相等**。
SELECT COUNT(*) AS rows_before,
       COALESCE(SUM(chat_count), 0)        AS s_chat_count,
       COALESCE(SUM(tool_call_count), 0)   AS s_tool_call_count,
       COALESCE(SUM(prompt_tokens), 0)     AS s_prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS s_completion_tokens,
       COALESCE(SUM(total_tokens), 0)      AS s_total_tokens,
       COALESCE(SUM(prompt_cost), 0)       AS s_prompt_cost,
       COALESCE(SUM(completion_cost), 0)   AS s_completion_cost,
       COALESCE(SUM(total_cost), 0)        AS s_total_cost,
       SUM(provider IS NULL)                AS provider_null_rows,
       SUM(model IS NULL)                   AS model_null_rows
  FROM t_ai_usage_daily;

-- ── 3) 守卫：是否已存在覆盖三列的唯一键（R3）────────────────────────────
--   判据：任意 NON_UNIQUE=0 的索引，其列集合**包含**
--         (tenant_id, stat_date, provider) 三个列。
--   ⇒ `uk_tenant_date_provider`（生产现存，三列）命中
--   ⇒ `uk_usage_daily`（旧脚本建的，四列）也命中（列集合是超集）
--   ⇒ 不再重复建键，避免异名同义冗余索引。
--
--   ⚠️ 与旧脚本的关键差异：@uk_exists **不再用于门控归一化与合并**。
--      旧脚本把 `SET provider = ''` 挂在 `@uk_exists = 0` 上，
--      而生产算出 0 ⇒ 守卫放行 ⇒ 归一化瞬间撞键（原因 A）。
--      本脚本中 @uk_exists 只决定**是否还要建键**；
--      合并与归一化是无条件执行的（本身已按正确顺序做到零冲突）。
SET @uk_exists := (
  SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
      FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = @main_db
       AND TABLE_NAME = 't_ai_usage_daily'
       AND NON_UNIQUE = 0
       AND COLUMN_NAME IN ('tenant_id', 'stat_date', 'provider')
     GROUP BY INDEX_NAME
    HAVING COUNT(DISTINCT COLUMN_NAME) = 3
  ) AS s
);

SET @ddl := IF(@uk_exists > 0,
  'SELECT ''已存在覆盖 (tenant_id,stat_date,provider) 的唯一键，跳过建键'' AS skip_reason',
  'SELECT ''三列唯一键不存在，稍后建键'' AS next_step');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 4) 存量合并（R1）：按**归一化三列**分组，8 个度量列全部求和 ──────────
--   分组键用归一化表达式（理由见文件头第四节）：NULL / '' / 'unknown' 归一组。
--   只收 COUNT(*) > 1 的组 ⇒ 无重复时临时表为空 ⇒ DELETE/UPDATE 天然命中 0 行。
--
--   本步**只读**：聚合结果落临时表，不动主表。
DROP TEMPORARY TABLE IF EXISTS tmp_usage_daily_merge;
CREATE TEMPORARY TABLE tmp_usage_daily_merge AS
SELECT tenant_id,
       stat_date,
       COALESCE(NULLIF(provider, ''), 'unknown') AS grp_provider,
       MIN(id)                                   AS keep_id,
       COUNT(*)                                  AS dup_cnt,
       COALESCE(SUM(chat_count), 0)               AS s_chat_count,
       COALESCE(SUM(tool_call_count), 0)          AS s_tool_call_count,
       COALESCE(SUM(prompt_tokens), 0)            AS s_prompt_tokens,
       COALESCE(SUM(completion_tokens), 0)        AS s_completion_tokens,
       COALESCE(SUM(total_tokens), 0)             AS s_total_tokens,
       COALESCE(SUM(prompt_cost), 0)              AS s_prompt_cost,
       COALESCE(SUM(completion_cost), 0)          AS s_completion_cost,
       COALESCE(SUM(total_cost), 0)               AS s_total_cost,
       -- 确定性 model 规则（理由见文件头第四节）：剔除 NULL/''/'unknown'
       -- 后取字典序升序最小者，全空则 'unknown'。
       COALESCE(MIN(NULLIF(NULLIF(model, ''), 'unknown')), 'unknown') AS keep_model,
       MIN(created_at)                           AS s_created_at
  FROM t_ai_usage_daily
 GROUP BY tenant_id,
          stat_date,
          COALESCE(NULLIF(provider, ''), 'unknown')
HAVING COUNT(*) > 1;

SELECT COUNT(*)                AS groups_to_merge,
       COALESCE(SUM(dup_cnt), 0)      AS rows_in_groups,
       COALESCE(SUM(dup_cnt - 1), 0)  AS rows_to_delete
  FROM tmp_usage_daily_merge;

-- ── 5) 先 DELETE 多余行，再 UPDATE 保留行（顺序不可颠倒）───────────────
--   数值已在本步之前的临时表里聚合好，DELETE 不丢数值。
--   必须先 DELETE：否则 UPDATE 保留行的 provider 时，同组兄弟行还在，
--   生产三列键会在 UPDATE 语句内触发 1062（详见文件头第五节）。
DELETE t
  FROM t_ai_usage_daily t
  JOIN tmp_usage_daily_merge d
    ON  t.tenant_id <=> d.tenant_id
   AND  t.stat_date <=> d.stat_date
   AND  COALESCE(NULLIF(t.provider, ''), 'unknown') = d.grp_provider
 WHERE t.id <> d.keep_id;

--   UPDATE 只写度量列与 model，**不碰 provider**（唯一键列）：
--   provider 的归一化交给下一步统一做，避免在唯一键上做逐行改写。
--   8 个度量列全部求和写入。
UPDATE t_ai_usage_daily t
  JOIN tmp_usage_daily_merge d ON t.id = d.keep_id
   SET t.chat_count        = d.s_chat_count,
       t.tool_call_count   = d.s_tool_call_count,
       t.prompt_tokens     = d.s_prompt_tokens,
       t.completion_tokens = d.s_completion_tokens,
       t.total_tokens      = d.s_total_tokens,
       t.prompt_cost       = d.s_prompt_cost,
       t.completion_cost   = d.s_completion_cost,
       t.total_cost        = d.s_total_cost,
       t.model             = d.keep_model,
       t.created_at        = d.s_created_at;

DROP TEMPORARY TABLE IF EXISTS tmp_usage_daily_merge;

--   归一化（迁移回填值 = 'unknown'，与库默认值、写入侧兜底三处一致）：
--   合并后每组只剩一行，且分组键用的就是归一化表达式 ⇒ 同 (tenant, date) 下
--   不可能再有第二行会归一到同一个 'unknown' ⇒ 本 UPDATE 零冲突。
--   幂等：第二次跑命中 0 行。
UPDATE t_ai_usage_daily SET provider = 'unknown'
 WHERE provider IS NULL OR provider = '';
UPDATE t_ai_usage_daily SET model    = 'unknown'
 WHERE model    IS NULL OR model    = '';

-- ── 6) 列定义收敛为 NOT NULL DEFAULT 'unknown'（R2 方案 a）─────────────
--   ⚠️ 必须在本脚本第 5 步归一化**之后**执行：NOT NULL 列上若还有 NULL 值，
--      严格模式下 ALTER 直接报 1138（非严格模式会静默转成 ''，
--      那就又回到了两种空值语义并存的坏状态）。
--
--   列类型 / 字符集 / 注释均从 information_schema 读出后原样带回，
--   不硬编码、不丢原COMMENT、不改 collation —— 只加 NOT NULL 与 DEFAULT。
SET @prov_meta := (
  SELECT CONCAT(COLUMN_TYPE, ' CHARACTER SET ', CHARACTER_SET_NAME,
                ' COLLATE ', COLLATION_NAME)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'provider');
SET @prov_cmt := (
  SELECT COALESCE(COLUMN_COMMENT, '') FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'provider');
SET @prov_fix := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'provider'
     AND (IS_NULLABLE = 'YES' OR COLUMN_DEFAULT IS NULL
          OR COLUMN_DEFAULT <> 'unknown'));

SET @ddl := IF(@prov_fix = 0 OR @prov_meta IS NULL,
  'SELECT ''provider 列定义已是 NOT NULL DEFAULT ''''unknown''''，跳过'' AS skip_reason',
  CONCAT('ALTER TABLE t_ai_usage_daily MODIFY COLUMN provider ', @prov_meta,
         ' NOT NULL DEFAULT ''unknown'' COMMENT ''',
         REPLACE(@prov_cmt, '''', ''''''), ''''));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @model_meta := (
  SELECT CONCAT(COLUMN_TYPE, ' CHARACTER SET ', CHARACTER_SET_NAME,
                ' COLLATE ', COLLATION_NAME)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'model');
SET @model_cmt := (
  SELECT COALESCE(COLUMN_COMMENT, '') FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'model');
SET @model_fix := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = @main_db AND TABLE_NAME = 't_ai_usage_daily'
     AND COLUMN_NAME = 'model'
     AND (IS_NULLABLE = 'YES' OR COLUMN_DEFAULT IS NULL
          OR COLUMN_DEFAULT <> 'unknown'));

SET @ddl := IF(@model_fix = 0 OR @model_meta IS NULL,
  'SELECT ''model 列定义已是 NOT NULL DEFAULT ''''unknown''''，跳过'' AS skip_reason',
  CONCAT('ALTER TABLE t_ai_usage_daily MODIFY COLUMN model ', @model_meta,
         ' NOT NULL DEFAULT ''unknown'' COMMENT ''',
         REPLACE(@model_cmt, '''', ''''''), ''''));
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 7) 建唯一键（条件执行，MySQL 8.0 / MariaDB 通用）────────────────────
--   口径为**三列** (tenant_id, stat_date, provider)：
--     * 与生产现存 uk_tenant_date_provider 同名同义 ⇒ 实体声明一致；
--     * 与写入侧 UPSERT 在生产上实际生效的累加口径一致（见文件头第二节）；
--     * 与第 4 步的合并分组键一致 ⇒ 合并后不可能再违反它。
--   🚫 不用 ADD INDEX IF NOT EXISTS（MariaDB 专有，MySQL 8.0 会报语法错）。
SET @ddl := IF(@uk_exists > 0,
  'SELECT ''三列唯一键已存在，跳过建键'' AS skip_reason',
  'ALTER TABLE t_ai_usage_daily ADD UNIQUE KEY uk_tenant_date_provider (tenant_id, stat_date, provider)');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 8) 核验（人工阅读输出即可）──────────────────────────────────────────
--   8a. 与第 2 步基线**逐列对账**：8 个度量列求和必须完全相等（数值零丢失），
--       行数只允许**减少**（多余行被合并），provider_null_rows /
--       model_null_rows 必须归零。
--   8b. dup_groups_after 必须为 0（按归一化三列分组）。
--   8c. 三列唯一键存在，且列定义已 NOT NULL DEFAULT 'unknown'。
SELECT COUNT(*) AS rows_after,
       COALESCE(SUM(chat_count), 0)        AS s_chat_count,
       COALESCE(SUM(tool_call_count), 0)   AS s_tool_call_count,
       COALESCE(SUM(prompt_tokens), 0)     AS s_prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS s_completion_tokens,
       COALESCE(SUM(total_tokens), 0)      AS s_total_tokens,
       COALESCE(SUM(prompt_cost), 0)       AS s_prompt_cost,
       COALESCE(SUM(completion_cost), 0)   AS s_completion_cost,
       COALESCE(SUM(total_cost), 0)        AS s_total_cost,
       SUM(provider IS NULL)                AS provider_null_rows,
       SUM(model IS NULL)                   AS model_null_rows
  FROM t_ai_usage_daily;

SELECT COUNT(*) AS dup_groups_after
  FROM (
    SELECT tenant_id, stat_date, COALESCE(NULLIF(provider, ''), 'unknown')
      FROM t_ai_usage_daily
     GROUP BY tenant_id, stat_date, COALESCE(NULLIF(provider, ''), 'unknown')
    HAVING COUNT(*) > 1
  ) AS dups;

--   合并后的 model 代表值抽样（三列收敛后 model 已是代表值，见文件头第二节）
SELECT tenant_id, stat_date, provider, model, chat_count, total_tokens, total_cost
  FROM t_ai_usage_daily
 ORDER BY tenant_id, stat_date, provider
 LIMIT 30;

SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_TYPE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = @main_db
   AND TABLE_NAME = 't_ai_usage_daily'
   AND COLUMN_NAME IN ('provider', 'model');

SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX
  FROM information_schema.STATISTICS
 WHERE TABLE_SCHEMA = @main_db
   AND TABLE_NAME = 't_ai_usage_daily'
 ORDER BY INDEX_NAME, SEQ_IN_INDEX;