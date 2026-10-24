# AI 底座待办登记表

> 维护：凌舟｜更新：2026-10-24
> 用途：一张表掌握全部未完成项（已完成的各单均有收官报告，不在此重复）

---

## 一、在办（已派单，执行中）

| # | 待办 | 单号 | 执行 | 状态 |
|---|---|---|---|---|
| 5b | 🔴 P0：31 个工具注册表 | R101-AI-44 | 阿澈（代笔，阿洲通道失效）| ✅ **已交付并上线**：`88009bd`/部署源 `de1c1bd`；31 个注册 + guard 守卫 4 例双向断言；mutation 摘一条⇒红且点名；**生产探针确认 31 个抽样 0"未注册"** |
| 1d | S4：10 巡检"先落通知再推送" | R101-AI-43 | 阿澈（`brain/proactive/**`）| ✅ **已收官（10/10）**：`43a0411`/部署源 `ec6dd98`；每处 3 例反测（⑧关键内容 ⑨主次不倒置 ⑩@Optional 兼容）；proactive 17 套件 152 用例；mutation 已验证 |
| **AI-45** | **定向推送**（push 支持 targetUserId） | R101-AI-45 | 阿澈（`brain`+`gateway`）| ✅ **已收官**：`9e7b670`/部署源 `c9c541f`；user_id 落真实用户 + `sendToUser` 只投该用户（**不回落广播**，防私人提醒泄漏）；7 例反测 + mutation（去掉 userId 过滤⇒②红）|
| **AI-46** | **数字员工回写（端到端）** | R101-AI-46 | 阿澈（brain）+ 阿洲（tools）| ✅ **已完成**：brain `dedc4ea`/`32455cc`；tools `41298b1`；`linkedTodoId` 全链路透传，三处幂等分支均传；10 例反测 + mutation；部署源 `52bcf78` |
| **AI-44补** | 工具清单端点按身份区分口径 | R101-AI-44 | 阿澈（`gateway`）| ✅ **已完工**：平台身份⇒全量；商家管理员⇒mgmt（**不得看到 platform 工具**，防越权暴露）；无身份⇒403。4 例反测 + mutation（一律 platform⇒②红）。缺口由阿洲发现 |
| 1 | 办公批次 3：审批流 | R101-AI-38 | 阿坚 | ✅ 已收口（6 工具；177/1864）|
| 1b | 办公批次 4：日程/提醒 | R101-AI-39 | 阿坚 | ✅ 已收口（5 工具+提醒服务；179/1877）|
| 1c | 办公批次 5：通知中心 | R101-AI-40 | 阿坚 | ✅ 已收口（8 mutation 全有效 + 回传/收官；181/1888）|

## 二、待派（已登记，未开工）

