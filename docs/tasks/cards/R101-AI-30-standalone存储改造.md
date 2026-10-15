# R101-AI-30 · standalone 存储改造：better-sqlite3 嵌入落地（A2）

> 依据：ADR-001（据 R101-AI-29 spike 实证修订）、《存储选型评审报告》方案 A
> 队列登记：`docs/tasks/当前批次.md` 文末「ZXQL-AI 线路」块
> 前置：R101-AI-29 已完成（LibSQL 不可行；better-sqlite3 实测可行，证据包 `scripts/spike-libsql/`）

---

【派单 R101-AI-30】standalone 存储改造：better-sqlite3 嵌入（双形态装配）
派单人：凌舟（总负责人）｜2026-10-14
执行方：阿坚（后端架构）（仓库 `D:\Users\ZXQL\ZXQL-AI`，分支 `main`，**基线 `b652347`**）
优先级 / 时间盒：P1 · 3.5~5 人日（按 spike 估算，可分步交付）

## 目标
按 `INTEGRATION_MODE` 装配存储：
- **standalone**（桌面端）⇒ **better-sqlite3 嵌入**（`data/app.db`，WAL）
- **connected**（共享/云生产）⇒ **MySQL 不变**（生产零改动）

## 交付物（按 spike 实证的 F1~F6 + 乙案）
1. **实体类型适配**（F1/F2/F3）：`char`→`varchar`；`mediumtext`→`text`；`bigint` 主键→`integer`（AUTOINCREMENT 限制）
2. **SQL 方言**（F5）：4 处 `ON DUPLICATE KEY UPDATE`（audit-logger:439/462/494、ai-usage-daily.entity:19）→ `ON CONFLICT(…) DO UPDATE`
3. **判重扩方言**（F4，关键）：现有 `isDuplicateKeyError()` 不认 SQLite（`SQLITE_CONSTRAINT_UNIQUE`/errno undefined）⇒ 扩展为双方言判重（MySQL `ER_DUP_ENTRY/1062` + SQLite `SQLITE_CONSTRAINT_UNIQUE`）
4. **decimal 核查**（F6）：`decimal(12,4)` 读回 number（MySQL 读回 string）⇒ 核查单价/用量/计费三处金额处理点，确保语义一致
5. **迁移乙案**：桌面端**单基线** —— `migrations-sqlite/000_baseline.sql`（由实体 synchronize 生成一次并固化）+ 增量脚本方案；**不逐个移植 17 个迁移**
6. **运行时双模式**：`INTEGRATION_MODE=standalone|connected` 装配不同 driver（standalone→better-sqlite3；connected→mysql）；Redis：standalone 走内存+持久化，connected 启用 ioredis
7. **打包适配**：native 模块需 **arm64**（本机 `PROCESSOR_ARCHITECTURE=ARM64`）+ Electron rebuild（`desktop/`）

## 验收标准（硬）
1. `tsc` 0 / `eslint "src/**/*.ts" --max-warnings=0` 0 / `jest --ci` 全绿，**不少于 153 套件 / 1683 用例**（两种形态下分别跑通：connected 用 MySQL 与现状一致；standalone 用 sqlite 须同样全绿）
2. **AI-21 幂等反测 5 条在 sqlite 形态复跑通过**（含冲突/回放/处理中/失败重试/去重）
3. 判重双方言有验证（MySQL 1062 与 SQLite SQLITE_CONSTRAINT_UNIQUE 均被识别）
4. 金额 decimal 读回差异已处置（有核查结论）
5. standalone 模式可启动并能完成一次完整对话（不连 MySQL/Redis）
6. **打包 = 单包兼容**（业主 2026-10-14 明确：不做 x64 / arm64 双包，做一个兼容包；原「arm64 rebuild」验收并入本条）：
   - 产出**一个**安装包（便携版同理），同时适配 x64 与 arm64 —— 包内含双架构 native（better-sqlite3 的 x64 + arm64 产物），安装脚本按 `PROCESSOR_ARCHITECTURE` 装配对应 native
   - **不靠 x64 仿真**（native 模块架构不匹配 ⇒ 加载失败）
   - 双架构实机验证：x64 机器、arm64 机器各自装 ⇒ 启动 + standalone 完整对话可用
   - 若 electron-builder 不支持单包双 arch ⇒ 明确报卡点由凌舟定（最终 fallback：便携 MariaDB 8.10 或双包方案）

## 红线
- **生产 MySQL 路径零改动**（connected 形态行为必须与现状一致：153 套件基线不变）
- 不得降低既有依赖版本；新增 `better-sqlite3` 需与 TypeORM peer `^12` 匹配（spike 用 12.11.1 / SQLite 3.53.2）
- 不得 `.skip`、不得改既有断言凑绿；**反测不可省略**
- 不得删除/简化 spike 证据包 `scripts/spike-libsql/`（作为本次改造的依据留档）
- junction worktree 内严禁 `pnpm`（[168]）；禁 `stash`/`checkout`/`reset`/`commit`/`push`（[165]）
- **半成品铁律**：分步交付时每一步都必须门禁全绿，不许留中间态

## 回传格式（十项，缺项无效）
```
【汇报 R101-AI-30-R】对应派单 R101-AI-30 <一句话结论>
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜<YYYY-MM-DD>
交付物：<F1~F6 + 迁移乙案 + 双模式装配 + 打包适配>
证据（可复跑）：<命令 + 输出摘要 + AI-21 反测 sqlite 复跑结果 + 双形态门禁数字 + ref=b652347>
验收自评：<逐条对照 6 条硬标准，通过/未通过 + 依据>
未完成与阻塞：<逐条；没有也要写"无">
风险与自我报备：<arm64 rebuild 结论；decimal 处置结论；没有也要写"无">
回传要求：本汇报已落卡：docs/reports/R101-AI-30-阿坚-回传.md
关联卡：docs/tasks/cards/R101-AI-30-standalone存储改造.md
```

## 备注
- spike 已证：better-sqlite3 在本机 arm64 可用；`ON CONFLICT` 与 MySQL `ON DUPLICATE KEY` 仲裁等价
- 若 arm64 native 模块不可得 ⇒ 立即上报（这是桌面端交付的硬卡点），由凌舟决定是否改 x64 目标或换方案（便携 MariaDB 8.10 为最终 fallback）
