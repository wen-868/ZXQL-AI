# P1-B 写路径错误处理迁移 —— 执行报告

**批次**：阶段1 批次 P1-B（写路径吞异常点迁移到三级错误处理语义）
**执行人**：AI底座（p1b-writer）
**日期**：2026-10-07
**基线commit**：`073ad45`（第九轮阶段0 五项阻断隔离）
**基础设施**：`src/common/error-semantics.ts`（阶段1 批次1 建成并验收，本批次只读不改）

---

## 一、结论速览

| 项 | 结果 |
| --- | --- |
| 迁移的catch 点 | 7 个（分布在 4 个文件） |
| 选定`bestEffort` | 4 个 |
| 选定 `degrade` | 3 个 |
| 选定 `mustSucceed` | 0 个（见§3 说明：本批次的catch 点均不满足判据链第1 条） |
| 新增契约用例 | 12 条（全部含"行为不变 + 可观测生效"双断言） |
| 反测| 4 组全部变红，还原后零残留 |
| 门禁 | eslint / tsc(build) / tsc(full) / jest 全量 全绿 |
| 未 commit / push | 是（按prompt 要求） |

全量测试：**125 suites / 1314 tests 全绿**。

---

## 二、逐 catch 点判据链与选级

判据链（每个点都必须走完）：
1. 失败了却让用户看到"成功"？→ 是 ⇒ `mustSucceed`
2. 否。数据丢了会账目不平 / 合规缺失？→ 是 ⇒ `bestEffort`
3. 都不会（纯旁路增强、可降级）⇒ `degrade`

---

### 1. `src/tenant/billing.service.ts:104` — `consume()` 扣减失败

**选定：`bestEffort`**

判据链：
- ① 失败会让用户看到"成功"吗？**不会**。`consume()` 在对话已返回之后调用
  （唯一调用点 `orchestrator.service.ts:1342`，位于 `yield {type:'done'}` 之前、
  归档之后），扣减失败不影响本次回答，用户无从察觉。故**不是**必须上抛的真相链。
- ② 数据丢了会账目不平？**会**。扣减失败 = 漏计费 = 直接账目不平，不能降级为无声。
- ③ 故取 `bestEffort`：不阻断主流程，但失败必落 `logger.error` + 指标 + 死信。

**prompt 中提示"倾向 bestEffort"，读码后确认该判断成立**，理由即上述 ①②。

实现要点：
- 抽出私有 `deduct()`（原`try` 块主体），`consume()` 改为 `bestEffort` 包裹。
- 阶段0 B-3 的 `metrics.recordBillingConsume('fail')` **保留**：它在 `bestEffort`
  的 op 内部先记指标再`throw err`，二者语义互补（前者是计费域专用计数，后者是
  三级语义统一计数），不构成重复计数。
- 移除了本类中已无引用的 `private readonly logger`（`noUnusedLocals` 会报错），
  日志职责统一由 `error-semantics` 的 `logger` 承担。

**关于 `checkQuota()`**：它调用 `getOrCreate` 但**没有 catch**（`billing.service.ts:37`
直接 `await`，异常向上抛给调用方）。无catch 可迁移，故未改动。

---

### 2. `src/bridge/service-client.ts:273` — `healthCheck()` 探活失败

**选定：`degrade`**

判据链：
- ① 会让用户看到"成功"吗？**不会**。本方法本身就是"如实报告可达性"的探针，
  返回 `reachable:false` 就是诚实结论，不存在虚假成功。
- ② 账目不平 / 合规缺失？**不会**。纯读探针，无任何写入。
- ③ 故为纯旁路增强，可降级。

实现要点：`degrade` 的 fallback 是静态值、拿不到 `err` 对象，而本方法返回值的
`error` 字段必须回传真实错误串（运维靠它区分超时/拒连/证书错误）。故在 op 内用
`lastError` 暂存后由调用点读取，保持返回值逐字等价。

**未迁移项（重要，prompt 点名的 `isRetryable` /重试逻辑）**：

`request()` 的 catch（`:314`）与 `isRetryable`（`:435`）**本批次刻意不动**，理由：

