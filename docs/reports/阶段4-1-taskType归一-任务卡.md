# 阶段 4-1 · taskType 口径归一（进化飞轮断链修复）· 外派任务卡

- 派发日期：2026-10-08
- 派发方：林夕（审查/ 规划，不代写业务代码）
- 仓库：`D:\Users\ZXQL\ZXQL-AI`（远程 `wen-868/ZXQL-AI`）
- 目标提交基线：`1b40d22`
- 优先级：**P0**（这是全清单唯一「功能完全不可用」项—— 自动捕获样本 100% 进不了 few-shot 池）

---

## 一、缺陷陈述（已由审查方逐行核实，非推测）

进化飞轮有采集侧与消费侧，两侧对`ai_sample.task_type` 的取值口径不一致，导致 few-shot 回流永久失效。

### 取证（基线 `1b40d22`，命令与输出）

**采集侧（存工具名）**
```
src/brain/orchestrator.service.ts:1294:          intent: toolName ?? 'chat',
src/evolution/capture.service.ts:106:            taskType: input.intent ?? input.domain,
```

**消费侧（查裸 docType，精确相等）**
```
src/brain/extraction/structured-extractor.ts:141:  const base = docType.replace(/^write_schema\./, '');
src/brain/extraction/structured-extractor.ts:144:  { tenantId, taskType: base, quality: MoreThanOrEqual(4) },
src/brain/extraction/structured-extractor.ts:145:  { tenantId, taskType: base, quality: MoreThanOrEqual(3) },
```

**映射表存在，但只在消费侧被调用**
```
src/brain/extraction/write-schema-registry.ts:534: export function docTypeForTool(toolName: string): string | undefined
src/brain/extraction/structured-extractor.ts:302:   const docType = docTypeForTool(input.toolName);← 仅此一处调用
```
全仓 `grep docTypeForTool` 结果：定义 1 处 + 调用 1 处（`structured-extractor.ts:302`）+ 测试 8 处。
⇒ **采集侧从未调用**，属半截修复。

### 断链

| 环节 | 值 |
|---|---|
| 工具名（写入） | `createSalesOrder` |
| docType（查询） | `sales_order` |
| 比对方式 | TypeORM `find({ where: [{ taskType: base }] })` 字符串精确相等 |
| 结果 | 永不相等 ⇒ 样本 100% 不命中 |

---

## 二、🔴 关键发现：`ai_sample` 全仓只有一个写入口

**这条改变了方案形状，是本卡最重要的取证结果。** 审查方实测：

```
InjectRepository(AiSampleEntity, AI_DB_CONNECTION) 出现 4 处：
  src/brain/extraction/structured-extractor.ts:112    ← 只读（find）
  src/evolution/capture.service.ts:67← 写
  src/evolution/e4-distillation.service.ts:61        ← 只读
  src/evolution/evolution-version.service.ts:120     ← 只读

sampleRepo.save|insert|upsert|insertMany 命中：
  src/evolution/capture.service.ts:103   ← 全仓唯一写入点
```

⇒ **归一化只需改这一处即可全量收口**，无需去每个消费侧加兼容分支。
（此结论已由审查方独立核实，非推断。请实施方**再复核一遍**这两个 grep，若发现第五个写入口，立即停下报告。）

### 三个调用方汇入同一 `intent` 字段

| 调用方 | 传入 `intent` | 归一后应为 |
|---|---|---|
| `orchestrator.service.ts:1294` | `toolName`（如 `createSalesOrder`） | `sales_order` |
| `office-evolution.service.ts:80` / `:123` | `taskType`（默认 `office_document`，来自 `employee.controller.ts:159` 的 `dto.taskType`） | 原样保留（注册表 14 类中无此域） |
| `capture.service.ts:106` 兜底 | `input.domain`（`write` / `analysis`） | 原样保留 |

**⚠️ 归一必须是「查表命中才替换」，不得用任何字符串拼接/驼峰转下划线之类的规则推导** —— `office_document`、`write`、`analysis` 都不在注册表里，规则推导会把它们错改成不存在的 docType。