| # | 待办 | 说明 | 优先级 | 依赖 |
|---|---|---|---|---|
| ~~2~~ | ~~`aiTodoCancel`~~ | ✅ **已由 R101-AI-41 交付**（原子 `WHERE status IN('pending','in_progress')`；已 done ⇒ 明确失败） | — | — |
| ~~2b~~ | ~~草稿删除~~ | ✅ **已由 R101-AI-41 交付**（`aiApprovalDraftDiscard`，软删 `deleted_at`，仅 draft 可弃） | — | — |
| ~~3~~ | ~~**数字员工回写**~~ | ✅ **端到端完成**：brain `dedc4ea`/`32455cc` + tools `41298b1`；部署源 `52bcf78` | — | — |
| 4 | **向量检索分支**（`aiDocSearch` 加向量检索） | ✅ **已验收**：本地提交 `b9baa56`，未 push。隔离提交上 tsc×2 / build / eslint / 14-14 测试 / 全量 **186 套件 / 1966 用例**全绿；两条 mutation 分别点名 V2+V3、V1+V4，并逐字节复原。ACL 先行、docId 去重、稳定排序、故障降级均成立。⚠️ 真实生产 embedding 命中**未验**；验收卡 `docs/reports/AI-P1-2-凌舟验收与裁定-20261024.md` | — | — |
| 5 | **`aiDocAsk` 对话式问答**（"这份文档的关键条款是什么"） | ✅ **已交付并完成 F1 脱敏修复（待验收）**：主体 `ae62a88`；**F1 修复 `AI-P1-3F1`** —— 外层 DB/ACL catch 改固定商户文案「当前暂时无法读取这份文档，请稍后重试」，原始 message 仅进 logger；测试⑧增强 + 新增⑨点名用例（复刻 `Table 'liquor_inventory.t_ai_knowledge_chunks'` 事故原文，对**整个 ToolResult** 断言 8 个内部词零命中）。门禁 tsc×2/build/eslint 0；目标 9/9；全量排除他线 **188 套件/1981 用例全绿**（1980→1981）；mutation 还原 raw error ⇒ ⑧⑨双红且⑨点名，逐字节还原复绿。⚠️ 生产端到端仍未验；探针边界限定失败路径（成功路径 `citations.chunkIndex` 含 "chunk" 字面，属已验收契约不可动）。证据 `docs/reports/AI-P1-3F1-证据-2026-10-24/`；回传 `docs/reports/AI-P1-3F1-阿澈-回传-2026-10-24.md` | — | — |
| 6 | **多轮/多级审批、会签** | 属产品复杂度 | 低 | 需业主确认产品形态 |
| 7 | **`ToolCategory` 加 `office`** | 排队：待 P1-2 释放同文件后由阿洲执行；只迁移 office 工具，不碰 salesReport 等真报表工具 | 低 | 阿澈 P1-2 完成 |
| 8b | **定向提醒**（现租户级广播） | ✅ **已由 R101-AI-45 交付**（push 支持 `targetUserId`：user_id 落真实用户 + `sendToUser` 只投该用户，不回落广播防泄漏） | — | — |
| 8c | **日程共享/代管、重复日程（recurrence）** | ✅ 业主批准，排队（阿洲）。共享同时支持按角色和指定人员；查看与代管分层；DAILY/WEEKLY/MONTHLY/YEARLY + 单次/后续/整系列。卡：`docs/reports/AI-P2-2-schedule-sharing-recurrence-派单卡-2026-10-23.md` | 低 | P2-1 后开工 |
| 8d | **超时未提醒补偿窗口** | ✅ 业主批准，排队（阿澈）。所有漏提醒必须补回：≤3 逐条推送，>3 聚合摘要但仍全量入通知中心；22:00–08:00 静默；幂等发送。卡：`docs/reports/AI-P2-3-reminder-catchup-派单卡-2026-10-23.md` | 低 | P1-3 后开工 |
| 8 | **readiness 导出化** | ✅ **已由 R101-AI-47 交付**（`080771f`）：独立 `ReadinessModule`（只 import DatabaseModule+AiDbModule 叶子 ⇒ 无环）；AppModule 移除根注册（单实例，cache/inFlight 不分裂）；ToolsModule import 它打通工具注入；`get-system-status` 切换 `readiness.check()` 属后续单。<br>⚠️ 两次失败尝试已留痕：①挪 OpsModule ⇒ Tools→Ops→Proactive→Brain→Tools **成环**（DI spec 实测）②v1 mutation 不加 import ⇒ Tests:0 total（无效） | — | — |
| 16 | **人工 / AI 能力对等机器台账** | 🟢 已派苏然：以 MS 人工动作/权限和 AI tool registry 做双向差集，缺失项必须 `LIVE/PARTIAL/PLANNED/BLOCKED`、责任人和人工回退；卡 `docs/reports/AI-P0-3-human-ai-parity-gate-派单卡-2026-10-23.md` | 高 | 跨仓只读扫描；不阻塞 P1-2 |

## 三、环境/运营类（非代码）

| # | 待办 | 说明 | 阻塞什么 |
|---|---|---|---|
| 9 | **触发一次生产部署（须 MS 线跑 deploy.yml）** | ✅ **2026-10-23 再次部署并确认当前 52bcf78 已上生产**：run `39845795640` SUCCESS 5m14s；服务器 `HEAD=52bcf78`；`/api/health/ready=ready`；embedding 配置为智谱 `embedding-3`。历史 run `38932199875` 亦成功。<br>机制不变：AI 仓 push **不触发**部署；触发器是 MS 仓 `deploy.yml` → `auto-deploy.sh` → `ai-base-deploy.sh`。 | 已结清（授权态工具/回写探针待账号） |
| **5b** | 🔴 **P0：31 个工具未进执行器注册表（R101-AI-44，归阿洲）** | 根因：`tools.module.ts` 的 `providers` 只是 **Nest DI 容器**；执行器注册表是 `src/tools/tool-bootstrap.ts` 的 `onModuleInit() → registry.registerAll([…手工数组…])` ⇒ 办公 27 + ForecastSales/AnalyzePriceTrend/CancelSalesOrder/GetSystemStatus 共 **31 个零 import/零注入/零条目**（EchoTool 属刻意豁免）。生产同进程日志自证：`[AdminController] 96 个工具` vs `[ToolExecutor] "getSystemStatus" 未注册（已注册 107 个）`。<br>**修法三件套（缺一必复发）**：① 补 import+构造注入+registerAll 条目；② guard spec（`definitions/*.tool.ts` 实例化集合 == registerAll 条目 + 具名豁免表，mutation=摘一条 ⇒ 红）；③ `/api/admin/tools` 改读 `ToolRegistry.list()` 收敛两套账。<br>⇒ **属 `src/tools/**`（阿洲代码面）**，阿澈不碰；修完推 gh-ip，下次部署即生效 | **全部新工具可调用**（生产真数据实测闭环） |
| 10 | **demo/测试租户基础数据** | 已由 MS 交付（12 商品）；若需更多场景数据可再提 | 真数据实测闭环 |
| 11 | **embedding 服务配置** | ✅ 生产已配置：`EMBEDDING_BASE_URL=https://open.bigmodel.cn/api/paas/v4`、`EMBEDDING_MODEL=embedding-3`；真实 embedding 调用质量待生产鉴权后补证 | 已解除待办 4 的代码开工阻塞 |

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

135/1471 → **186 套件 / 1959 用例**（0 `.skip`；既有断言修改均已留痕：proactive-push INSERT 参数契约演进 +1 user_id）
