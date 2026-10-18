# AI 底座待办登记表

> 维护：凌舟｜更新：2026-10-16
> 用途：一张表掌握全部未完成项（已完成的各单均有收官报告，不在此重复）

---

## 一、在办（已派单，执行中）

| # | 待办 | 单号 | 执行 | 状态 |
|---|---|---|---|---|
| 5b | 🔴 P0：31 个工具注册表 | R101-AI-44 | 阿澈（代笔，阿洲通道失效）| ✅ **已交付并上线**：`88009bd`/部署源 `de1c1bd`；31 个注册 + guard 守卫 4 例双向断言；mutation 摘一条⇒红且点名；**生产探针确认 31 个抽样 0"未注册"** |
| 1d | S4：10 巡检"先落通知再推送" | R101-AI-43 | 阿澈（`brain/proactive/**`）| ✅ **已收官（10/10）**：`43a0411`/部署源 `ec6dd98`；每处 3 例反测（⑧关键内容 ⑨主次不倒置 ⑩@Optional 兼容）；proactive 17 套件 152 用例；mutation 已验证 |
| **AI-45** | **定向推送**（push 支持 targetUserId） | R101-AI-45 | 阿澈（`brain`+`gateway`）| ✅ **已收官**：`9e7b670`/部署源 `c9c541f`；user_id 落真实用户 + `sendToUser` 只投该用户（**不回落广播**，防私人提醒泄漏）；7 例反测 + mutation（去掉 userId 过滤⇒②红）|
| 1 | 办公批次 3：审批流 | R101-AI-38 | 阿坚 | ✅ 已收口（6 工具；177/1864）|
| 1b | 办公批次 4：日程/提醒 | R101-AI-39 | 阿坚 | ✅ 已收口（5 工具+提醒服务；179/1877）|
| 1c | 办公批次 5：通知中心 | R101-AI-40 | 阿坚 | ✅ 已收口（8 mutation 全有效 + 回传/收官；181/1888）|

## 二、待派（已登记，未开工）

| # | 待办 | 说明 | 优先级 | 依赖 |
|---|---|---|---|---|
| ~~2~~ | ~~`aiTodoCancel`~~ | ✅ **已由 R101-AI-41 交付**（原子 `WHERE status IN('pending','in_progress')`；已 done ⇒ 明确失败） | — | — |
| ~~2b~~ | ~~草稿删除~~ | ✅ **已由 R101-AI-41 交付**（`aiApprovalDraftDiscard`，软删 `deleted_at`，仅 draft 可弃） | — | — |
| 3 | **数字员工回写**（员工完成任务 ⇒ 待办自动 done） | 🔍 **2026-10-19 复核：需跨面才能落地** —— 回写要透传 `linkedTodoId`：①派单侧 `dispatchTask`/`DispatchEmployeeTaskTool` 加字段 ②或任务表加列（迁移）③消费侧 bridge 回写。**其中 ①属 `src/tools/**`（阿洲面）** ⇒ 阿澈不越界，待派给阿洲（或凌舟裁定授权）。<br>已定设计（供派单）：沿用 `originConversationId`/`customerId` 的"可选透传字段"风格，在 `EmployeeTaskRunInput` 加 `linkedTodoId`；回写**复用既有 `aiTodoComplete` 工具**（原子+权限+幂等全保留，**不复制 UPDATE 逻辑**）；**仅任务成功回写 done，失败不改状态**（失败自动改会掩盖问题）；回写失败不得影响任务结果（双层防护，主次不倒置） | 中 | **待派阿洲**（`src/tools/**` 改动）|
| 4 | **向量检索分支**（`aiDocSearch` 加向量检索） | 需 **embedding 服务就绪**，否则"假绿" | 中 | embedding 配置 |
| 5 | **`aiDocAsk` 对话式问答**（"这份文档的关键条款是什么"） | 需 LLM 路径 | 中 | 与 4 同批更好 |
| 6 | **多轮/多级审批、会签** | 属产品复杂度 | 低 | 需业主确认产品形态 |
| 7 | **`ToolCategory` 加 `office`** | 现有办公工具归在 `report` 桶（注释已留"一行切换"） | 低 | 无（属 `src/tools/**` ⇒ 阿洲）|
| 8b | **定向提醒**（现租户级广播） | `t_push_log.user_id` 硬编码 0 + gateway 只按租户 broadcast ⇒ 需改 push 写真实 user_id + gateway 支持按用户定向 | 中 | 通知中心（AI-40）已打通，可开工 |
| 8c | **日程共享/代管、重复日程（recurrence）** | 批次 4 明确不做（复杂度高） | 低 | 需产品确认 |
| 8d | **超时未提醒补偿窗口** | @Cron 停机期间的到期提醒如何补发（reminded_at 未写会重试，但停机跨天场景需确认） | 低 | 无 |
| 8 | **readiness 导出化** | 🔍 **2026-10-19 复核：同样需跨面** —— 现由根 AppModule providers 注册（app.module.ts:76），消费方含 `get-system-status.tool.ts`（`src/tools/**`）。收敛到 OpsModule（providers+exports 并从根移除，避免双实例分裂 cache/inFlight 状态）⇒ **ToolsModule 需 `imports:[OpsModule]`，属阿洲面** ⇒ 待派阿洲。<br>注：ReadinessService 依赖 `@Optional() @InjectDataSource()` 双数据源，与 OpsModule 的 DatabaseModule 兼容，无技术障碍 | 低 | **待派阿洲**（`src/tools/**` 改动）|