---

## 三、注册表事实（实施方可直接用，仍建议自行 Read 确认）

`src/brain/extraction/write-schema-registry.ts:56`起 `WRITE_SCHEMAS`，14 类，docType 全部**无 `write_schema.` 前缀**：

```
customer_create  product_create   price_update    sales_order
sales_return     purchase_order   purchase_return delivery
receipt          payment          refund          inventory_transfer
inventory_check  promotion
```

工具名**全局唯一、无歧义**（逐条核实 14 组`toolNames`）：
```
createCustomer     createProduct        updateProductPrice  createSalesOrder
createSalesReturn  createPurchaseOrder  api_create_purchase_return
createDelivery     createPaymentReconciliation           api_create_purchase_payment
createRefund       inventoryTransfer    stockCheck
promotion ← api_create_flash_sale / createCouponTemplate / createFullReduction /
             createGroupBuy / createGiftRule / createLimitedDiscount
```
⇒ 工具名 → docType 是**单射**（19 个工具名无任何一个跨 docType），回填时不会有
「一个工具名映射到两个 docType」的歧义。**注意不是双射**：`promotion` 一对6，
共 14 类 docType / 19 个工具名，函数非满射。

> ⚠️ **2026-10-08 实施方更正（p4-worker，已落盘）**：上两处原表述有误，以代码为准。
> ① 第 97 行 `createLimiteddiscount` 拼写错误，实为 `createLimitedDiscount`（大写 D，
> 见 `write-schema-registry.ts:437`）。照原拼写回填会静默漏掉该工具名的存量样本。
> ② 「双射」不成立，应为「单射」——结论方向（无二义）不变，但若有人基于「双射」假设
> 写反向回填（docType → 工具名）会直接出错。
> 取证与完整对照表见 `阶段4-1-taskType归一-执行报告.md` 第二节。

###消费侧口径已确认一致
- `structured-extractor.ts:141` 先剥 `write_schema.` 前缀再查
- `evolution-version.service.ts:274-281` 已做「裸docType + 带前缀」双兼容查询，注释明确写「样本表 taskType 有两种约定」

⇒ **归一目标口径无歧义：写入裸 docType**（与现有消费侧兼容，无需改消费侧）。

---

## 四、实施要求

### R1归一逻辑落在 `capture.service.ts`

在 `src/evolution/capture.service.ts` 的 `captureTask` 内，落库前对 `taskType` 做归一：

- 输入候选依次为 `input.intent` → `input.domain`
- 对候选调用 `docTypeForTool(candidate)`；命中则用返回的 docType
- 未命中则**原样保留候选**（不要丢，不要改成空串，不要写占位符）
- 归一结果只影响 `taskType` 字段，**不得改动 `input.intent` 本身**（它同时写入 `ai_experience.intent`，见 `:92`，那里存工具名是正确的，不要一起改）

### R2 存量回填 —— 提供迁移脚本，**默认不启用**

生产库可能已有工具名样本。回填脚本要求：
- 写成 `migrations/013_backfill_sample_task_type.sql`
- 按本卡第三节的 14 组映射做 `UPDATE ... WHERE task_type = '<工具名>'`
- **幂等**：必须用 `information_schema` 判定或 `WHERE task_type IN (...)` 限定，重复执行结果一致
- ⚠️ **MySQL 8.0 不支持 `ADD COLUMN/INDEX IF NOT EXISTS`**（那是 MariaDB 语法），动态 SQL 走 `PREPARE`
- ⚠️ SQL 注释 `--` 后必须至少留一个空白，否则 1064；中英文混排时全角括号紧跟 `--` 极易踩坑
- 自检：`grep -nE "^\s*--[^ \t-]" migrations/013_*.sql` 应无输出
- **脚本写好但不要在生产执行**，是否执行由审查方/用户决定

### R3 契约测试（必须，反测要能变红）

