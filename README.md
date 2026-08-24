# 智享 AI 底座（ZXQL-AI）

> 智享全链 SaaS 的共用 AI 底座 —— 管理系统（mgmt）、运营系统（ops）共用的智力中枢。
> 独立仓库（`wen-868/ZXQL-AI`），当前与管理系统一起部署，为后续**单独部署服务器**做准备。

---

## 1. 定位

- 一个独立的 NestJS 服务（`name: ai-base`），对外提供对话问答、经营分析、主动提醒、开单/查库等 AI 能力。
- **共用底座**：管理系统、运营系统都接它；`SYSTEM_SCOPE` / `scope` 预留 `mgmt|ops` 多系统形态。
- **同一套账号体系**：只解析管理系统的同一个 JWT（共享 `JWT_SECRET` / `CSRF_SECRET`），不再额外造一套登录。
- **当前未接运营系统**：现阶段只指向管理系统后端（`BACKEND_API_BASE`），运营系统接入是后续阶段。
- **不持有业务数据**：所有业务查询/写操作都通过 HTTP 调用管理系统后端（`bridge/service-client`），AI 层只做理解、编排、结论与记忆。

## 2. 技术栈

- NestJS 11（TypeScript）+ TypeORM + MySQL（表：`liquor_inventory` 库）
- Redis（`DB1` 存对话记忆，避免与 backend 冲突；`ioredis`）
- 多 LLM 供应商：智谱 GLM / DeepSeek / Ollama（`providers`）
- RAG 知识库（`rag`）：embedding 可选本地 Ollama 或智谱 `embedding-3`
- SSE 流式对话 + WebSocket 实时推送（`gateway`）
- 文件解析：`mammoth`（Word）、`pdf-parse`（PDF）、`xlsx`（Excel）
- 语音：可选讯飞 TTS（`TTS_PROVIDER`）；默认降级系统 TTS

## 3. 目录结构（`src/`）

| 目录 | 职责 |
| --- | --- |
| `brain/` | 意图识别、对话编排、上下文构建、记忆管理、状态图（graph）、自主进化（evolution）、主动业务监控（proactive：库存预警/日报/流失/异常）、审批回滚（rollback） |
| `bridge/` | 对接管理系统后端（`service-client`）、审计日志（`audit-logger`） |
| `common/` | 限流（rate-limiter）、请求日志中间件 |
| `database/` | TypeORM 实体与数据访问 |
| `gateway/` | SSE 流式对话 / WebSocket 实时推送入口 |
| `nlp/` | 自然语言处理（商品/数字/日期解析、库存文本格式化） |
| `ops/` | 运维配置、用量监控、健康自检 |
| `providers/` | LLM 供应商路由（glm / deepseek / ollama） |
| `rag/` | 知识库检索增强（向量化 + 召回） |
| `tenant/` | 多租户 JWT 解析、租户维度隔离 |
| `tools/` | AI 工具注册（API 目录工具：功能即技能） |

## 4. 环境变量

复制 `.env.example` 为 `.env` 后按需替换（敏感项禁止提交）：

```bash
cp .env.example .env
```

关键项（与管理系统 backend 共享）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `3016`（nginx `/ai-api/` 反代到此） |
| `SYSTEM_SCOPE` | `mgmt`=管理系统 / `ops`=运营系统；当前 `mgmt` |
| `DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE` | 与 backend 共用 MySQL；`DB_DATABASE` 默认 `liquor_inventory`，须与 backend 的 `DB_NAME` 一致 |
| `REDIS_HOST/REDIS_PORT/REDIS_PASSWORD/REDIS_DB` | 共用 Redis，`REDIS_DB=1` 存对话记忆 |
| `BACKEND_API_BASE` | 管理系统后端地址，默认 `http://127.0.0.1:8080` |
| `JWT_SECRET` / `CSRF_SECRET` | 与 backend 一致；`CSRF_SECRET` 用于写操作时计算 `x-csrf-token` |
| `ENCRYPTION_KEY` | API Key 加密密钥（32 字节 hex）；部署脚本会强制生成真实密钥 |
| `GLM_BASE_URL/GLM_API_KEY/GLM_MODEL` | 智谱（默认 `glm-4-flash` 免费） |
| `EMBEDDING_BASE_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL` | RAG；未配置则自动降级禁用 |
| `ENABLE_API_CATALOG_TOOLS` | 启动时自动注册 API 目录工具（需管理系统先登记） |

> ⚠️ `.env` 已在 `.gitignore` 中，禁止提交；`.env.example` 可提交。

## 5. 本地开发

```bash
pnpm install
cp .env.example .env      # 填好 DB/Redis/JWT/GLM 等
pnpm run start:dev        # 或 pnpm run start
```

健康检查：`curl http://127.0.0.1:3016/api/health`

## 6. 生产部署

### 当前（与管理系统一起部署）

- 由管理系统部署流水线触发：`auto-deploy.sh` → `deploy/ai-base-deploy.sh`。
- `ai-base-deploy.sh` 现在从**独立仓库 `ZXQL-AI`** 检出到服务器 `/opt/zhixiang/ai-base` 并构建（若独立仓库不可用，自动回退到旧的 `backend/ai-base`，保证旧 AI 不停）。
- 以 `pm2` 运行，进程名 `zhixiang-ai-base`，端口 `3016`；
- nginx 反代 `/ai-api/*` → `http://127.0.0.1:3016/`（SSE + WebSocket 已配 `proxy_http_version 1.1` / `Upgrade` / `Connection`）。

### 未来（单独部署）

- AI 底座可作为独立服务部署到独立服务器，只复用 MySQL / Redis 与管理系统后端地址（`BACKEND_API_BASE` 指向公网可达地址），无需依赖管理系统的进程。
- 部署时只需：克隆本仓库 → `pnpm install` → `pnpm build` → `pnpm run start:prod`，并按 `.env.example` 配置。

## 7. 迁移分阶段（进行中）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| A | 源码从管理系统 `backend/ai-base` 迁出为独立仓库 `ZXQL-AI`，推送到 GitHub `wen-868/ZXQL-AI` | ✅ 完成 |
| B | 管理系统部署脚本 `deploy/ai-base-deploy.sh` 改为从 `ZXQL-AI` 独立仓库拉取/构建（保留 `backend/ai-base` 回退） | ✅ 完成 |
| C | 服务器切换：用 `ZXQL-AI` 起新实例 → 健康检查通过 → 切网关/停旧 AI（旧 AI 全程不停） | ⏳ 需在服务器执行 |
| D | 单源化：确认新实例稳定后，从管理系统仓库删除 `backend/ai-base`，全部以 `ZXQL-AI` 为唯一来源 | ⏳ 待 C 验证后执行 |

> 红线：C/D 阶段涉及生产切换，必须在服务器上实测（健康检查 + 端到端）通过后再删旧文件；全程保留 `backend/ai-base` 作为回退点，禁止破坏性操作。

## 8. 常见问题

- **RAG 不生效**：确认 `EMBEDDING_MODEL` 已配置且 embedding 服务可达；未配置时该功能自动降级禁用（对话不受影响）。
- **写操作 500 / 权限**：确认 `CSRF_SECRET` 与 backend 一致，且管理系统后端已启用对应接口。
- **Node 版本**：建议 Node 20 + pnpm@9（`ai-base-deploy.sh` 会强制 pnpm@9）。
