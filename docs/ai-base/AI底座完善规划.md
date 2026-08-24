# AI 底座完善规划（2026-08）

> 依据：`docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md`（v3.5，云端默认+本地兜底）
> 仓库：`wen-868/ZXQL-AI`（独立仓库，管理系统+运营系统共用底座）
> 原则：读全自动、写全审核；所有写入经令牌；结构化抽取不用正则；本地 Ollama 兜底

---

## 一、目录结构与文档对齐（先行，约 2 天）

### 1.1 结论：当前 src/ 是唯一权威文档第十八章的演进超集

基准：`智享AI底座-架构设计文档【唯一权威】.md` **第十八章「项目目录结构」**（开发文档已与架构文档合并，2.2 是业务域「库存管理」，与目录无关）。文档第十八章列出的模块**绝大多数已存在且为超集**，少数模块名有演进（learner→catalog/tool-bootstrap，evolution-engine→brain/learning 等），`migrations/` 尚未迁入：

| 文档第十八章 | 当前实际 | 说明 |
|---|---|---|
| gateway/ dto/ chat/admin controller | ✅ + ai-config/api-catalog/evolution/external-model/learning/ltm/review/voice controller + push-gateway | 网关扩展（管理接口/主动推送/语音） |
| brain/ prompts/ orchestrator/context-builder/memory-manager | ✅ + intent-detector/api-summary/write-summary/inventory-format/confirmation/rollback + graph/evidence/learning/memory/proactive/review/router | 大脑扩展（意图/总结/图编排/认知层） |
| providers/ interface/factory/deepseek/qwen/zhipu/ollama | ✅ + glm/openai-compat/vision/voice（zhipu=glm 命名对应） | Provider 扩展（智谱默认+视觉+语音） |
| tools/ definitions/handlers/ interface/registry | ✅ definitions/catalog/price-engine/unit-converter/tool-bootstrap（handlers 演进为 definitions 内实现） | 功能即技能（55 条 API 目录） |
| bridge/ service-client/tenant.interceptor/audit-logger | ✅（interceptor→middleware 命名演进） | 一致 |
| tenant/ context/guard/ai-config | ✅ tenant-context + tenant.middleware + crypto/ai-config/external-model | 多租户配置扩展 |
| database/ entities（10 个：ai_db 4 + 业务 6） | ✅ 12 个实体（ai_ltm_*/ai_learning_log/ai_evolution 等；**ai_db 4 表尚未独立**，属 P1-1） | 认知表待迁 ai_db |
| common/ config/crypto/rate-limiter/filters/interceptors | ✅ rate-limiter/request-logging（config 由 ConfigService 承担、crypto 移 tenant） | 演进合理 |
| learner/（auto-learner/adapters/tool-generator） | ⚠️ 演进为 tools/catalog + tool-bootstrap + nlp（功能即技能，无独立 learner 目录） | 文档需更新 |
| evolution-engine/（aggregator/trainer/evaluator） | ⚠️ 演进为 brain/learning+memory+proactive+review；ai_db 未独立（P1-1 落地后对齐） | 文档需更新 |
| migrations/（001_ai_tables.sql） | ❌ **缺失（需补）**：文档第 7/22.7/26 章已指向 `zhixiang-ai-base/migrations/001_ai_tables.sql`，独立仓库未迁入 | 迁移目录未迁入 |
| rag/ | ✅（文档第十八章未列，实际已存在且与知识库章节一致） | 一致 |
| knowledge/ | ✅ 9 份运营规则文档 | 一致 |
| （新增）nlp/ | ✅ nl-parser/param-coercer/reference-resolver | 自然语言精准度层 |
| （新增）ops/ | ✅ health-monitor/usage-stats/usage-alert | 运维与用量层 |

**结论**：不需要回退；应**更新唯一权威文档第十八章**反映当前结构（标注 learner/evolution-engine 的演进落点），并补齐 `migrations/`。

### 1.2 待办