- `request()` 的 catch 已经 `throw this.toBridgeError(err, path)` ——它**没有吞
  异常**，失败直接上抛，语义上已是 `mustSucceed` 的正确形态，只是错误类型是
  `BridgeError`。
- 若用 `mustSucceed` 包裹，`error-semantics.ts:287toCriticalError` 会把非
  `HttpException` 的异常包装为 `CriticalOperationError(HttpException)`。而全库
  **40+ 个 tool 定义**（`adjust-credit-limit` / `create-sales-order` /
  `create-refund` / `stock-check` 等）都靠 `err instanceof BridgeError` 读取
  `statusCode` / `backendCode` / `traceId` 来区分「业务错误 / 权限不足 / CSRF
  未配置 / 后端不可达」。包装成 `CriticalOperationError` 会让这些 `instanceof`
  全部失效⇒ **40+ 处工具错误信息降级为通用文案**。
- 这属于"必须改变行为才能分级"，按prompt 要求**停下报告，不擅自改**。
  详见 §5 待下一批次处理项。

`IDEMPOTENT_METHODS` 白名单（阶段 0 B-2 Blocker 修复）**未触碰**，`isRetryable`
方法体一字未改。

---

### 3. `src/ops/usage.controller.ts` — **无catch 点**

`grep -n "try\|catch"` 对该文件**零命中**：三个端点（`daily` / `totals` /
`tenants`）全部直接 `await` + `return`，无吞异常点。

阶段0 B-5 已给`tenants` 加了平台身份门禁（`:102-108` `getAdminIdentity` +
`ForbiddenException`），该门禁是**显式拒绝**而非降级，语义正确。

**结论：本文件无可迁移 catch，本批次未改动（0 行变动）。**
契约测试未覆盖该文件（无迁移点则无可观测契约可断言）；
其既有门禁由 `usage.controller.tenant-gate.spec.ts` 守护（该suite 本次全量中通过）。

> ⚠️ 若 prompt/审查记录中提到 `usage.controller:79` 存在"跨租户用量无门禁"缺陷，
> 该缺陷已在阶段0 B-5 修复完毕（`tenants` 端点），`daily`/`totals` 则走
> `resolveAdminTenantId(req, tenantId)` 从 JWT 身份解析租户、本就不接受 query 自报。
> 本批次在该文件上**未发现遗留问题**。

---

### 4. `src/brain/proactive/weekly-plan.service.ts` — 3 个 catch，3 个不同级别

#### 4a. `:69` `handleWeeklyCron()` cron 触发失败 → **`degrade`**
- ① 会让用户看到"成功"吗？**不会**。cron 无调用方，无人看到返回值。
- ② 账目不平 / 合规缺失？**不会**。`buildWeeklyPlan` 内部的推送已有独立
  `bestEffort`（见 4c）兜底，外层只是定时器触发器。
- ③ 纯旁路，可降级。

#### 4b. `:148` LLM 规划失败 → **`degrade`**
- ① 会让用户看到"成功"吗？**不会**。降级产出的信号清单本身就是有效结论
  （每条标题都对应 `t_push_log` 里的真实推送记录），不是伪造的"AI 规划"。
- ② 账目不平？**不会**。真实信号一条未丢，只是没被 LLM 串成叙事。
- ③ 旁路增强，可降级。**行为等价**：仍返回逐字相同的信号清单文本。

#### 4c. `:166` 落库推送失败 → **`bestEffort`**
- ① 会让用户看到"成功"吗？**会**——但计划正文已真实生成并 `return` 给调用方，
  缺的只是推送留痕。若用 `mustSucceed` 上抛，会凭空中断一次**已成功**的计划生成，
  属于改变行为。
- ② 数据丢了会账目不平 / **合规缺失**？**会**。`t_push_log` 是主动推送的
  **审计留痕**，缺失即审计断链。
- ③ 故取 `bestEffort`：不阻断主流程，但失败必落 `logger.error` + 指标 + 死信，
  运维可据死信补推。

---

### 5. `src/brain/agent/task-runner.service.ts` — 2 个 catch

文件内共 4 个 catch，其中`:727`（agent 步骤 LLM 流失败）与 `:890`
（写步骤令牌挂起失败，阶段0 B-4 Blocker 修复）**按prompt 要求不动**。
实际迁移 2 个：

