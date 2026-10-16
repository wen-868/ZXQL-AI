# R101-AI-29 · 存储形态 A1-spike（LibSQL 嵌入可行性验证）

> 依据：`docs/tasks/派单规范.md` §一 + §三；**来源 = 业主已采纳《存储选型评审报告》（多维加权）方案 A：分形态选型**
> 队列登记：`docs/tasks/当前批次.md` 文末「ZXQL-AI 线路」块
> ⚠️ **本单是可行性验证（spike），不是改造。目标是产出"能不能做、怎么做、代价多大"的结论，供凌舟决定后续是否投入**

---

【派单 R101-AI-29】LibSQL 嵌入可行性验证（standalone 存储形态 A1-spike）
派单人：凌舟（总负责人）｜2026-10-13
执行方：阿坚（后端架构）（仓库 `D:\Users\ZXQL\ZXQL-AI`，分支 `main`，**基线 `f22ddbc`**）
优先级 / 时间盒：P1 · 半天（**严格控制在半天；验证不出就报"不可行 + 卡在哪**）

## 背景与依据（凌舟已核实，无需重复探查）
- 业主已采纳《存储选型评审报告-多维加权-20261013.md》方案 A：**分形态选型** ——
  - **桌面端 standalone** ⇒ **LibSQL 嵌入**（单文件 `data/app.db`，零服务进程）
  - **共享/云端 connected** ⇒ **保持 MySQL**（生产多租户真源，代码零改动）
- 耦合面实测（凌舟已查）：MySQL 强耦合很小 —— `ON DUPLICATE KEY` **4 处**（audit-logger:439/462/494 + ai-usage-daily.entity:19）、事务 **1 处**（evolution-version:161）、`FOR UPDATE` 1 处；178 处 `NOW()` 命中多数是 JS `Date.now()` 误报
- 迁移现状：**17 个 .sql 单套**（无 mysql/ sqlite/ 子目录）；双连接：`database.module.ts:78 type:'mysql'` + `ai-db.module.ts`（4 表）
- **关键未知（本单要回答的）**：项目用 **TypeORM 1.1.0**（很新的大版本），其 driver 是否支持 LibSQL/SQLite？支持方式是什么？

## 交付物（验证结论 + 最小证据，不改业务代码）
1. **驱动可行性**（核心）：
   - TypeORM 1.1.0 能否用 `@libsql/client@0.18`（或 better-sqlite3）作 driver 建 DataSource？
   - 若能：给出最小可用配置（`type`/`driver`/连接参数形态）
   - 若不能：说明卡点（缺 driver？需自定义 driver？需降到 TypeORM 0.3.x？），并给出**替代路径建议**
2. **Entity 映射验证**：挑 **3 个有代表性的实体**验证：
   - `AiAuditLogEntity`（含 JSON/长文本）
   - `AiUsageDailyEntity`（**含 ON DUPLICATE KEY 语义 + 唯一键**）
   - `AiIdempotencyEntity`（**含唯一键 uk_ai_idempotency + DATETIME(3) 毫秒**）
   ⇒ 确认列类型/唯一键在 SQLite/LibSQL 下能正确建表
3. **幂等语义等价验证**（最关键）：
   - MySQL `ON DUPLICATE KEY UPDATE` ⇒ SQLite `ON CONFLICT(...) DO UPDATE` 语义是否等价？
   - 用 AI-21 幂等闸门的**认领场景**（INSERT in_flight；冲突 ⇒ 回放/处理中/失败重试）写一个最小验证，确认**仲裁行为一致**
4. **迁移双套方案**：现有 17 个迁移如何组织（`migrations/mysql/` + `migrations/sqlite/` 子目录？还是生成策略？）给出**推荐结构与改造量估算**

## 验收标准（硬）
1. 给出**明确的"可行 / 不可行"结论**（两者都算完成，**不许含糊**）
2. 驱动配置有**可运行的最小证据**（能连上、能建表、能读写）
3. 幂等语义等价性有验证输出（含"冲突场景"的实际行为）
4. 迁移双套方案有推荐结构与工作量估算
5. **不改任何业务代码**、不改生产配置、不引入到 `app.module`（只在独立验证脚本/临时模块里跑）

## 红线
- **不得修改 `src/` 下任何业务文件**（本单只产出验证脚本 + 结论；脚本放在 `scripts/` 或临时目录，**验证完保留作为证据**）
- 不得改 `package.json` 的既有依赖版本（可新增 devDependency 用于验证，需注明）
- 不得碰 `.env` 生产配置
- 不得降低 TypeORM/其它既有依赖版本（如需降级才能支持 LibSQL —— 记为"不可行的代价"，由凌舟决定是否接受）
- junction worktree 内严禁 `pnpm`（[168]）；禁 `stash`/`checkout`/`reset`/`commit`/`push`（[165]）
- **半成品铁律**：验证脚本跑不通就报"卡在哪"，不许硬凑结论
- 回传落 `docs/reports/R101-AI-29-阿坚-回传.md`，十项格式（含 ref=`f22ddbc`）

## 回传格式（十项，缺项无效）
```
【汇报 R101-AI-29-R】对应派单 R101-AI-29 <一句话结论：可行/不可行 + 关键依据>
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜<YYYY-MM-DD>
交付物：<驱动结论 + 3 实体映射证据 + 幂等等价验证 + 迁移双套方案>
证据（可复跑）：<验证脚本路径 + 运行输出摘要 + ref=f22ddbc>
验收自评：<逐条对照 5 条硬标准，通过/未通过 + 依据>
未完成与阻塞：<逐条；没有也要写"无">
风险与自我报备：<若不可行，替代路径与代价；若可行，后续改造的隐藏风险>
回传要求：本汇报已落卡：docs/reports/R101-AI-29-阿坚-回传.md
关联卡：docs/tasks/cards/R101-AI-29-LibSQL可行性验证.md
```

## 备注（给执行方）
本项目《存储选型评审报告》已把"部署体验(25%)""可维护性(20%)"列为最高权重 —— 业主诉求是**桌面端零服务安装**。若 LibSQL 路线不可行，**替代候选排序**：better-sqlite3+WAL（8.45）→ 便携 MariaDB（8.10）。请在结论里明确推荐其中哪一条作为 fallback。