- [ ] 更新唯一权威文档**第十八章「项目目录结构」** → 当前实际（learner→catalog/tool-bootstrap、evolution-engine→brain/learning 等演进标注；rag/nlp/ops/evidence/graph 新增模块职责）
- [ ] 建 `migrations/` 目录 + 迁移规范 README（`NNN_描述.sql`、文件头无注释、自动迁移按分号拆分；`001_ai_tables.sql` 对齐文档第 7/22.7/26 章）

---

## 二、功能完善（按唯一权威文档优先级）

### P0-1 WriteGuard 写全审核令牌（文档 22-23 章）【约 3 天】

**现状**：写操作走 confirm 机制（confirmationId + `/api/chat/confirmations/:id/confirm`），前端确认卡已工作。
**目标**：统一为 WriteGuard 令牌制（文档口径：读全自动、写全审核、令牌确认）。

任务：
- [ ] `WriteGuardService`：写操作挂起生成 `token`（Redis，24h TTL），返回 `pendingWrite`（docType/risk/summary）
- [ ] `POST /ai/agent/confirm`：`{ token, action: confirm|cancel }` → 执行/放弃；高危写（资金/删除/批量）二次确认
- [ ] 现有 `ConfirmationService`/前端确认卡对接令牌（保持前端体验，后端改令牌）
- [ ] 审计：`ai_audit_log` 记录挂起/确认/取消全轨迹
- [ ] 测试：读全自动不弹确认、写必令牌、高危二次确认、token 过期/复用拒绝

### P0-2 StructuredExtractor 结构化抽取（文档 23 章）【约 4 天】

**现状**：LLM function calling 直接传参 + 工具 parseArgs 校验（部分正则如 nl-parser 数量解析）。
**目标**：所有写入类型统一结构化抽取，**禁用正则**（文档红线）。

任务：
- [ ] `WriteSchemaRegistry`：14 类 Schema（customer_create/product_create/price_update/sales_order/sales_return/purchase_order/purchase_return/delivery/receipt/payment/refund/inventory_transfer/inventory_check/promotion），字段/类型/必填/枚举/说明
- [ ] `StructuredExtractor.extract(docType, utterance)`：LLM function calling → JSON mode 兜底 → 类型强制+枚举校验 → 必填缺失/解析失败**反问澄清**（不挂残缺草稿）
- [ ] 接入写分支：`AgentOrchestrator` 写意图 → extractor.extract → WriteGuard.suspend（删除散落正则）
- [ ] `nl-parser`/`param-coercer` 收敛为抽取校验的辅助（数量/价格语义），不再承担写入字段抽取
- [ ] 测试：14 类 Schema 各覆盖成功/缺失/非法枚举/澄清分支

### P0-3 MCP 接口（文档 14 章）【约 3 天】

**现状**：无 MCP。
**目标**：`/ai/mcp`（MCP over HTTP/SSE）暴露 ToolRegistry 全部工具，WorkBuddy 等第三方零定制接入。

任务：
- [ ] `mcp_token` 表（tenant_id/token/name/enabled/expires_at）+ 迁移
- [ ] MCP Server：Tools 列表 = ToolRegistry（工具增减自动同步）；Token 认证 → 注入 tenantId
- [ ] 总台配置中心加「MCP 对接 Token」管理（生成/绑定租户/启停）
- [ ] 验证：MCP 客户端（WorkBuddy）走 token 调 createSalesOrder/queryInventory 等

### P1-1 ai_db 认知闭环（文档 26 章）【约 4 天】

**现状**：LT/LN/SE 在业务库内（ai_ltm_*/ai_learning_log/ai_evolution），未独立 ai_db、未闭环反哺 Schema/模板。
**目标**：独立进化底座，四层闭环（采集→萃取→聚合→反哺）。