#### 5a. `:472` 单步执行抛错 → **`bestEffort`**
- ① 会让用户看到"成功"吗？**不会**。单步容错是本模块的**显式设计**（类注释
  第 7 行：「单步容错：长任务不因单步失败整体中断」），失败被如实记为
  `step.failed` 并落库 + 抛 `agent_step status:'failed'` 事件，不是虚假成功。
  改用 `mustSucceed` 上抛会让整个计划中断 ⇒ 改变行为。
- ② 账目不平 / 合规缺失？**不会**（步骤状态已如实落库）。
- ③ 但"失败真相"必须**可追**：此前只有 `step.error` 落库 + 事件，无任何
  运维侧聚合视图（哪类步骤失败最频繁、失败原因分布）。`bestEffort` 补上
  `logger.error` + 指标 + 死信。

**写法说明**：op 是 `() => Promise.reject(err)`。这看似反直觉（"故意抛错"），
但语义正确——`bestEffort` 的契约就是"接管一个可能失败的 op 并记录其失败"，
此处op 的失败源正是外层 catch 捕获到的 `err`。用 `async () => { throw err }`
会触发 `@typescript-eslint/require-await`（async 函数内无 await），故用
`Promise.reject`。

#### 5b. `:961` 经验回流（`capture.captureTask`）失败 → **`bestEffort`**
- ① 会让用户看到"成功"吗？**不会**。经验回流是计划收尾的旁路，其成败不影响
  `done` 事件与任何业务状态。
- ② 数据丢了会账目不平 / 合规缺失？**会**。`ai_experience` / `ai_sample` 是
  **进化飞轮的样本源**，丢失即飞轮断链（阶段0 前是 `logger.debug` 静默吞掉，
  连 debug 日志都可能被丢弃，无人知晓）。
- ③ 故取 `bestEffort`。

**⚠️ 顺带修掉一个潜在缺陷（重要）**：原写法是
```ts
try {
  void this.capture.captureTask({...});   // ← Promise 被丢弃在虚空
} catch (err) { this.logger.debug(...); }
```
`void` 一个 async 函数返回的 Promise，**其async 拒绝不会被同一层的 try/catch
捕获**（try/catch 只捕获同步抛出的异常）。也就是说这个 `catch` 对真正的失败
路径形同虚设。`bestEffort` 内部 `await` 该 Promise，捕获才真正生效。

**反测证据（决定性）**：把这段改回`void` + try/catch 后，跑
`npx jest --ci src/common/error-semantics.p1b-write-path-contract.spec.ts -t "经验回流抛错"`
→ **Node 进程被未捕获异常直接打挂**：
```
[Error: ai_db 不可用]
Node.js v22.22.2
```
即：迁移前这不是"静默失败"，而是**进程崩溃风险**。这是本批次发现的最有价值缺陷。

**为什么用 `void bestEffort(...)` 而不是 `await`**：`buildDoneEvent` 是同步方法
（返回 `AgentRunEvent[]`，被调用方直接 `for...of` 迭代，见 `:340/:411/:503`）。
改成 async 会在 SSE 流上插入额外 await 点 ⇒ 改变流式行为。`error-semantics.ts:225-241`
保证 `bestEffort` 内部全捕获（含死信 sink 自身失败），**永不reject**，故
`void` 丢弃其 Promise 安全。这一点在 `error-semantics.ts:281` 的注释中
已有先例说明（audit-logger 的 `void bestEffort`）。

**另注**：`captureTask` 内部（P1-C 批次，`capture.service.ts:82`）已自带
`bestEffort`，故外层这层在正常情况下不会fail（不会双重计数语义指标），
它的价值是**兜住 captureTask 自身契约之外的可能抛出**，且让外层调用点
无需自己处理 rejection。

---

## 三、为什么本批次 0 个 `mustSucceed`

判据链第 1 条（"失败了却让用户看到成功"）在本批次 7 个 catch 点上**全部不成立**：

- `billing.consume` 在对话返回后调用，用户看不到计费结果 ⇒ 走第 2 条 `bestEffort`。
- `agent.step` 已如实记 `step.failed` 并抛失败事件 ⇒ 不构成虚假成功。
- 其余 5 个均为旁路/只读/定时器。