## 三、环境/运营类（非代码）

| # | 待办 | 说明 | 阻塞什么 |
|---|---|---|---|
| 9 | **触发一次生产部署（须 MS 线跑 deploy.yml）** | ✅ **2026-10-17 MS 线实证：部署已成功，本项结清**（run 38932199875：服务器 `/opt/zhixiang/ai-base` HEAD=`6ac1de6`=gh-ip/main；源码与 dist 27 工具 mtime 00:31:56；**迁移尝试 23 / 成功 13 / 跳过 10 / 失败 0**，022+023 均成功；pm2 重启、健康+就绪通过、部署完成 00:32:03）。<br>⚠️ 此前"首轮跑旧脚本只到 3 迁移"（MS 仓第 75 项机制坑）**已被该 run 推翻**；我也曾据 `total=96` 给过三个错误假设（旧脚本坑/fetch 不到/容错跳过）——**根因是代码注册表缺条目**（见 §5b），与部署无关。<br>机制备忘（仍有效）：AI 仓 push **不触发**部署；触发器是 MS 仓 `deploy.yml`（push:main + workflow_dispatch）→ `auto-deploy.sh` → `ai-base-deploy.sh`（`git fetch origin main + reset --hard FETCH_HEAD`）；gh-ip 与 github 同一仓库（单推即可）。 | 已结清 |
| **5b** | 🔴 **P0：31 个工具未进执行器注册表（R101-AI-44，归阿洲）** | 根因：`tools.module.ts` 的 `providers` 只是 **Nest DI 容器**；执行器注册表是 `src/tools/tool-bootstrap.ts` 的 `onModuleInit() → registry.registerAll([…手工数组…])` ⇒ 办公 27 + ForecastSales/AnalyzePriceTrend/CancelSalesOrder/GetSystemStatus 共 **31 个零 import/零注入/零条目**（EchoTool 属刻意豁免）。生产同进程日志自证：`[AdminController] 96 个工具` vs `[ToolExecutor] "getSystemStatus" 未注册（已注册 107 个）`。<br>**修法三件套（缺一必复发）**：① 补 import+构造注入+registerAll 条目；② guard spec（`definitions/*.tool.ts` 实例化集合 == registerAll 条目 + 具名豁免表，mutation=摘一条 ⇒ 红）；③ `/api/admin/tools` 改读 `ToolRegistry.list()` 收敛两套账。<br>⇒ **属 `src/tools/**`（阿洲代码面）**，阿澈不碰；修完推 gh-ip，下次部署即生效 | **全部新工具可调用**（生产真数据实测闭环） |
| 10 | **demo/测试租户基础数据** | 已由 MS 交付（12 商品）；若需更多场景数据可再提 | 真数据实测闭环 |
| 11 | **embedding 服务配置** | 生产未配置 ⇒ 向量检索无法真实验证 | 待办 4、5 |

## 四、跨线（MS / OPS）

| # | 待办 | 状态 |
|---|---|---|
| 12 | demo 租户基础数据种子 | ✅ MS 已交付 |
| 13 | 销售单取消端点 `POST /api/admin/sale-bills/:billNo/cancel` | ✅ MS 已交付（我方已集成，R101-AI-36 收官） |
| 14 | 双系统对接（OPS）· E1 身份映射 | ⏸ 未启动（数据链路 P3/P4 依赖它） |
| 15 | AI 办公审批与 MS 审批打通 | ⏸ 未启动（本批明确不做，独立议题） |

## 五、已完成（有收官报告，供索引）

| 单号 | 内容 | 门禁贡献 |
|---|---|---|
| R101-AI-30 | standalone 存储形态（方言层/双模式/内存 Redis/sqlite 基线） | 至 161/1752 |
| R101-AI-31 | 限流读写分桶（读 600 / 写 60） | |
| R101-AI-32/33 | 销售预测 + 价格走势（切 MS 真源） | |
| R101-AI-34 | 完善批次（切真源×2 + source:'ai' + getSystemStatus + 矩阵同步） | 至 171/1820 |
| R101-AI-35 | 办公批次 1：文档中心（6 工具 + ACL + RAG 贯通） | |
| R101-AI-36 | P1-3 兑现：取消销售单 | |
| R101-AI-37 | 办公批次 2：待办与任务（4 工具 + ACL 泛化） | 至 175/1844 |

## 六、门禁总览

135/1471 → **183 套件 / 1936 用例**（0 `.skip`；既有断言修改均已留痕：proactive-push INSERT 参数契约演进 +1 user_id）
