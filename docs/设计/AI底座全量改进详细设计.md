# AI 底座全量改进详细设计

> 范围：在现有《智享全链 AI 底座 v2.0》（端口 3016，NestJS/TS）基础上，做**全量能力开放**的细化设计，并在完善后**复制到运营系统**（总后台共用 + 运营本地内嵌，前期不独立部署服务器）。
> 原则：能力全开、不限制；对接平台既有能力（统一账号/多租户隔离/审核流程）；"任务丢给 AI，AI 直接调工具执行"。
> 配套 UI：管理系统 AI 助手三段式**已实现**；运营系统专属三段 UI 见《运营系统UI设计》（导航栏 / AI 对话框 / 工作区）。

---

## 一、总体目标与交互范式

| 项 | 定义 |
|---|---|
| 能力策略 | **全量开放**：C1–C11 + 认知层（长期记忆 LT / 自主学习 LN / 自主进化 SE），不做能力限制 |
| 部署拓扑 | 管理系统 AI `:3016`（总后台侧 server 微服务）完善后，**同代码复制**到运营系统，**内嵌进运营本地包**（前期不占独立端口、不独立部署）；两形态共用**总后台**完成账号与微服务对接 |
| 交互范式 | 用户只抛**自然语言任务**；AI 经 Orchestrator 调 **Tool** 直接执行；人仅在「审核流程」节点介入 |
| 既有能力复用 | 统一账号体系、多租户隔离、审核流程——AI 底座**对接**而非新建 |

---

## 二、现有底座现状（基于 v2.0 文档）

| 模块（真实） | 现状 | 全量改进中的角色 |
|---|---|---|
| `providers/`（IModelProvider + Factory + deepseek/ollama） | Provider 无关，已支持外部+本地 | 全量开放的基础；外部/本地按配置选 |
| `tools/`（ToolRegistry + ToolContext{tenantId,userId,sessionId,role}） | 24 业务工具，模式A/B | 任务执行层；运营系统复制后注册运营工具 |
| `brain/orchestrator.service.ts` | 单 Agent ReAct 循环，MAX_ITERATIONS=10 | **增强为多 Agent 图 + 人工闸**（核心改造） |
| `brain/memory-manager.service.ts` | Redis，10 轮/1h TTL 短时记忆 | **扩展为长期记忆**（LT） |
| `brain/context-builder.service.ts` | System Prompt 组装 | 接入长期记忆 + 学习回流 |
| `gateway/chat.controller.ts` | SSE（text/tool_start/tool_result/done/error） | 对话框/工作区事件源 |
| `bridge/service-client.ts` + `audit-logger.ts` | HTTP 调 14 微服务 + 审计表 | 任务执行 + 审计 |
| `tenant/`（TenantContext + TenantGuard） | JWT→tenantId | 对接统一账号体系 |
| `rag/` | 向量库+检索（Ollama embedding，P2） | 长期记忆/学习的存储底座 |
| `database`（platform_ai_config / tenant_ai_config / ai_audit_log） | 租户级 provider 配置 | 增量加记忆/学习/进化表 |

---

## 三、全量能力清单（逐项细化）

### C1 有状态长流程编排（增强）
- **现状**：单 Agent ReAct 循环（≤10 轮），无图/持久化。
- **改进**：Orchestrator 支持两种模式：
  - `react`（管理系统/简单任务）：沿用现有循环。
  - `graph`（运营闭环/复杂任务）：有状态图，节点=域 Agent，边=流转条件，状态持久化（自建 Checkpointer：Redis/DB 存图状态，按 `tenantId+sessionId`）。
- **关键**：图可暂停（人工闸）/恢复；崩溃可从检查点续跑。

### C2 多 Agent 协作（新增）
- 每个业务域一个 Agent（选题/脚本/直播/订单/客服/复盘…），共享 TaskContext。
- Agent 间通过 Orchestrator 图节点传递；不自由对话（避免失控）。
- 管理系统侧：单 Agent（无需多 Agent）；运营系统侧：多 Agent 图。

### C3 工具调度（已有，扩展）
- 现有 ToolRegistry 模式不变；运营实例注册运营工具（选品/脚本/直播/复盘…）。
- 新增：工具**风险分级**（low/medium/high）+ 高危工具触发审核流程（复用现有）。

### C4 权限治理 + 审计（已有，对接审核）
- 审计日志已有（`ai_audit_log`）；全量开放下**所有工具调用 + 进化动作**均留痕。
- 高危操作/进化动作 → 触发**现有审核流程**（非新建审批）。

### C5 人工确认闸（增强，映射审核流程）
- 将"硬 interrupt/resume"接入现有审核流程：
  - AI 在需确认点（发布/投流预算/高风客诉/对账差异/选品决策）生成**待审工单** → 现有审核流程 → 审批结果回写 Orchestrator 续跑。
- 接口：Orchestrator 暂停并 `POST /audit/ai-review`（复用 log 微服务 `:3014` 的 `/ai-audit` 机制扩展为双向审核回调）。