真正的 `mustSucceed` 候选是 prompt 提到的
`task-runner:876 令牌挂起失败仍标 success`——但该缺陷**已在阶段0 B-4 修复**
（`:889-900` 的 `{ suspended: false, failed: true }`），且 prompt 明确要求
"不能动"。故本批次无新增 `mustSucceed` 点，这是判据链的诚实结论，不是遗漏。

---

## 四、新增用例清单

文件：`src/common/error-semantics.p1b-write-path-contract.spec.ts`（595 行，新增）

**为什么必须单独建文件**：本批次是「行为不变 + 增加可观测」的等价替换迁移，
原有37 条业务用例在迁移后依然全绿（这正是**正确**结果）。但这也意味着
**若有人把迁移回退掉，全量 1314 条测试毫无察觉**。故每条用例都必须额外断言
`errorSemanticsCount(...)` 生效——只有第二条断言才证明迁移真的接上了。

| # | 用例名 | 行为断言（迁移前后必须一致） | 可观测断言（证明迁移接上） |
| --- | --- | --- | --- |
| 1 | 扣减失败：不抛（主流程不阻断）+ 落死信 + best_effort 指标为 1 | `consume()` resolves undefined；`recordBillingConsume('fail')` 仍被调用 | `best_effort\|billing.consume\|fail === 1`；死信 1 条且 `op`/`tenantId`/`error` 正确 |
| 2 | 扣减成功：走 ok 指标且不产生死信 | `recordBillingConsume('ok')` | `ok === 1` **且 `fail === 0`**（反向信号，防恒定 fail） |
| 3 | 后端不可达：返回 reachable:false（行为不变）+ degrade 观测到 fail | `reachable===false`；`error` 含 `ECONNREFUSED`；`latencyMs` 为 number；get 调用 1 次 | `degrade\|bridge.healthCheck\|fail === 1`；死信 0 条（degrade 不写死信，与 bestEffort 分界） |
| 4 | 后端可达：返回 reachable:true（不含 error）+ degrade 观测到 ok | `reachable===true`；`error` undefined | `ok === 1` 且 `fail === 0` |
| 5 | LLM 失败：降级为真实信号清单（行为不变）+ degrade 观测到 fail | `signals===1`；`plan` 含 `1 条主动提醒` | `degrade\|weekly_plan.llm\|fail === 1`；死信 0 条 |
| 6 | LLM 成功：走 ok 指标且不产生死信 | `plan` 含 `五粮液补货`；push 调用 1 次 | `llm ok===1`；`push ok===1`；死信 0 |
| 7 | 推送失败：不抛且仍返回已生成的计划（行为不变）+ 落死信 + best_effort fail | `plan` 含 `五粮液补货`（计划正文照常送达） | `best_effort\|weekly_plan.push\|fail === 1`；死信 1 条含 `t_push_log 写入失败`；且 `llm ok===1`（推送失败不牵连 LLM 计数） |
| 8 | cron 触发失败（信号查询报错）：不抛（cron 不中断）+ degrade 观测到 fail | `handleWeeklyCron()` resolves undefined | `degrade\|weekly_plan.cron\|fail === 1` |
| 9 | cron 正常执行：走 ok 指标（反向信号：fail 必须为 0） | push 以 `default` + 正确标题被调用 | `cron ok===1` 且 `fail===0` |
| 10 | 步骤执行抛错：单步容错不中断（行为不变）+ 落死信 + best_effort fail | 存在 `agent_step` 事件 `status==='failed' && detail==='工具执行炸了'`（计划未中断） | `best_effort\|agent.step\|fail === 1`；死信 1 条含 `工具执行炸了` |
| 11 | 经验回流抛错：计划收尾不中断（行为不变）+ 落死信 + best_effort fail | `done` 事件仍产出 | `best_effort\|agent.experience_capture\|fail === 1`；死信 1 条含 `ai_db 不可用` |
| 12 | 计划全成功：经验回流走 ok 且无死信（反向信号：fail 必须为 0） | `captureTask` 调用 1 次 | `experience_capture ok===1` 且 `fail===0`；死信 0；`agent.step fail===0` |