任务：
- [ ] ai_db 独立库/独立 schema：`ai_experience`/`ai_correction`/`ai_sample`/`ai_evolution_version`（迁移）
- [ ] 采集：任务结束落样本（成功路径/用户纠正/脱敏输入输出对）；审计日志并入
- [ ] 萃取：经验抽取器归纳"为什么错、正确做法"
- [ ] 聚合：跨租户脱敏聚合公共模式（隔离脱敏，不混原始业务数据）
- [ ] 反哺：校准 WRITE_SCHEMAS/归因模板/话术（版本化、人工确认 staged→active、可回滚）
- [ ] 现有 learning/LTM 迁移对齐 ai_db

### P1-2 配置中心完善（文档 6 章）【约 3 天】

**现状**：总台"模型配置"页（全局默认），tenant_ai_config 实体已有。
**目标**：全局默认 + 租户配置列表 + 用量概览 + MCP Token 管理。

任务：
- [ ] 租户 AI 配置 API + 列表页（搜索/编辑/启停，服务商/模型/Key/温度/Token/系统提示词）
- [ ] 用量概览（ai_usage_daily 已有）→ 页面卡片（Token/费用/调用数/活跃租户）
- [ ] 模型配置页补齐"本地兜底开关"（OLLAMA_FALLBACK_ENABLED）
- [ ] MCP Token 管理入口（配合 P0-3）

### P1-3 降级容灾：云端默认 + 本地兜底（文档 17 章）【约 2 天】

**现状**：GLM 默认，超时 90s；无自动降级链。
**目标**：zhipu(默认) → ollama(本地兜底) → deepseek/qwen(备用)；Provider 超时/熔断。

任务：
- [ ] Provider 降级链（providerFallbackChain：zhipu→ollama→deepseek→qwen；ollama→zhipu）
- [ ] `OLLAMA_FALLBACK_ENABLED` 开关（默认 true）；Provider 调用超时/失败自动切换
- [ ] Tool 级独立熔断（文档决策 17：防止微服务故障拖垮底座）
- [ ] 降级可观测（审计记录 fallback 原因/耗时）

### P2-1 双线统筹：运营系统接入（文档 25 章）【待管理系统稳定后】

- [ ] `SYSTEM_SCOPE=ops`，运营工具 30 个（选题/脚本/成片/分发/直播/投流/选品/订单/对账/客服/复盘）
- [ ] 运营客户端本地打包对接（SSE + WriteGuard，本地/内网通道，对客推理强制本地）
- [ ] customerScope 隔离（对客请求身份/数据可见性/写闸门边界）

---

## 三、质量门禁（每阶段强制）

| 门禁 | 标准 |
|---|---|
| 单元测试 | 新增模块用例 ≥ 80% 覆盖；全量 `pnpm test -- --runInBand` 全绿 |
| lint | `eslint "src/**/*.ts"` 0 错误 |
| build | `pnpm run build` 通过 |
| 启动门禁 | `node scripts/check-ai-base-start.mjs` 通过（防 DI 错误） |
| e2e | `node scripts/ai-base-e2e.mjs` 15 项全过（每阶段补对应场景） |

---

## 四、里程碑

| 里程碑 | 内容 | 预计 |
|---|---|---|
| M1 | 目录/文档对齐 + WriteGuard + StructuredExtractor（写全审核闭环） | 2 周 |
| M2 | MCP 第三方对接 + ai_db 认知闭环 | 2 周 |
| M3 | 配置中心完善 + 降级容灾（云端默认/本地兜底落地） | 1 周 |
| M4 | 运营双线接入（SYSTEM_SCOPE=ops） | 管理系统稳定后 |

---

## 五、当前基线（已完成）

- 代码基线：73 套件 746 用例全绿、build/lint/启动门禁通过
- 工具：96 个（精调 49 + API 目录 55），意图驱动动态加载（prompt 7 万→2.7 万 tokens）
- 自然语言层：数量口语解析/参数自纠错/指代消解/搜索词清洗
- 感知：图片识别（GLM-4V）、语音输入/播报；输出：图表渲染
- 多 Agent：3 条业务图（采购/营销/盘点）；经验闭环（LTM/LN/SE）
