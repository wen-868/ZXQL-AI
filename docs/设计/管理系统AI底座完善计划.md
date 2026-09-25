# 管理系统 AI 底座完善计划（规划清单）

> 制定：2026-08-15 ｜ 依据：SharePoint 6 份设计文档（共享扩展 v2 / 全量改进 / 认知层 / 运营工具 / 运营UI / 底座 v2.0）
> 核心理念：**系统所有功能变成 AI 的技能**——管理系统功能经「总台注册表」封装为 AI 工具，由 AI 直接调用执行；管理系统完善稳定后，同代码复制到运营系统（本地内嵌，共用总后台）。

---

## 一、目标与原则

1. **全量开放**：不做能力限制，管理系统 AI 先具备 C1–C11 + 认知层（LT 长期记忆 / LN 自主学习 / SE 自主进化）。
2. **功能即技能**：管理系统各业务域功能（销售/采购/库存/客户/报表/系统等）全部封装为 AI 工具，注册进 ToolRegistry；AI 按任务自动选型调用。
3. **总台注册表驱动**：AI 工具的下游端点从管理系统后端真实路由读取（现有 `ServiceClient.API_ENDPOINTS` 即注册表映射），不臆造路径。
4. **两系统共用底座**：同一套代码、两种形态（mgmt server :3016 + ops 本地内嵌）；共用总后台账号/租户/审核；**管理系统稳定后**才做运营迁移。
5. **对接而非新建**：统一账号体系、多租户隔离、审核流程均复用平台既有能力。

---

## 二、现状盘点（已具备，2026-08-15 实测）

| 能力 | 现状 | 说明 |
|---|---|---|
| Provider | 内置 glm/deepseek/ollama + 外部模型动态注册 + 对话级切换 | ProviderFactory.registerExternal + /api/chat/models |
| 工具 | 29 个业务工具（销售/商品/客户/库存/采购/配送/财务/报表） | 经 ServiceClient 调后端 8080 API |
| 编排 | 单 Agent ReAct 循环（≤10 轮） | Orchestrator，含 Confirmation 确认/撤销 + 自动回滚 |
| 记忆 | Redis 10 轮 / 1h TTL 短时 | MemoryManager |
| RAG | 引擎就绪 + 4 份预置知识 | RagSeedService 启动加载 |
| 多租户 | JWT→TenantContext（AsyncLocalStorage） | 租户级配置/外部模型 |
| 实时推送 | WebSocket /api/ai/ws + 主动巡检 9 项 | PushGatewayService |
| 运营闭环 | 用量统计/阈值告警/健康监控 | OpsModule |
| 管理接口 | 工具/Provider/配置/外部模型/审计/健康 | AdminController + AiConfig + ExternalModel |

---

## 三、分阶段计划（P0 → P3 → 运营复制）

> **进度**：P0 全量基础 + P1 LT + P2 LN + P3 SE + 认知层管理前端 ✅ 已完成（2026-08-15/16）——认知层三件套全部落地（门控），saas-admin 认知层管理页（记忆/学习/进化门控操作）就绪

### P0 — 全量基础（Orchestrator 图 + 人工闸 + 路由/验证）【4–6 周】

| # | 任务 | 涉及模块 | 验收标准 |
|---|---|---|---|
| P0-1 | Orchestrator 支持 `react` + `graph` 双模式：graph 有状态图（节点=域 Agent，边=流转条件） | brain/orchestrator | 对话请求带 mode=graph 可执行多节点任务并持久化状态 |
| P0-2 | Checkpointer：图状态按 `tenantId+sessionId` 持久化（Redis/DB），支持暂停/恢复/续跑 | brain/checkpointer + 迁移 `ai_graph_state` | 崩溃后可恢复；time-travel 回放历史状态 |
| P0-3 | 多 Agent 协作：选题/脚本/成片等域 Agent 共享 TaskContext，节点间传递不自由对话 | brain/agents | 运营类多步骤任务按图节点顺序执行 |
| P0-4 | 人工确认闸对接现有审核流程：高危写操作/发布类生成待审工单 → 审核回调 → 续跑 | brain + bridge/review-client + 迁移 `ai_review_task` | POST /ai/review + /ai/review/callback 全链路 |
| P0-5 | 工具风险分级 low/medium/high + 高危触发审核 | tools/tool.interface + ToolExecutor | 工具定义带 risk/needsReview，high 自动进闸 |
| P0-6 | C9 自适应路由：按 (tenantId, systemScope, 上下文) 选 Provider+模型+工具 | providers/router | 规则路由生效，配置可切换 |
| P0-7 | C10 证据验证：写操作副作用账本 + 呈现前一致性核查 | brain/evidence | 金额/数量校验通过率可观测 |
| P0-8 | 工具化体系：后端路由 → 工具定义生成器（总台注册表驱动） | scripts + tools | 新增后端 API 可半自动生成工具定义 |

### P1 — 长期记忆 LT【1–2 周】

| # | 任务 | 涉及模块 | 验收标准 |
|---|---|---|---|
| P1-1 | 迁移 3 表：`ai_ltm_profile` / `ai_ltm_episodic` / `ai_ltm_archival` | database + docs/migrations | 表就绪（文件头无注释，对齐 154 教训） |
| P1-2 | LongTermMemoryService：profile 读写 + episodic/archival 向量化落库（租户命名空间） | brain/memory/long-term-memory.service | 会话结束自动抽取摘要入库，带 tenantId |
| P1-3 | ContextBuilder 组装时检索注入：profile + episodic/archival top-k（相关+时效+重要性重排） | brain/context-builder | Prompt 含租户稳定事实与相关经验 |
| P1-4 | 压缩与配额：摘要链 + 租户配额 + TTL 分级 | brain/memory | 超阈值自动淘汰低分/合并摘要 |