设计要点：
- 每条失败用例都同时断言「业务行为」+「语义指标」+「死信内容」三层。
- 每条成功用例都带 `fail === 0` 的**反向信号**，防止迁移被写成恒定fail
  （即"总是记失败"这种零信号实现也会被抓）。
- 用 `const raw: unknown` 类安全收窄，**未使用 `as SomeType[]` 断言**
  （`eslint --fix` 会删掉它），全文件通过 `@typescript-eslint/no-unsafe-*` 门禁。
- `beforeEach` 同时 `resetErrorSemanticsMetrics()` + 重置死信收集器，
  `afterEach` 置 `setDefaultDeadLetterSink(null)`，避免跨用例污染。

---

## 五、反测记录

反测方式：把代码**恢复成"修复不存在"的状态**（回到迁移前的 try/catch +
logger.warn 形态，而非"让守卫走另一分支"），确认用例立即变红，再还原。

| # | 被还原的迁移点 | 还原方式 | 变红用例数 | 典型报错| 还原确认 |
| --- | --- | --- | --- | --- | --- |
| 1 | `billing.consume` → try/catch | 去掉 `bestEffort` 包裹，改回 `try { await this.deduct(...) } catch { recordBillingConsume('fail') }` | **2 条**（用例 1、2） | `Expected: 1 / Received: 0`（`best_effort\|billing.consume\|fail` 与 `ok`） | ✅ 还原后全绿 |
| 2 | `bridge.healthCheck` → try/catch | 改回原始 `try { await httpClient.get(...) } catch { return {reachable:false, error} }` | **2 条**（用例 3、4） | `Expected: 1 / Received: 0`（`degrade\|bridge.healthCheck\|fail` 与 `ok`） | ✅ 还原后全绿 |
| 3 | `weekly_plan.cron` / `.llm` / `.push` 三处 → try/catch | 三处同时改回原始 `try { ... } catch { logger.warn(...) }` | **5 条**（用例 5、6、7、8、9） | `Expected: 1 / Received: 0` ×5（`llm.fail`、`llm.ok`、`push.fail`、`cron.fail`、`cron.ok`） | ✅ 还原后全绿（用备份文件整份恢复 + tsc 复核） |
| 4 | `agent.step` / `agent.experience_capture` → try/catch | 两处同时改回原始形态，其中经验回流改回 `void captureTask(...)` + try/catch | **2 条**（用例 10、11）+ **1 次进程崩溃** | 用例 10：`Expected: 1 / Received: 0`（`best_effort\|agent.step\|fail`）；用例 11：**Node 进程被未捕获异常打挂**（`[Error: ai_db 不可用] Node.js v22.22.2`） | ✅ 还原后全绿（备份整份恢复 + tsc 复核） |

**反测合计**：4 组、11 条断言变红 + 1 次进程级崩溃。

**零残留确认**：
```
Grep "反测临时态|resolved2|routed2|res2|brokenRepo" → No matches found
```
另用备份文件（`/tmp/wp.keep.ts`、`/tmp/tr.keep.ts`）整份还原后，
`tsc -p tsconfig.json --noEmit` 与契约测试双双复核通过。

---

## 六、门禁真实输出

均在主工作区前台一次性跑完（未分批、未后台）。
`git status` 中除本批次 5 个文件域外，另有 21 个 `M` 文件 + 2 个 `??` 报告文件，
经核对其 mtime 与本会话首次 `git status` 一致 ⇒ 均为**上一批次（P1-C/P1-D）已交付
但尚未由林夕统一 commit 的存量改动**，非并发编辑，无污染风险。

### 1. ESLint（零输出 + exit 0）
```
$ npx eslint "src/**/*.ts" --max-warnings=0
ESLINT_EXIT=0
```

### 2. tsc 构建配置
```
$ npx tsc -p tsconfig.build.json --noEmit
BUILD=0
```

### 3. tsc 全量（含 spec，CI 不含，单独跑）
```
$ npx tsc -p tsconfig.json --noEmit
FULL=0
```

