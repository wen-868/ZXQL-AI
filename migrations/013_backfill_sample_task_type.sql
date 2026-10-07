-- ai_sample.task_type 存量回填：工具名口径归一为裸 docType（阶段 4-1 · P0 断链修复）
-- 依据：docs/reports/阶段4-1-taskType归一-任务卡.md
--   采集侧（src/evolution/capture.service.ts）历史上把工具名（如 createSalesOrder）
--   写进 ai_sample.task_type，而消费侧（src/brain/extraction/structured-extractor.ts:141-145）
--   的 few-shot 回流按裸 docType（如 sales_order）精确相等查询
--   ⇒ 永不相等 ⇒ 自动捕获的样本 100% 进不了 few-shot 池。
--   代码侧已在 capture.service.ts 落库前用 docTypeForTool() 归一，本脚本只补存量。
--
-- 映射来源：src/brain/extraction/write-schema-registry.ts 的 WRITE_SCHEMAS
--   （14 类 docType / 19 个工具名，实施方已逐条 Read 核实）。
--   工具名 → docType 为多对一（promotion 有 6 个工具名），无二义。
--
-- ⚠️ 跨库口径（2026-10-08 修正，P0）：
--   `ai_sample` 由 003_ai_db_evolution.sql 建在 **AI 私有库 ai_db**，
--   而部署脚本是 `mysql <业务库> < 文件`（业务库如 liquor_inventory）。
--   原脚本写裸 `UPDATE ai_sample` ⇒ 打到业务库 ⇒ ERROR 1146
--   ⇒ 每次部署都 fail（run 37665016905 起成为常驻红灯）。
--   按全仓统一口径，本文件所有引用一律显式写 `ai_db.ai_sample`（见 README §二.6）。
--
-- ⚠️ 缺表不中断（2026-10-08 新增）：
--   本脚本是**存量数据回填（DML）**，不是结构必需项。表不存在时打印「跳过」并 EXIT=0，
--   不阻断部署；结构完整性由 `/api/health/ready` 就绪探针终判（部署脚本第 6.1 步）。
--   对比：DDL 脚本（003/007）缺表 = 结构不完整，必须报错让部署红 —— 两类区别对待，
--   否则缺表会被静默吞掉，反而制造"假绿"。
--
-- ⚠️ 幂等：WHERE task_type IN (<19 个工具名>) 精确限定，重跑命中 0 行，
--   结果与跑一次完全一致。不使用 ADD COLUMN / ADD INDEX，故无需 information_schema
--   的加列判定；只做一次 information_schema.TABLES 的**存在性**判定。
--
-- ⚠️ 实现说明：原 19 条独立 UPDATE 合并为 1 条 CASE 更新（语义等价 ——
--   原文件已论证 19 条互不干扰、执行顺序无关；且 docType 全 snake_case、
--   工具名全 camelCase/api_ 前缀，互不相交）。合并是为了让"缺表跳过"的守卫
--   只需一处 PREPARE，不必为 19 条各写一遍（19×4 行守卫反而更易写错）。
--
-- ⚠️ 本脚本【只写不执行】：生产是否回填由审查方/用户决策。
--   确认方式：先跑末段核验 SELECT（回填前应显示为工具名残留行数 > 0）。
--
-- ⚠️ 依赖会话变量（PREPARE），本文件必须**整文件执行**，不可按分号拆分到多连接逐条执行。
--
-- ⚠️ 注释规范：行注释引导符后必须留一个空白，否则 MySQL 报 1064。

SET @ai_sample_exists := (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = 'ai_db'
     AND TABLE_NAME = 'ai_sample'
);

-- 1) 回填：19 个工具名 → 14 类 docType（单条 CASE，一次扫表）
SET @ddl := IF(
  @ai_sample_exists = 0,
  'SELECT ''ai_db.ai_sample 不存在，跳过回填'' AS skip_reason',
  'UPDATE ai_db.ai_sample
      SET task_type = CASE task_type
        WHEN ''createCustomer''              THEN ''customer_create''
        WHEN ''createProduct''               THEN ''product_create''
        WHEN ''updateProductPrice''          THEN ''price_update''
        WHEN ''createSalesOrder''            THEN ''sales_order''
        WHEN ''createSalesReturn''           THEN ''sales_return''
        WHEN ''createPurchaseOrder''         THEN ''purchase_order''
        WHEN ''api_create_purchase_return''  THEN ''purchase_return''
        WHEN ''createDelivery''              THEN ''delivery''
        WHEN ''createPaymentReconciliation'' THEN ''receipt''
        WHEN ''api_create_purchase_payment'' THEN ''payment''
        WHEN ''createRefund''                THEN ''refund''
        WHEN ''inventoryTransfer''           THEN ''inventory_transfer''
        WHEN ''stockCheck''                  THEN ''inventory_check''
        WHEN ''api_create_flash_sale''       THEN ''promotion''
        WHEN ''createCouponTemplate''        THEN ''promotion''
        WHEN ''createFullReduction''         THEN ''promotion''
        WHEN ''createGroupBuy''              THEN ''promotion''
        WHEN ''createGiftRule''              THEN ''promotion''
        WHEN ''createLimitedDiscount''       THEN ''promotion''
        ELSE task_type
      END
    WHERE task_type IN (
      ''createCustomer'', ''createProduct'', ''updateProductPrice'', ''createSalesOrder'',
      ''createSalesReturn'', ''createPurchaseOrder'', ''api_create_purchase_return'',
      ''createDelivery'', ''createPaymentReconciliation'', ''api_create_purchase_payment'',
      ''createRefund'', ''inventoryTransfer'', ''stockCheck'', ''api_create_flash_sale'',
      ''createCouponTemplate'', ''createFullReduction'', ''createGroupBuy'',
      ''createGiftRule'', ''createLimitedDiscount''
    )'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2) 核验 SELECT：remaining_tool_name_rows 应为 0（非 0 说明仍有工具名残留）
--    total_rows 为样本总行数
SET @ddl := IF(
  @ai_sample_exists = 0,
  'SELECT ''ai_db.ai_sample 不存在，跳过核验'' AS skip_reason',
  'SELECT
     (SELECT COUNT(*) FROM ai_db.ai_sample WHERE task_type IN (
        ''createCustomer'', ''createProduct'', ''updateProductPrice'', ''createSalesOrder'',
        ''createSalesReturn'', ''createPurchaseOrder'', ''api_create_purchase_return'',
        ''createDelivery'', ''createPaymentReconciliation'', ''api_create_purchase_payment'',
        ''createRefund'', ''inventoryTransfer'', ''stockCheck'', ''api_create_flash_sale'',
        ''createCouponTemplate'', ''createFullReduction'', ''createGroupBuy'',
        ''createGiftRule'', ''createLimitedDiscount''
      )) AS remaining_tool_name_rows,
     (SELECT COUNT(*) FROM ai_db.ai_sample) AS total_rows'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 回填后分布核对（人工阅读输出即可，无需断言）：确认 14 类 docType 已出现，
--    且原本就合规的存量值（如 office_document / write / analysis）原样保留。
SET @ddl := IF(
  @ai_sample_exists = 0,
  'SELECT ''ai_db.ai_sample 不存在，跳过分布核对'' AS skip_reason',
  'SELECT task_type, COUNT(*) AS cnt
     FROM ai_db.ai_sample
    GROUP BY task_type
    ORDER BY cnt DESC'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