### P2 — 自主学习 LN【2–3 周】

| # | 任务 | 涉及模块 | 验收标准 |
|---|---|---|---|
| P2-1 | 反馈信号源：成功/失败/用户修正/显式评分/审核结论 → Experience 结构化 | brain/learning | 每次交互结束可提取经验（what/why/context/outcome） |
| P2-2 | 经验回流：写入 profile/episodic + `tool_select_hint{tid}` / `routing_hint{tid}` | brain/learning + context-builder | 租户经验影响后续工具选择与路由 |
| P2-3 | 采纳评估闭环：`ai_learning_log` 记录应用与效果，提权/降权 | brain/learning | 成功率↑提权、↓降权/废弃 |
| P2-4 | 隔离与安全：经验严格 tenantId，不跨租户、不碰生产数据 | brain/learning | 全链路租户隔离测试 |

### P3 — 自主进化 SE（门控）【3–4 周】

| # | 任务 | 涉及模块 | 验收标准 |
|---|---|---|---|
| P3-1 | 进化对象：prompt / 工具定义 / 工作流（图）/ 新建工具（仅包装既有 API） | brain/evolution | Proposal 生成含 current/proposed/rationale |
| P3-2 | 门控状态机：proposed→review→gray→rolled_out / rejected / rolled_back，对接现有审核 | brain/evolution + review-client | 审核回调驱动状态推进，无免审路径 |
| P3-3 | 版本化 + 快照回滚：`ai_evolution` 表（diff/status/snapshot_prev） | brain/evolution + 迁移 | 异常一键回滚 |
| P3-4 | 灰度：仅提出租户 + 部分 session 生效，观测调用/成功率/审核触发率 | brain/evolution | 灰度指标可观测，异常自动回滚 |
| P3-5 | 安全边界：禁改权限/跨租户/删数据/降风险分级；newtool 仅既有微服务 API | brain/evolution | 安全断言测试全覆盖 |

### 运营复制（管理系统稳定后）【1–2 周】

| # | 任务 | 说明 |
|---|---|---|
| OP-1 | 同 artifact 内嵌运营本地包（前期不占端口） | 配置 SYSTEM_SCOPE=ops |
| OP-2 | 运营域工具注册（~30 个：选题/脚本/成片/分发/直播/投流/选品/订单/对账/客服/复盘） | 下游为总后台微服务（4 个推断端口待注册表确认） |
| OP-3 | 运营三段式 UI（导航/AI对话框/工作区默认总览+任务标签） | 复用管理系统范式 |
| OP-4 | 按需独立部署（用量大时外置 :3015/:3018） | 平移非重构 |

---

## 四、数据模型增量（全部带 tenantId）

| 表 | 用途 | 阶段 |
|---|---|---|
| `ai_graph_state` | 图状态 Checkpointer | P0 |
| `ai_review_task` | AI 待审工单（对接现有审核） | P0 |
| `ai_ltm_profile` / `ai_ltm_episodic` / `ai_ltm_archival` | 长期记忆三件套 | P1 |
| `ai_learning_log` | 学习回流记录 | P2 |
| `ai_evolution` | 进化版本（diff/status/snapshot） | P3 |
| 现有表加字段 | `tenant_ai_config.system_scope`；`ai_audit_log.scope/evolution_id` | P0/P3 |

> 迁移 SQL 规范：**文件头不写注释**（自动迁移按分号拆分会丢弃首条语句，对齐 154 修复教训），说明放文件末尾。

---

## 五、接口增量

| 接口 | 说明 | 阶段 |
|---|---|---|
| `POST /api/chat` 增强 | 支持 `mode=react\|graph`、图状态续跑 | P0 |
| `POST /api/review` | AI 生成待审工单 | P0 |
| `POST /api/review/callback` | 审核结果回写续跑/中止 | P0 |
| `GET/POST /api/admin/memory` | 长期记忆查看/管理（租户内） | P1 |
| `GET/POST /api/admin/learning` | 学习记录查看 | P2 |
| `GET/POST /api/admin/evolution` | 进化版本查看/审批/回滚 | P3 |

---

## 六、里程碑与门控

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| M1 | P0 完成 | graph 模式端到端 + 人工闸对接审核通过；50+ 套件测试 |
| M2 | P1 完成 | 长期记忆跨会话生效（重启后仍记得租户偏好） |
| M3 | P2 完成 | 经验回流可观测（tool_select_hint 影响选型） |
| M4 | P3 完成 | 进化提案→审核→灰度→回滚全链路 + 安全边界测试 |
| M5 | 运营复制 | 管理系统稳定 ≥1 个迭代后启动；ops 工具下游注册表确认 |

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| 认知层（LN/SE）前沿能力风险集中 | P1/P2 先上线，P3 门控后期 |
| 租户串味 | 记忆/向量/审计/进化全链路 tenantId + 命名空间 |
| 进化行为回归 | 复用审核 + 版本化 + 灰度 + 一键回滚 |
| 长期记忆膨胀 | 摘要链 + 配额 + TTL 分级 |
| 迁移 SQL 被自动迁移丢弃 | 文件头不写注释（对齐 154 教训） |
| 运营 4 个推断端口不实 | 管理系统稳定期与总台服务注册表核实后再接线 |

---

## 八、下一步（计划确认后执行顺序）

1. P0-1/P0-2：Orchestrator graph 模式 + Checkpointer（地基）
2. P0-4/P0-5：人工闸 + 工具风险分级（安全前提）
3. P0-8：总台注册表 → 工具生成器（「功能即技能」机制）
4. P1 LT → P2 LN → P3 SE（门控）
5. 运营复制（管理系统稳定后）