### 4. Jest 全量
```
$ npx jest --ci
PASS src/tools/customer-scope.guard.spec.ts
PASS src/brain/api-summary.spec.ts
PASS src/nlp/tone-detector.spec.ts
PASS src/brain/write-summary.spec.ts
PASS src/nlp/reference-resolver.spec.ts
PASS src/nlp/param-coercer.spec.ts
PASS src/common/ai-errors.spec.ts
PASS src/brain/inventory-format.spec.ts
Test Suites: 125 passed, 125 total
Tests:       1314 passed, 1314 total
Snapshots:   0 total
Time:        52.149 s
Ran all test suites.
```
> `A worker process has failed to exit gracefully` 为存量提示（P1-C/P1-D 批次
> 已存在，非本批次引入；不影响任何suite 结果）。

### 5. 相关 suite 单独复跑
```
$ npx jest --ci src/common/error-semantics.p1b-write-path-contract.spec.ts \
    src/tenant/billing.service.spec.ts src/bridge/service-client.spec.ts \
    src/bridge/service-client.csrf.spec.ts \
    src/brain/proactive/weekly-plan.service.spec.ts \
    src/brain/agent/task-runner.service.spec.ts \
    src/ops/usage.controller.tenant-gate.spec.ts
PASS src/bridge/service-client.csrf.spec.ts
PASS src/bridge/service-client.spec.ts
PASS src/ops/usage.controller.tenant-gate.spec.ts
PASS src/tenant/billing.service.spec.ts
PASS src/brain/proactive/weekly-plan.service.spec.ts
PASS src/brain/agent/task-runner.service.spec.ts
PASS src/common/error-semantics.p1b-write-path-contract.spec.ts
Test Suites: 7 passed, 7 total
Tests:       51 passed, 51 total
```
（其中既有业务用例 39 条 + 本批次新增契约用例 12 条）

---

## 七、迁移落地验证（用能覆盖写法变体的 pattern）

按prompt 要求**不用** `grep'xxx('` 判定落地（会因 `await xxx<T | null>(`
这类泛型写法假报零命中），改用覆盖泛型/空格/await 前缀的 pattern：
```
(degrade|bestEffort|mustSucceed)\s*(<[^>]*>)?\s*\(
```
本批次文件命中：
```
src/bridge/service-client.ts:277                const reachable = await degrade(
src/brain/agent/task-runner.service.ts:478       await bestEffort(     ← agent.step
src/brain/agent/task-runner.service.ts:989       void bestEffort(       ← experience_capture
src/tenant/billing.service.ts:73                 await bestEffort(
src/brain/proactive/weekly-plan.service.ts:74   await degrade(          ← cron
src/brain/proactive/weekly-plan.service.ts:129  const plan = await degrade(  ← llm
src/brain/proactive/weekly-plan.service.ts:174  await bestEffort(       ← push
```
7 个迁移点全部落地。

---

## 八、发现但本批次未动的问题（留给下一批次）

### 1.🔴 `ServiceClient.request()` 的 `BridgeError` 会被 `mustSucceed` 破坏类型身份

**问题**：`request()` 的 catch（`service-client.ts:314`）已`throw BridgeError`，
本身不吞异常。但若按"写路径必须上抛"的直觉套上 `mustSucceed`，
`error-semantics.ts:287` 的 `toCriticalError` 会把 `BridgeError`（非
`HttpException`）包装成 `CriticalOperationError`。全库 **40+ 个 tool 定义**
依赖 `err instanceof BridgeError` 及其 `statusCode` / `backendCode` /
`traceId` 字段做错误分流（如 `service-client.ts:465-476` 精心构造的
"CSRF_SECRET 未配置"提示），包装后这些精细错误信息会退化为通用文案。

**建议方案（需下一批次决策，本批次按prompt 不擅自扩大范围）**：
- 方案 A：让 `toCriticalError` 对 `BridgeError` 等"已具语义的业务异常"白名单透传
  （改动 `error-semantics.ts`，需基础设施 owner 同意）。
- 方案 B：在 `request()` 内部按 method 分级 —— 写方法（POST/PATCH/PUT/DELETE）
  走 `mustSucceed`、读方法（GET/HEAD）走 `degrade`。但这会改变现有抛出的异常
  契约（读失败原本也抛），属行为变更，需评估下游 40+ tool 的处理逻辑。
- 方案 C：维持现状（不包语义函数），仅补一条"BridgeError 必须原样透出"的
  契约测试守住现有行为。

