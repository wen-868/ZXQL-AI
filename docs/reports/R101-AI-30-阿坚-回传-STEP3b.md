# R101-AI-30 STEP3b 回传 · AI-21 幂等在真实 sqlite 库复跑（4/5）

> 承接 F10 修复（凌舟 `95b99da`：基线补 `CREATE UNIQUE INDEX "uk_ai_idempotency"`）
> 门禁：`tsc` 0 / `eslint --max-warnings=0` 0 / **jest 158 套件 1729 用例全绿**（157/1725 + 本步 1 套件 4 例）
> 验收项：R101-AI-30 第 3 步交付物 3「AI-21 反测 5 条在真实 sqlite 库复跑」→ **4 条完成**（第 5 条属 ToolExecutor 层，见"未完成"）

## 回传（十项格式）

```
【汇报 R101-AI-30-R-STEP3b】对应派单 R101-AI-30 第 3 步：**AI-21 幂等在真实 sqlite 库上复跑 4/5 条全绿**（真 better-sqlite3 库 + 基线建表 + 真内存 Redis + 真仓储）；F10 修复后 ② 由 proceed 变 replay、③ mutation 基线成立；第 5 条"预览不耗键"属 ToolExecutor 层未做；冷启动+完整对话与 STEP2c 集成级收尾仍未做
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜2026-10-14
交付物：
  1. **新增集成 spec**：`src/tools/idempotency-gate.sqlite.spec.ts`（4 例）
     - 真链路：**基线 SQL 建表**（`migrations-sqlite/000_baseline.sql`，**不用 `synchronize:true`** —— 落实你的 F10 结论）
       + 真 `better-sqlite3` DataSource + **真内存 Redis**（`RedisMemoryClient`，STEP2c）
       + 真 `Repository<AiIdempotencyEntity>` 灌进 `IdempotencyGateService`
     - standalone 实体用 `jest.isolateModules` 重加载（守"方言在模块加载期求值"约束）
  2. 覆盖场景（4 条）：
     ① 同令牌回放：认领 → `complete` → 再 `check` ⇒ **replay**（回放结果带 `idempotent_replay` 类标记 ⇒ 断言用 `toMatchObject`），库中**仅 1 行**
     ② **清空 Redis（TTL/重启）后仍 replay** ⇒ 真库唯一键兜底（**F4 在真驱动 + 真库上生效**）
     ③ mutation 等价：`DROP INDEX "uk_ai_idempotency"` 后再清 Redis ⇒ **不再 replay** 且行数 > 1
        （= 你要的"去 MySQL 唯一键 ⇒ 红"的可执行证据；F10 修复前本用例正是因"没有唯一键可撞"而失败）
     ④ DB 不可用（非唯一键错误，`ds.destroy()`）⇒ **fail-open 放行**（裁定 B）
  提交哈希：**未提交**（等你收口）
证据（可复跑）：
  - `$ node node_modules/jest/bin/jest.js --ci src/tools/idempotency-gate.sqlite.spec.ts`
      √ ① 同令牌回放：认领 → 完成 → 再提交 ⇒ replay（带 idempotent_replay），库中仅 1 行
      √ ② 清空 Redis（TTL/重启）后仍 replay ⇒ 真库唯一键兜底（真驱动真库上的 F4）
      √ ③ mutation 等价：去掉唯一索引 ⇒ 兜底失效（"去唯一键红"的证据）
      √ ④ DB 不可用（非唯一键错误）⇒ fail-open 放行（裁定 B，不阻断用户）
      Tests: 4 passed, 4 total
  - 全量：`jest --ci` → **Test Suites: 158 passed / Tests: 1729 passed**；`tsc` 0；`eslint --max-warnings=0` 0
  - 既有 spec 零改动：本步**只新增** 1 个 spec 文件，未改任何既有断言
验收自评：
  1. 三门禁 ≥157/1725 → **通过**（158/1729）
  2. AI-21 反测 5 条真库复跑 → **4/5 通过**（第 5 条"预览不耗键"未做，属 ToolExecutor 层）
  3. `data/app.db` 含基线表结构 → **通过**（STEP3 已交；本步用**同一基线**建库，等于二次验证基线可用）
  4. 既有 spec expect 删除/修改 = 0 → **通过**
未完成与阻塞（如实）：
  1. **第 5 条"预览不耗键"**：需 ToolExecutor 层集成（`isWriteOperation && args.confirm===true` 才认领；预览不得消耗键）——属工具执行链，非闸门层
  2. **standalone 冷启动 + `/api/health` 200 + 一次完整对话**（DB/Redis 两侧已就绪，待启动入口 env 注入 + 探针 + 对话链路）
  3. **STEP2c 集成级收尾**：write-guard 仅持有者可释放（换内存 Redis 实测）+ AI-23 四条反测内存态全链路（client 级已 16 例绿）
风险与自我报备：
  1. **F10 的教训已落进代码**：集成/基线验证**必须用基线 SQL 建表**（`synchronize:true` 建不出 DB 层唯一键，
     会掩盖"无键可撞"的缺口）——本 spec 已按此写，并在注释中固化该结论。
  2. **`idem_key` 必须用闸门 `handle.idemKey`**（含盐哈希，非明文 sha256）——本 spec 通过闸门自身产键（未手造行），天然规避该坑；
     若后续要手造行/直接断言唯一键，务必用 `handle.idemKey`。
  3. 本步**未动** `src/` 生产代码（仅新增测试），故 standalone 行为与 STEP3 一致。
回传要求：本汇报已落卡：docs/reports/R101-AI-30-阿坚-回传-STEP3b.md
关联卡：docs/tasks/cards/R101-AI-30-standalone存储改造.md
```

## 附：本步改动（未提交）
| 文件 | 说明 |
|---|---|
| `src/tools/idempotency-gate.sqlite.spec.ts` | 新增：AI-21 真 sqlite 集成 4 例（基线建表 + 真内存 Redis + 真仓储） |

未改 `src/` 生产代码、未改既有 spec、未 .skip、未 commit / push / stash、未动 package.json / lockfile。