### C6 记忆 / RAG（增强 → LT）
- 短时记忆（Redis）保留；新增**长期记忆**（见第五节）。

### C7 本地优先 / 数据私有（已有）
- Provider 无关：管理系统走 DeepSeek（外部），运营走 Ollama（本地）；全量开放下均可配。

### C8 流式（已有）
- SSE 事件已覆盖 text/tool_start/tool_result/done/error；对话框/工作区直接渲染。

### C9 自适应路由（增强）
- 规则/LLM 判定路由器：按 `(tenantId, systemScope, 上下文)` 选模型+工具+路径。
- 先规则路由（低成本），后期接 LN 自学习路由。

### C10 证据优先验证（增强）
- 副作用账本：每次工具写操作记「意图+参数+结果」；呈现前做一致性核查（如金额/数量校验），降低幻觉。

### 认知层 LT / LN / SE（新增，详见第四~六节）

---

## 四、核心改造 1：Orchestrator 增强（多 Agent 图 + 人工闸）

```
用户任务
  │
  ▼
Orchestrator(mode: react | graph)
  │
  ├─ react: LLM→tool_calls→执行→循环≤10→stop   (管理系统/简单)
  │
  └─ graph:  StateGraph
       节点: 选题Agent→脚本Agent→成片Agent→分发Agent→直播Agent→复盘Agent
       边:   条件流转；复盘→回流到选题(闭环)
       状态: Checkpointer(redis/db, tenantId+sessionId)
       人工闸: 命中确认点→生成待审工单→暂停→审核回调→续跑
```

- **Checkpointer（自建）**：图状态序列化存 `ai_graph_state{tenantId}{sessionId}`；支持 time-travel（回放历史状态）。
- **人工闸↔审核流程**：见 C5；审批通过前状态冻结，不推进。
- **C10 验证**：每写操作前后写副作用账本，复盘/呈现前核查。

---

## 五、核心改造 2：长期记忆（LT）

存储分层（均按 `tenantId` 隔离）：

| 层 | 存储 | 内容 | TTL |
|---|---|---|---|
| 工作记忆 | Redis（`ai:memory:{tenantId}:{sessionId}`） | 当前会话多轮 | 1h（现有） |
| 长期记忆-档案 | DB（`ai_ltm_profile`） | 租户/用户偏好、常用对象、稳定事实 | 持久 |
| 长期记忆-情节 | 向量库（`ai_ltm_episodic`） | 历史交互摘要、成败经验 | 持久（配额限） |
| 长期记忆-归档 | 向量库（`ai_ltm_archival`） | 文档/知识沉淀 | 持久 |

- **写入时机**：会话结束/关键事件后，由 MemoryManager 抽取摘要写入；受配额与压缩控制。
- **读取时机**：ContextBuilder 组装 System Prompt 时检索相关长期记忆注入。
- **结构参考**：Letta/MemGPT 的 core/recall/archival 分层 + ollama-harness 的 Semantic Memory。

---

## 六、核心改造 3：自主学习（LN）

```
每次交互结束
  → 反馈提取（成功/失败/用户修正/显式评价）
  → 经验结构化（what/why/context）
  → 回流到租户知识命名空间（RAG `ai_knowledge_{tenantId}`）
  → 后续 ContextBuilder/工具选择/路由 读取该知识 → 行为优化
```

- **作用面**：① 上下文更贴租户；② 工具选择更准（减少试错）；③ prompt/路由随租户演进。
- **隔离**：知识严格按 `tenantId`，不跨租户。
- **可观测**：学习记录入 `ai_learning_log`（租户/时间/经验/采纳效果）。

---

## 七、核心改造 4：自主进化（SE，门控）

| 项 | 设计 |
|---|---|
| 进化对象 | Agent 的 prompt / 工具定义 / 工作流(图) |
| 触发 | LN 积累足够信号，或运营人员提议 |
| 审批 | **复用现有审核流程**（生成待审工单，人工批准） |
| 版本化 | 每次进化存 `ai_evolution{tenantId, version, diff, status}` |
| 灰度/回滚 | 新版本先灰度，异常一键回滚到上一版本 |
| 范围 | 仅在提出进化的**租户内**生效，不跨租户 |

> SE 是前沿能力、风险集中点；P3 阶段门控上线，不阻塞 P0–P2 价值释放。

---

## 八、Provider 路由（全量开放）

- `ProviderFactory` 已支持 deepseek/ollama；新增 provider 按 `IModelProvider` 接入即可（沿用 Q3 流程）。
- 全量开放：管理系统可用外部强模型，运营可用本地私有模型，**配置决定，无能力差别**。
- C9 自适应路由：在 Factory 之上加路由层，按 `(tenantId, systemScope, 上下文)` 选 provider+model。

---

## 九、复制部署（总后台共用 + 运营本地内嵌）