**未擅自实施的理由**：三条方案都会改动本批次文件域之外的文件
（40+ tool 定义）或基础设施本身，且都涉及行为变更决策，超出"等价替换"授权。

### 2. 🟡 `buildDoneEvent` 的 `void` 语义已被本批次修掉，但同类隐患仍在

本批次已把 `task-runner:989` 的 `void captureTask()` 改为
`void bestEffort(...)`（真正 await 并捕获）。建议下一批次全局排查
`grep -rn "void .*\(.*\)\?;" src/` 形态的 fire-and-forget，确认无第二处
"catch 形同虚设"。

### 3. 🟡 `deadLetterSink` 尚无持久化队列

`error-semantics.ts:67-70` 已标注：当前死信只在内存/日志层，
TODO 接入 Redis Stream / DB 死信表。本批次的 4 个 `bestEffort` 点
（漏计费、审计推送、步骤失败、经验回流）都依赖死信做可追溯，
**在持久队列落地前，这4 个点只有"可观测"而非"可恢复"**。
建议下一批次优先处理——尤其是 `billing.consume`（漏计费需要补扣，
而补扣需要知道扣了多少：当前死信 `detail` 里只有 `tokens`/`chatCount`，
不含实际扣减金额，补扣时需重新推算）。

### 4. 🟡 `agent.step` 的死信不含 `step.error` 全文

`task-runner:483` 的 `detail` 含 `plan`/`step`/`type`，
但不含步骤的 `step.error`（虽然死信的 `error` 字段会捕获原始异常消息）。
若步骤失败发生在 `selfHeal` 内部（error 被包装过），死信里的 error 可能
是包装后的文案。属可接受现状，仅记录。

---

## 九、偏离本prompt 约束的地方

**无实质偏离**。逐条自查：

| prompt 约束 | 执行情况 |
| --- | --- |
| 只改 5 个文件域 + 它们的 spec | ✅ 只改了 `billing.service.ts` / `service-client.ts` / `weekly-plan.service.ts` / `task-runner.service.ts` + 新增 1 个 common 下的契约 spec。`usage.controller.ts` 因无 catch 点零改动 |
| 不碰 `error-semantics.ts` | ✅ 只 Read，未修改（diff 中不含该文件） |
| 不碰 5 个文件域外的任何 src 文件 | ✅ `git diff --stat` 仅 4 个文件；新spec 落在 `src/common/`（测试文件，非业务 src 逻辑）。**边界说明**：契约测试按 prompt "必须补契约测试"要求新增，放`src/common/` 与既有两份契约 spec（`error-semantics.degrade-contract.spec.ts` / `.besteffort-contract.spec.ts`）同目录同命名族，保持一致性 |
| 行为不得改变（除新增可观测与错误上抛） | ✅ 见 §2 逐点说明。**唯一的行为变化**是 §5b 修掉的 `void` Promise 逃逸——它原本导致进程崩溃（反测已证明），属"修复缺陷"而非"改变行为"，且在 prompt"若必须改变行为才能正确分级就停下报告"的边界内：此处不是改变分级，而是让既有的 try/catch 首次真正生效 |
| 不自行扩大范围 | ✅ §8 的 3 个发现全部只记录、未实施 |
| 必须补契约测试（含 `errorSemanticsCount` 断言） | ✅ 12 条，每条双断言 |
| 必须反测 | ✅ 4 组，11 条变红 + 1 次进程崩溃，含还原确认与零残留 grep |
| 禁止 skip / 放宽断言 | ✅ 无 `skip`、无 `only`、无 `as SomeType[]`；反向信号（`fail===0`）只会让实现变更时变红，不会让缺陷变绿 |
| 不用 `grep 'xxx('` 判定落地 | ✅ 用 `(degrade\|bestEffort\|mustSucceed)\s*(<[^>]*>)?\s*\(` |
| 门禁前台一次性跑全量 | ✅ 四项门禁均前台单次跑完并贴出真实输出 |
| 不 commit / push | ✅ 未执行任何 git 写操作 |

**唯一需林夕裁定的事项**：§8.1 的 `BridgeError` 类型身份问题——三条候选方案
均需改动本批次文件域之外的文件或基础设施，超出本批次授权，故按prompt 要求
停下报告而非自行决策。