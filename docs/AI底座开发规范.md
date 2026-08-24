# 智享 AI 底座 — 开发规范

> 版本：v1.0 ｜ 2026-08-24 ｜ 适用范围：`ZXQL-AI` 仓库全部研发。
> 依据：`docs/设计/`（最新开发/设计文档，AI 大修依据）+ `docs/ai-base/`（既有底座文档）+ `docs/规范/`（平台级通用规范）。冲突时以 `docs/设计/` 为准。

## 1. 定位与红线（先记住）

- 本服务是**管理系统（mgmt）/ 运营系统（ops）共用 AI 底座**，当前只接管理系统。`SYSTEM_SCOPE=mgmt`，`scope: mgmt|platform` 预留多系统。
- **同一套账号体系**：只解析管理系统同一个 JWT（共享 `JWT_SECRET`/`CSRF_SECRET`），**绝不另造登录**。
- **不持有业务数据**：业务查询/写操作一律经 `bridge/service-client` 调管理系统后端（`BACKEND_API_BASE`），AI 层只做理解、编排、结论、记忆。
- ❌ **禁止假数据 / 模拟数据**（包括在注释里）；无真实数据处按空态/`—` 处理。
- ❌ **禁止臆造字段/接口**；凡涉及对接管理系统的字段，**必须抠后端 `controllers/*` + `services/*` 的 req.body/返回真实结构**，以 backend 为唯一真相源。
- ❌ **只改有问题处**；不顺手重构、不做无关「优化」。
- ❌ **禁止把管理系统代码耦合进本仓库**；跨系统只能走 HTTP + 共享 DB/Redis + 共享密钥。

## 2. 技术栈

- NestJS 11（TS 5.x）+ TypeORM + MySQL（`liquor_inventory`）。
- Redis（`REDIS_DB=1` 存对话记忆，避免与 backend 冲突）。
- 多 LLM 供应商：GLM / DeepSeek / Ollama（`providers`）。
- RAG（`rag`，embedding 可选 Ollama 或智谱 `embedding-3`）。
- SSE 流式对话 + WebSocket 实时推送（`gateway`）。

## 3. 目录职责（`src/`）

| 目录 | 职责 |
| --- | --- |
| `brain/` | 意图/编排/上下文/记忆/状态图/进化/主动监控/审批回滚 |
| `bridge/` | 对接管理系统后端（service-client）、审计日志 |
| `common/` | 限流、请求日志中间件 |
| `database/` | TypeORM 实体与数据访问 |
| `gateway/` | SSE / WebSocket 入口 |
| `nlp/` | 商品/数字/日期解析、库存文本格式化 |
| `ops/` | 运维配置、用量监控、健康自检 |
| `providers/` | LLM 供应商路由 |
| `rag/` | 知识库检索增强 |
| `tenant/` | 多租户 JWT 解析、租户维度隔离 |
| `tools/` | AI 工具注册（API 目录工具：功能即技能） |

- 新增功能归入对应目录；**避免在单一 controller/service 里堆一坨**。

## 4. 代码规范

- TypeScript `strict: true`；不用 `any`、不用 `as any` 掩盖类型问题。
- 面向**接口契约**定义类型：新增提交体/返回体，用显式 `*Payload`/`*Response` 类型，杜绝 `as any`。
- 遵循 `docs/规范/项目统一标准.md`（命名、注释、文件组织、测试闭环）。
- 遵循 `docs/规范/代码审查规范.md` 与 `docs/规范/项目规则.md`。
- 格式化：`pnpm run format`（prettier）；lint：`pnpm run lint` 0 error。

## 5. 工具（Tool）开发规范 —— 功能即技能

- 工具必须实现 `ITool`：`name`/`description`/`parameters`(JSON Schema)/`category`/`isWriteOperation`/`requiredTools`/`execute(args,ctx)`。
- **写操作工具**：必须走 `docs/ai-base/智享AI助手-写入操作规范.md` 的 6 步写入流程（审批/确认/回滚），且 `isWriteOperation=true`。
- 工具向 LLM 暴露前，需经参数校验（zod）+ 权限判断（租户维度）。
- **API 目录工具**：启用 `ENABLE_API_CATALOG_TOOLS` 后，管理系统登记即成为技能；未登记不臆造。
- 新增工具必须带单元测试（`*.spec.ts`），`pnpm run test` 通过。

## 6. AI 能力开发

- **记忆**：短期对话记忆存 Redis DB1；长期/情节记忆按 `brain/memory/*`；注意租户隔离与容量上限（`MEMORY_MAX_ROUNDS`/`LTM_EPISODIC_MAX`）。
- **主动服务**：`brain/proactive/*`（库存预警/日报/流失/异常等），消费真实后端数据，禁止 fake 数据驱动。
- **进化/灰度**：`EVOLUTION_GRAY_PERCENT` 灰度，审核通过后才放量。
- **RAG**：未配置 `EMBEDDING_MODEL` 时自动降级禁用，对话不报错；知识来源以 `knowledge/` 为准。

## 7. 安全规范

- `.env` 及本地密钥**禁止提交**（`.gitignore` 已排除）；敏感项用环境变量。
- `JWT_SECRET`/`CSRF_SECRET` 与管理系统 backend **保持一致**；`CSRF_SECRET` 缺失时回退 `JWT_SECRET` 计算 `x-csrf-token`（与 backend 逻辑一致）。
- `ENCRYPTION_KEY` 必须是真实 32 字节 hex（部署脚本自动生成/校验，禁止占位符启动）。
- 限流：`RATE_LIMIT_PER_MINUTE` 按租户；对接后端写操作带 `x-csrf-token`。
- 遵循 `docs/规范/密钥管理规范.md`。

## 8. 测试与验收

- 单元：`pnpm run test`（jest）；e2e：`pnpm run test:e2e`。
- 门禁：`pnpm run build` / `pnpm run lint` / `pnpm run test` 三者必须全绿才算完成。
- 验收：健康检查 `/api/health`（HTTP 200）+ 关键链路端到端（真实 LLM + 真实后端）。
- 对接后端接口改动，务必实测（不要只读类型定义就提交）。

## 9. 部署

- **当前**：与管理系统一起部署，由 `auto-deploy.sh` → `ai-base-deploy.sh` 拉取 `ZXQL-AI` 到服务器 `/opt/zhixiang/ai-base` 构建；pm2 进程 `zhixiang-ai-base`，端口 `3016`；nginx `/ai-api/*` 反代。
- **未来**：可独立部署，仅复用 MySQL/Redis + `BACKEND_API_BASE`。
- 服务器切换/单源化遵循 `docs/规范/verify-five-defense.md`，**旧服务不停、留回退点**。

## 10. 文档与协作

- 需求/设计变更：更新 `docs/ai-base/` 对应文档或 `docs/AI底座开发规范.md`。
- 踩坑：追加到 `docs/规范/踩坑日志.md`（避免复用）。
- 改动提交信息用中文，含（AI底座|工具|记忆|RAG|gateway|provider|docs|deploy）前缀 + 一句话说明。
- 每次开发前先读 `docs/README.md` 列出的必读文档。