| 形态 | 端口/形态 | 接线 |
|---|---|---|
| 管理系统 AI | `:3016`（总后台侧 server 微服务，现有并完善） | 中台微服务（3001–3014 相关） |
| 运营系统 AI | **本地内嵌**（前期不占独立端口、不独立部署服务器） | 连**总后台**调运营微服务（选品/脚本/直播/复盘…） |

- **同 artifact**：一套代码，配置区分（`SYSTEM_SCOPE=mgmt|ops` + 微服务地址 + 是否本地内嵌）。
- **共用总后台**：两形态认证同一套账号体系（总后台聚合账号 + 14 微服务），`tenantId` 语义一致；运营本地包不自建账号体系。
- **共享模型端点**：可共用 Ollama/DeepSeek，或运营本地包用本机 Ollama（配置决定，契合「本地优先」）。
- **按需独立部署**：仅用量过大，才将运营内嵌副本外置为 server 微服务（临时端口 :3015 / :3018），届时仍接同一总后台——属「本地内嵌 → 独立服务」平移，非架构重构。
- **前期零服务器增量**：运营侧不新增服务器资源，仅本地打包分发。

---

## 十、数据模型增量

| 表 | 用途 | 隔离 |
|---|---|---|
| `ai_ltm_profile` | 长期记忆-档案 | tenantId |
| `ai_ltm_episodic` / `ai_ltm_archival` | 长期记忆-情节/归档（向量元数据） | tenantId |
| `ai_learning_log` | 学习回流记录 | tenantId |
| `ai_evolution` | 自主进化版本（diff/status） | tenantId |
| `ai_graph_state` | 图状态 Checkpointer | tenantId+sessionId |
| `ai_review_task` | AI 待审工单（对接现有审核） | tenantId |
| 现有表加字段 | `tenant_ai_config` 加 `system_scope`；`ai_audit_log` 加 `scope/evolution_id` | tenantId |

---

## 十一、接口增量（gateway）

| 接口 | 说明 |
|---|---|
| `POST /ai/chat`（增强） | 支持 `mode=react|graph`、工具进度事件、图状态续跑 |
| `POST /ai/review`（新增） | AI 生成待审工单 → 对接现有审核流程 |
| `POST /ai/review/callback` | 审核结果回写 → Orchestrator 续跑/中止 |
| `GET/POST /ai/admin/memory` | 长期记忆查看/管理（租户内） |
| `GET/POST /ai/admin/learning` | 学习记录查看 |
| `GET/POST /ai/admin/evolution` | 进化版本查看/审批/回滚 |

> 所有事件对齐现有 SSE 类型（text/tool_start/tool_result/done/error），UI 三段直接渲染。

---

## 十二、落地节奏（P0–P3 + 复制）

| 阶段 | 范围 | 工时(1人) |
|---|---|---|
| **P0** | 全量基础：多 Agent 图 + 人工闸(C5) + RAG 全量 + C9/C10 + Provider 路由 | 4–6 周（3016 增量） |
| **P1** | 长期记忆 LT（第五节） | 1–2 周 |
| **P2** | 自主学习 LN（第六节） | 2–3 周 |
| **P3** | 自主进化 SE 门控（第七节，接审核流程） | 3–4 周 |
| **复制** | 同 artifact 内嵌进运营本地包 + 运营工具接线（前期不独立部署） | 1–2 周 |
| **合计** | 管理系统完善 ≈ 10–15 周；+复制 ≈ 12–17 周（1人）/ 7–9 周（2人）；运营前期零服务器增量 | |

---

## 十三、风险与对策

| 风险 | 对策 |
|---|---|
| 自主学习/自主进化是前沿能力，风险工时集中 | P1/P2 先上线；P3 门控后期 |
| AI 自有存储漏带 tenantId → 串味 | 记忆/向量/审计/进化统一带 `tenantId`，对接平台既有隔离 |
| 自主进化行为回归 | 复用现有审核（版本化+回滚+审批） |
| 长期记忆膨胀/噪声 | 压缩摘要 + 租户配额 + TTL 分级 |
| 图状态并发/崩溃 | Checkpointer 持久化 + 续跑；幂等工具调用 |
| 本地内嵌/独立部署形态差异 | 同 artifact + 配置即代码（本地/服务仅由部署形态开关决定，引擎代码一致） |

---

## 十四、落点

- 本详细设计与《基于现有AI底座的共享扩展设计》（策略 v2）、《智享全链AI底座开发文档 v2.0》（现状）构成完整 AI 底座改进交付。
- **专篇详设（细写）**：认知层 LT/LN/SE 详见《认知层详细设计》；运营域全量工具详见《运营域全量工具定义》——本篇五/六/七节为其骨架索引。
- UI 见《运营系统UI设计》（导航栏/AI对话框/工作区 三段），事件对齐本设计第十一节。
- OSS（ollama-agent-harness / Mastra / Letta）仅作模式参考（Governed Loop、Semantic Memory、路由），不引框架。