新增 `src/evolution/capture-tasktype-normalize.spec.ts`（或并入既有 `capture.service.spec.ts`），至少覆盖：

1. 工具名被正确归一：`intent: 'createSalesOrder'` ⇒ 落库 `taskType === 'sales_order'`
2. 非注册表值原样保留：`intent: 'office_document'` ⇒ `taskType === 'office_document'`
3. 兜底值原样保留：`intent: undefined, domain: 'write'` ⇒ `taskType === 'write'`
4. 归一**不污染** `ai_experience.intent`：落库 experience 的 `intent` 仍为原工具名 `'createSalesOrder'`
5. 全部 14 个 docType 至少各有一条覆盖（可用 `it.each`）

**反测要求（硬性）**：审查方会把归一逻辑改回「不归一」（即恢复 `taskType: input.intent ?? input.domain`），此时上述用例**必须变红**。若全绿，说明用例没在测东西。

---

## 五、门禁（实施方自跑，审查方会独立复跑）

必须在**纯净 HEAD 的独立 worktree** 一次性跑全量：

```bash
git worktree add --detach "C:/Users/XIONG/AppData/Local/Temp/p4-verify" 1b40d22
# 依赖链接用 PowerShell（Git Bash 的 ln -s 对 TS 无效，报 TS2307）：
#   New-Item -ItemType Junction -Path "<worktree>/node_modules" -Target "<repo>/node_modules"
cd <worktree>
npx eslint . --ext .ts --max-warnings=0     # 通过时零输出 + exit 0
npx tsc -p tsconfig.build.json --noEmit    # CI 用这个
npx tsc -p tsconfig.json --noEmit          # 含 spec，CI 不查这个，必须自己查
npx jest                                   # 全量，不许 -t 过滤、不许 skip
```

> ⚠️ `tsconfig.build.json` 的 `exclude` 含 `**/*spec.ts` ⇒ **CI 绿灯 ≠ 类型干净**。判「类型是否干净」必须用 `tsconfig.json`。
> ⚠️ 分批 + 后台跑会被 SIGTERM 中断而漏文件。必须一次性全量。
> ⚠️ 报数字必须是你自己跑出来的，不许引用历史数字或本任务卡里的基线数字。

---

## 六、纪律要求（血泪教训，逐条适用）

1. **不采信自述**：实施完成后请给出**命令原文 + 完整输出尾部**（套件数、用例数、exit code），不要只给结论。
2. **技术断言请独立核实**：本卡第三节列的注册表事实是审查方核实的，但请自行 Read 确认后再依赖。若发现与本卡描述不符，**以代码为准并在报告中标明**。
3. **批量替换必须带 assert**：一律用 Edit 工具；确需脚本时用 `assert old in s`，改完grep 复核。
4. **改代码必须同步改 spec**，否则 spec 会把错误行为固化成「正确断言」。
5. **清理临时文件**：探针脚本（如 `tmp-*.ts` / `*.cjs`）不要提交。
6. 提交信息用中文，写明「改了什么 + 为什么」。

---

## 七、交付物

1. 代码改动（`capture.service.ts` + 契约测试）
2. `migrations/013_backfill_sample_task_type.sql`（写好，不执行）
3. 执行报告：`docs/reports/阶段4-1-taskType归一-执行报告.md`，含门禁输出原文
4. 明确回答：门禁四项各是什么结果？反测是否验证过（改回不归一后哪些用例红了）？第三节的注册表事实是否与你核实的一致？

## 八、不在本卡范围（另立）

- 无 Schema 域产出无效制品（注册表仅 14 类，未知域 → `ok=false` ⇒ 提案永不激活）
- E2 萃取无自动触发（唯一入口 `ai-db.controller.ts:198` 手动 POST /extract）
- `cleanupExpired()` 无生产调用方（`confirmation.service.ts:229` `executedMap` 无界累积；`:664` 有虚假保证注释）
- 6 张表无 DDL
- 阶段 3（并发/幂等基础设施）—— 另派设计调研卡
