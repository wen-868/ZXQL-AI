# 智享全链 AI 底座 — 开发文档

> 版本：v2.1 | 日期：2026-07-31

> **修改说明（v2.1）**：与项目统一标准对齐。主要变更：①数据库表名统一加 `t_` 前缀；②API路径改为系统标准前缀（`/api/admin/`、`/api/platform/`）；③微服务描述改为单体后端（Express.js），第九章端口表格改为API前缀表格并对齐现有系统路由；④迁移脚本路径规范为 `docs/migrations/`，文件命名 `NNN_描述.sql`；⑤前端代码示例 API 路径对齐；⑥返回体改为统一格式（code/msg/data/traceId/apiCost）；⑦新增 12.5「与项目统一标准的关系」。

---

## 目录

1. [环境准备](#一环境准备)
2. [项目初始化](#二项目初始化)
3. [功能开发优先级矩阵](#三功能开发优先级矩阵)
4. [端到端开发流程](#四端到端开发流程)
5. [模块开发顺序](#五模块开发顺序)
6. [Provider 开发指南](#六provider-开发指南)
7. [Tool 开发指南](#七tool-开发指南)
8. [Brain Engine 开发指南](#八brain-engine-开发指南)
9. [后端服务对接指南](#九后端服务对接指南)
10. [前端组件开发指南](#十前端组件开发指南)
11. [数据库迁移指南](#十一数据库迁移指南)
12. [编码规范](#十二编码规范)
13. [测试方案](#十三测试方案)
14. [调试指南](#十四调试指南)
15. [部署指南](#十五部署指南)
16. [CI/CD 配置](#十六cicd-配置)
17. [常见问题](#十七常见问题)

---

## 一、环境准备

### 1.1 必需环境

| 工具 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | >= 18.x | 推荐 20 LTS |
| pnpm | >= 8.x | 包管理器 |
| NestJS CLI | latest | `pnpm add -g @nestjs/cli` |
| TypeScript | ^5.x | 与NestJS匹配 |
| MySQL | 8.0 | 新增3张表（共享现有实例） |
| Redis | 7.x | 对话记忆（共享现有实例） |

### 1.2 推荐工具

| 工具 | 用途 |
|------|------|
| VS Code | 编辑器 |
| Thunder Client / Postman | API调试 |
| Redis Insight | Redis可视化管理 |
| DBeaver | 数据库管理 |

### 1.3 环境变量模板

参见项目 `.env.example`，核心配置项：

| 配置组 | 关键变量 | 说明 |
|--------|---------|------|
| **服务** | PORT=3016, NODE_ENV | 服务端口和运行环境 |
| **AI Provider** | DEFAULT_MODEL_PROVIDER（默认 glm）, GLM_BASE_URL/GLM_API_KEY/GLM_MODEL, DEEPSEEK_API_KEY | 默认服务商和API Key（glm 为内置免费兜底，默认 glm-4-flash） |
| **加密** | ENCRYPTION_KEY | API Key加密密钥（32字节hex） |
| **Redis** | REDIS_HOST, REDIS_PORT, REDIS_DB=1 | 对话记忆存储，使用DB1避免冲突 |
| **后端服务** | BACKEND_API_BASE | 现有后端服务（Express.js单体，默认端口8080）的API基础地址 |
| **AI参数** | DEFAULT_TEMPERATURE=0.3, DEFAULT_MAX_TOKENS=2048 | LLM调用参数 |
| **限流** | RATE_LIMIT_PER_MINUTE=60 | 每租户限流 |

> 生成加密密钥：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 二、项目初始化

### 2.1 创建项目

```bash
nest new zhixiang-ai-base --package-manager pnpm --skip-git --strict
cd zhixiang-ai-base

# 核心依赖
pnpm add @nestjs/config @nestjs/axios axios ioredis zod class-validator class-transformer
pnpm add @nestjs/typeorm typeorm mysql2 @nestjs/schedule

# 开发依赖
pnpm add -D @types/node @types/ioredis
```

### 2.2 目录结构

```
src/
├── main.ts                     # 入口
├── app.module.ts               # 根模块
├── gateway/                    # 对外网关
│   ├── dto/
│   ├── chat.controller.ts
│   └── admin.controller.ts
├── brain/                      # 大脑引擎
│   ├── prompts/
│   ├── orchestrator.service.ts
│   ├── context-builder.service.ts
│   └── memory-manager.service.ts
├── providers/                  # Model Provider
│   ├── provider.interface.ts
│   ├── provider-factory.ts
│   ├── deepseek.provider.ts
│   └── ollama.provider.ts
├── tools/                      # 业务工具
│   ├── definitions/
│   ├── handlers/
│   ├── tool.interface.ts
│   └── tool-registry.ts
├── bridge/                     # 服务桥接
│   ├── service-client.ts
│   └── audit-logger.ts
├── tenant/                     # 多租户
│   ├── tenant-context.ts
│   └── tenant-guard.ts
├── database/                   # 数据库Entity
│   └── entities/
├── rag/                        # RAG引擎
└── common/                     # 公共模块
    ├── config.ts
    └── crypto.ts

knowledge/                      # 知识库文件
docs/migrations/                # 数据库迁移（遵循项目统一标准，命名 NNN_描述.sql）
```

### 2.3 验证启动

```bash
cp .env.example .env
pnpm run start:dev
# 输出: AI底座已启动: http://localhost:3016
```

---

## 三、功能开发优先级矩阵

### 3.1 P0 — 必须先完成（核心骨架）

| 模块 | 功能 | 依赖 | 工时估算 | 验收标准 |
|------|------|------|----------|----------|
| **Provider** | IModelProvider接口 + DeepSeek实现 | 无 | 2天 | DeepSeek API对话成功 |
| **Provider** | ProviderFactory | Provider接口 | 0.5天 | 可切换Provider |
| **Gateway** | SSE流式对话接口 | Provider + Brain | 1天 | 前端可收到流式文本 |
| **Gateway** | Admin管理API | ToolRegistry | 0.5天 | 查工具/测试连接 |
| **Tool** | ToolRegistry + ToolExecutor | 无 | 1天 | 工具注册/执行成功 |
| **Tool** | order.tool（7个工具定义+handler） | ToolRegistry + ServiceBridge | 2天 | "创建销售单"端到端 |
| **Bridge** | ServiceClient（HTTP调用后端API） | 无 | 1天 | 可调用后端 /api/admin/sale-bills |
| **Bridge** | AuditLogger | ServiceClient | 0.5天 | 日志写入 |
| **Tenant** | TenantContext + TenantGuard | 无 | 1天 | JWT解析+tenantId注入 |
| **Brain** | ContextBuilder | 无 | 0.5天 | System Prompt正确组装 |
| **Brain** | Orchestrator（Agent Loop） | 全部P0模块 | 2天 | 完整对话+Tool调用循环 |

**P0 合计：约 11 天**

### 3.2 P1 — 核心业务功能

| 模块 | 功能 | 依赖 | 工时估算 | 验收标准 |
|------|------|------|----------|----------|
| **Tool** | inventory.tool（3个） | P0全部 | 1天 | 查库存/调拨/盘点 |
| **Tool** | product.tool（2个） | P0全部 | 0.5天 | 查商品/改价格 |
| **Tool** | customer.tool（2个） | P0全部 | 0.5天 | 查客户/建客户 |
| **Tool** | purchase.tool（2个） | P0全部 | 1天 | 创建/查询采购单 |
| **Tool** | delivery.tool（2个） | P0全部 | 1天 | 查配送/创建配送 |
| **Tool** | finance.tool（2个） | P0全部 | 1天 | 查应收/应付 |
| **Tool** | report.tool（3个） | P0全部 | 1天 | 销售/库存/利润报表 |
| **Brain** | MemoryManager（Redis） | Redis连接 | 1天 | 对话历史读写 |
| **Database** | 3张新表Entity + AiConfigService | MySQL连接 | 1天 | 配置读写 |
| **Tenant** | AiConfigService（动态Provider） | Database | 1天 | 租户级切换 |

**P1 合计：约 10 天**

### 3.3 P2 — 完善、体验、运维

| 模块 | 功能 | 依赖 | 工时估算 | 验收标准 |
|------|------|------|----------|----------|
| **RAG** | 向量存储 + 文档加载 + 检索 | Ollama/Ollama embedding | 2天 | 知识检索增强回答 |
| **前端** | AI对话窗口组件（Web） | Gateway SSE | 2天 | Web端可对话 |
| **前端** | 移动端对话页面（H5） | Gateway SSE | 1.5天 | 移动端App/H5可对话 |
| **前端** | 总台AI配置页面 | Admin API | 2天 | 可管理租户AI配置 |
| **安全** | 限流（令牌桶） | Redis | 0.5天 | 60次/分钟限制生效 |
| **安全** | API Key加密存储 | crypto | 0.5天 | AES-256加密/解密 |
| **运维** | 健康检查 + 监控指标 | 全部模块 | 1天 | /api/admin/health正常 |
| **运维** | 日志聚合 + 告警 | AuditLogger | 1天 | 异常自动告警 |
| **CI/CD** | Dockerfile + 部署脚本 | 全部模块 | 1天 | 一键部署 |

**P2 合计：约 11 天**

### 3.4 总工时估算

| 优先级 | 工时 | 累计 | 里程碑 |
|--------|------|------|--------|
| P0 | 11天 | 11天 | 骨架可运行，"创建销售单"端到端 |
| P1 | 10天 | 21天 | 全部业务Tool就绪，多租户配置 |
| P2 | 11天 | 32天 | 前端上线，RAG，运维完善 |

> **建议1人开发：约6-7周。2人并行：约3-4周。**

---

## 四、端到端开发流程

### 4.1 从零到上线的完整步骤

```
Step 1 ──────▶ Step 2 ──────▶ Step 3 ──────▶ Step 4 ──────▶ Step 5
环境准备        项目初始化      Provider       Gateway+SSE    Tool Registry
+ 依赖安装      + 目录结构      + DeepSeek      + ChatController+ Tool定义
+ .env配置      + 入口代码      + ProviderFactory               + Handler

验收:           验收:          验收:          验收:            验收:
服务器可达       pnpm start     DeepSeek对话    SSE流式返回      工具注册成功
MySQL/Redis OK  不报错          返回正常        前端可接收        可执行Tool

Step 6 ──────▶ Step 7 ──────▶ Step 8 ──────▶ Step 9 ──────▶ Step 10
Service Bridge  Brain Engine   order Tool     TenantGuard     数据库迁移
+ HTTP Client   + ContextBuilder 7个工具       + JWT解析       + 3张新表
+ AuditLogger   + MemoryManager + Handler      + tenantId注入  + AiConfigService
                + Orchestrator

验收:           验收:          验收:          验收:            验收:
调用后端成功     Agent Loop     "创建销售单"    tenantId自动     配置读写
                正常           端到端成功      注入到Tool

Step 11 ──────▶ Step 12 ──────▶ Step 13 ──────▶ Step 14
剩余Tool        前端组件        安全+限流       部署上线
8个业务Tool     对话窗口        API Key加密     Dockerfile
                总台配置页      令牌桶限流      docker-compose

验收:           验收:          验收:          验收:
全部24个Tool    Web/移动端      限流生效        一键启动
注册成功        可对话          加密存储        健康检查正常
```

### 4.2 每个步骤的验收标准详述

| Step | 验收命令 | 预期输出 |
|------|----------|----------|
| 1 | `mysql -u root -p -e "SELECT 1"` | MySQL连接成功 |
| 1 | `redis-cli ping` | PONG |
| 2 | `pnpm run start:dev` | AI底座已启动: http://localhost:3016 |
| 3 | `curl localhost:3016/api/admin/test-connection` | `{"type":"glm","success":true,...}`（测试默认 Provider 连通性） |
| 4 | `curl -X POST localhost:3016/api/chat -H "Content-Type: application/json" -d '{"message":"你好","tenantId":"default"}'` | SSE流式文本 |
| 5 | `curl localhost:3016/api/admin/tools` | 工具列表JSON |
| 6 | `curl localhost:8080/api/admin/sale-bills`（测试后端可达） | 订单列表 |
| 8 | 对话："红星商行20件五粮液价格980" | 销售单创建成功 |
| 10 | `mysql -e "SHOW TABLES LIKE 't_%ai%'"` | 3张新表 |

---

## 五、模块开发顺序

> **严格按此顺序开发，每个模块完成后立即验证。**

```
Week 1-2: 骨架（P0）
═══════════════════════════════════════════

  Step 1  ──▶  Step 2  ──▶  Step 3  ──▶  Step 4  ──▶  Step 5
  项目初始化   Provider     Chat        Tool         Service
              + DeepSeek   Controller   Registry     Bridge

Week 3-4: 核心功能（P0 + P1前半）
═══════════════════════════════════════════

  Step 6  ──▶  Step 7  ──▶  Step 8  ──▶  Step 9
  Context     Brain        order.       inventory.
  Builder     Engine       tool         tool + product + customer

Week 5-6: 业务完善（P1后半 + P2前半）
═══════════════════════════════════════════

  Step 10 ──▶ Step 11 ──▶ Step 12 ──▶ Step 13
  剩余Tool    AI配置       多租户       RAG + 前端
  采购/配送    API          上下文       对话窗口
  财务/报表
```

---

## 六、Provider 开发指南

### 6.1 接口定义

```typescript
// src/providers/provider.interface.ts

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, {
        type: string;
        description?: string;
        enum?: string[];
        items?: any;
      }>;
      required?: string[];
    };
  };
}

export interface ChatOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ChatStreamChunk {
  content: string;
  toolCalls?: Partial<ToolCall>[];
  finishReason?: string;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface IModelProvider {
  readonly name: string;
  configure(config: ProviderConfig): void;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}
```

### 6.2 DeepSeek Provider（参考实现）

> 详见项目源码 `src/providers/deepseek.provider.ts`

核心逻辑：
- `configure()`: 设置API Key、baseUrl、model等参数
- `chat()`: POST `/chat/completions`，支持Function Calling
- `chatStream()`: 同上，stream=true，逐行解析SSE
- `embed()`: DeepSeek不支持，抛异常提示用其他Provider
- `healthCheck()`: 发送一条最短消息验证连通性

### 6.3 Provider 工厂

```typescript
// src/providers/provider-factory.ts

@Injectable()
export class ProviderFactory {
  private readonly providers = new Map<string, IModelProvider>();

  constructor(private readonly glm, private readonly deepseek, private readonly ollama) {
    this.providers.set('glm', glm);
    this.providers.set('deepseek', deepseek);
    this.providers.set('ollama', ollama);
  }

  create(type: string, config: ProviderConfig): IModelProvider {
    const provider = this.providers.get(type);
    if (!provider) throw new Error(`Unknown provider: ${type}`);
    provider.configure(config);
    return provider;
  }

  list(): string[] {
    return Array.from(this.providers.keys());
  }
}
```

### 6.4 新增Provider的标准流程

```
1. 创建 src/providers/xxx.provider.ts
2. 实现 IModelProvider 接口的所有方法
3. 在 ProviderModule 中注册为 Provider
4. 在 ProviderFactory 的 providers Map 中添加
5. 在 t_tenant_ai_config 的 provider 字段值域中新增选项
6. 测试 healthCheck 和 chat 方法
```

---

## 七、Tool 开发指南

### 7.1 Tool 接口

```typescript
// src/tools/tool.interface.ts

export interface ToolContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  role?: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  suggestion?: string;
}

export interface ToolHandler {
  name: string;
  category: string;
  definition: ToolDefinition;
  execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult>;
}
```

### 7.2 Tool Registry

核心方法：
- `register(handler)`: 注册工具
- `getAllDefinitions()`: 返回所有Tool的Function Calling schema给LLM
- `execute(name, args, context)`: 执行指定工具
- `list()`: 列出所有已注册工具

### 7.3 定义规范

每个 Tool 定义文件（`src/tools/definitions/xxx.tool.ts`）遵循以下规范：

| 要素 | 要求 |
|------|------|
| name | 唯一，camelCase，语义明确（如 `createSalesOrder`） |
| description | 必须描述清楚用途、前置条件、返回内容 |
| parameters | 每个字段必须有 description，required 字段标注 |
| enum | 状态/类型字段用 enum 约束（如 status: pending/confirmed/shipped） |

### 7.4 Handler 实现模式

```typescript
// 两种模式:

// 模式A：独立Handler（复杂业务，如 order）
@Injectable()
export class OrderToolHandler {
  constructor(private registry: ToolRegistry, private client: ServiceClient) {
    // 注册时绑定每个方法
    for (const tool of ORDER_TOOLS) {
      this.registry.register({
        name: tool.function.name,
        category: 'order',
        definition: tool,
        execute: (args, ctx) => this.dispatch(tool.function.name, args, ctx),
      });
    }
  }
  
  private dispatch(name: string, args: any, ctx: ToolContext): Promise<ToolResult> {
    // 按name分发到具体方法
  }
}

// 模式B：通用Handler（简单CRUD，如 finance/report）
@Injectable()
export class BusinessToolHandler {
  constructor(private registry: ToolRegistry, private client: ServiceClient) {
    // 通用注册，转发到后端API
    for (const tool of FINANCE_TOOLS) {
      this.registry.register({
        name: tool.function.name,
        category: 'finance',
        definition: tool,
        execute: (args, ctx) => this.executeGeneric('finance', tool.function.name, args, ctx),
      });
    }
  }
  
  private async executeGeneric(service, toolName, args, ctx) {
    return this.client.post(`${this.client.getServiceUrl(service)}/${toolName}`, {
      body: args, tenantId: ctx.tenantId, userId: ctx.userId,
    });
  }
}
```

> **推荐**: order/inventory/customer 用模式A（业务逻辑复杂），finance/report/delivery 用模式B（简单转发）。

### 7.5 新增Tool标准流程

```
1. src/tools/definitions/xxx.tool.ts → ToolDefinition[]
2. src/tools/handlers/xxx.handler.ts → 实现逻辑 + 注册到Registry
3. src/app.module.ts → providers 中添加 Handler
4. 测试: curl /api/admin/tools 查看新工具
5. 测试: 对话中使用自然语言触发该工具
```

---

## 八、Brain Engine 开发指南

### 8.1 Orchestrator（Agent Loop核心）

核心流程：

```
用户消息 → 加载历史 → 组装上下文 → LLM调用 → 判断finishReason
  │
  ├─ stop → 返回文本，保存记忆，写审计日志
  │
  ├─ tool_calls → 执行Tool → Tool结果加入上下文 → 再次LLM调用
  │                （最多10轮循环）
  │
  └─ length → 截断返回
```

关键参数：
- `MAX_ITERATIONS = 10`: 防止死循环
- `MEMORY_ROUNDS = 10`: 保留最近10轮对话
- `TTL = 3600`: 对话记忆1小时过期

### 8.2 ContextBuilder

System Prompt模板：

```
你是智享管理系统（批零一体即时零售SaaS平台）的AI助手。

## 你的身份
- 当前租户ID：{tenantId}
- 当前用户：{userName}（{role}）

## 你的能力
[按业务域列出所有可用Tool]

## 工作规则
1. 写操作前必须确认关键信息
2. 金额数量必须精确
3. 结果用表格呈现
4. 异常如实告知并给建议
```

### 8.3 MemoryManager

- Redis Key格式: `ai:memory:{tenantId}:{sessionId}`
- 数据格式: JSON数组 `[ChatMessage, ChatMessage, ...]`
- 截断策略: 保留最近10轮（20条消息）
- 过期策略: 1小时TTL

---

## 九、后端服务对接指南

### 9.1 对接方式

AI底座通过 HTTP 调用现有后端API，不直连数据库。

```
AI底座 (3016)
    │
    │ HTTP + x-tenant-id header
    │
    ▼
现有后端服务（Express.js单体，端口8080）
```

### 9.2 每个业务域需要的API清单

> 以下「AI需要的API」为相对各业务域「API前缀」的子路径；`BACKEND_API_BASE` 默认 `http://localhost:8080`。

| 业务域 | API前缀 | AI需要的API | 方法 |
|--------|---------|-------------|------|
| **客户** | `/api/admin/customers` | 搜索客户 `?keyword=` | GET |
| | | 客户详情 `/:id` | GET |
| | | 创建客户（根路径，POST body） | POST |
| **商品** | `/api/admin/products` | 搜索商品 `?keyword=` | GET |
| | | 商品详情 `/:id` | GET |
| | | 更新价格 `/:id`（body含价格字段） | PUT |
| **销售单** | `/api/admin/sale-bills` | 创建销售单（根路径，POST body） | POST |
| | | 查询订单 `?keyword=&status=` | GET |
| | | 订单详情 `/:billNo` | GET |
| | | 取消订单 `/:billNo/status`（body: {action:"cancel"}） | PUT |
| **库存** | `/api/admin/inventory` | 查询库存 `/balance?keyword=` | GET |
| | | 库存检查 `/check/:productId?quantity=` | GET |
| | | 库存调拨 `/transfer` | POST |
| | | 盘点记录 `/stocktaking` | POST |
| **采购** | `/api/admin/purchase-orders` | 创建采购单（根路径，POST body） | POST |
| | | 查询采购单 `?keyword=&status=` | GET |
| **配送** | `/api/admin/delivery` | 配送状态 `/:billNo/status` | GET |
| | | 创建配送（根路径，POST body） | POST |
| **财务** | `/api/admin/finance` | 应收账款 `/receivables?keyword=` | GET |
| | | 应付账款 `/payables?keyword=` | GET |
| **报表** | `/api/admin/reports` | 销售报表 `/sales?start=&end=` | GET |
| | | 库存报表 `/inventory?warehouseId=` | GET |
| | | 利润报表 `/profit?start=&end=` | GET |
| **系统** | `/api/admin/system` | 系统状态 `/status` | GET |
| **审计** | `/api/admin/audit-logs` | AI审计日志（根路径，POST body） | POST |

> **注意**: 以上API路径需与现有后端服务的实际路由匹配。如果现有后端服务使用不同路径规范，需要调整 ServiceClient 的调用路径。

### 9.3 对接验证方法

```bash
# 逐个验证后端API前缀可达性
BASE_URL="${BACKEND_API_BASE:-http://localhost:8080}"
for path in \
  /api/admin/customers \
  /api/admin/products \
  /api/admin/sale-bills \
  /api/admin/inventory/balance \
  /api/admin/purchase-orders \
  /api/admin/delivery \
  /api/admin/finance/receivables \
  /api/admin/reports/sales \
  /api/admin/system/status \
  /api/admin/audit-logs; do
  echo "Testing $path..."
  curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$path" || echo "FAIL"
done
```

对于每个业务域API，确认：
1. **可达性**: HTTP状态码200或401（需认证）
2. **认证方式**: 是否需要JWT Token
3. **租户隔离**: 是否通过 `x-tenant-id` header过滤数据
4. **API路径**: 实际的路由前缀和参数格式

---

## 十、前端组件开发指南

### 10.1 AI对话窗口组件设计

```
┌──────────────────────────────────┐
│  🤖 智享AI助手              [_][×]│
├──────────────────────────────────┤
│                                  │
│  👤 你好，我是智享AI助手         │
│     可以帮你完成销售、库存等操作  │
│                                  │
│  ──────────────────────────────  │
│                        👤 10:30  │
│  红星商行20件五粮液980           │
│                                  │
│  ┌──────────────────────────┐    │
│  │ 🤖 ✅ 销售单已创建         │    │
│  │                          │    │
│  │ 单号        金额    状态   │    │
│  │ SO0730001  ¥19,600  已确认│    │
│  │                          │    │
│  │ [查看详情] [分享]         │    │
│  └──────────────────────────┘    │
│                                  │
│  💡 试试: 创建销售单 / 查库存     │
├──────────────────────────────────┤
│ [________________________] [发送] │
└──────────────────────────────────┘
```

### 10.2 组件接口规范

```typescript
// AI对话窗口Props
interface AIChatWidgetProps {
  /** API基础地址 */
  baseUrl: string;           // 'https://your-domain.com/api/admin/ai'
  /** JWT Token（从现有登录系统获取） */
  token: string;
  /** 租户ID */
  tenantId?: string;         // 可选，从Token中解析
  /** 会话ID（可选，自动生成） */
  sessionId?: string;
  /** 窗口位置 */
  position?: 'bottom-right' | 'bottom-left' | 'fullscreen';
  /** 是否默认展开 */
  defaultOpen?: boolean;
  /** 自定义标题 */
  title?: string;
  /** 主题色 */
  theme?: 'light' | 'dark';
}
```

### 10.3 SSE流式输出处理

```typescript
// 前端 SSE 对话核心逻辑
class AISSEClient {
  private sessionId: string;

  async sendMessage(text: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
        'x-tenant-id': this.tenantId,
      },
      body: JSON.stringify({
        message: text,
        sessionId: this.sessionId,
      }),
    });

    // SSE流式读取
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6);
        
        try {
          const event = JSON.parse(jsonStr);
          this.handleEvent(event);
        } catch {
          // 跳过解析失败
        }
      }
    }
  }

  private handleEvent(event: SSEEvent): void {
    switch (event.type) {
      case 'text':
        // 逐步追加文本到当前消息
        this.appendText(event.content);
        break;
      case 'tool_start':
        // 显示"正在执行xxx"提示
        this.showToolProgress(event.tool);
        break;
      case 'tool_result':
        // 显示工具执行结果
        this.showToolResult(event.tool, event.success);
        break;
      case 'done':
        // 消息完成
        this.finalizeMessage();
        break;
      case 'error':
        // 错误提示
        this.showError(event.message);
        break;
    }
  }
}

// SSE事件类型
interface SSEEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'done' | 'error';
  content?: string;       // text类型：文本片段
  tool?: string;          // tool_start/tool_result：工具名称
  args?: any;             // tool_start：工具参数
  success?: boolean;      // tool_result：执行结果
  error?: string;         // tool_result：错误信息
  message?: string;       // error类型：错误消息
  latencyMs?: number;     // done类型：总延迟
  tokens?: object;        // done类型：Token消耗
}
```

### 10.4 消息渲染规范

| 内容类型 | 渲染方式 | 示例 |
|----------|----------|------|
| 纯文本 | Markdown渲染 | "✅ 销售单已创建" |
| 表格数据 | 表格组件 | 单号/金额/状态 |
| 工具进度 | 灰色小字 + Spinner | "⏳ 正在查询客户..." |
| 工具结果 | 成功✅ / 失败❌ | "✅ 客户查询成功" |
| 错误 | 红色警告框 | "❌ DeepSeek API连接失败" |
| 确认请求 | 高亮确认卡片 | "确认创建以下销售单？" |

### 10.5 前端适配

- Web端：悬浮窗 → 点击展开对话窗口（position: bottom-right）
- 移动端（App/H5）：底部导航新增"AI助手"Tab → 全屏对话页面，支持语音输入
- **小程序不接入AI**
- 总台管理端：独立"AI配置"页面 + "AI用量统计"页面

---

## 十一、数据库迁移指南

### 11.1 迁移步骤

```
1. 备份现有数据库
   mysqldump -u root -p zhixiang > zhixiang_backup_$(date +%Y%m%d).sql

2. 执行迁移脚本
   mysql -u root -p zhixiang < docs/migrations/121_ai_base_tables.sql

3. 验证
   mysql -u root -p zhixiang -e "SHOW TABLES LIKE 't_%ai%';"
   预期输出: t_platform_ai_config, t_tenant_ai_config, t_ai_audit_log, t_ai_usage_daily, t_tenant_ai_billing
   （RAG 启用后另含 t_ai_knowledge_chunks，见 122_ai_rag.sql）

4. 初始化全局配置
   # 121_ai_base_tables.sql 中已包含 INSERT 语句
   # 验证:
   mysql -u root -p zhixiang -e "SELECT * FROM t_platform_ai_config;"
```

### 11.2 回滚方案

```sql
-- 回滚脚本（慎用！会删除所有AI相关数据和表）
-- docs/migrations/121_ai_base_tables_rollback.sql

DROP TABLE IF EXISTS t_ai_audit_log;
DROP TABLE IF EXISTS t_tenant_ai_config;
DROP TABLE IF EXISTS t_platform_ai_config;
```

```bash
# 回滚执行
mysql -u root -p zhixiang < docs/migrations/121_ai_base_tables_rollback.sql
```

> **注意**: 回滚会丢失所有AI审计日志和租户AI配置。建议仅在开发环境使用。

### 11.3 数据初始化脚本

```sql
-- 初始化全局默认配置
INSERT INTO t_platform_ai_config (default_provider, default_model, default_api_key, default_temperature, default_max_tokens)
VALUES ('deepseek', 'deepseek-chat', '', 0.3, 2048);

-- 为测试租户初始化AI配置（开发环境用）
INSERT INTO t_tenant_ai_config (tenant_id, enabled, provider, model)
VALUES ('test_tenant', 1, 'deepseek', 'deepseek-chat');
```

---

## 十二、编码规范

### 12.1 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件 | kebab-case | `order.handler.ts` |
| 类 | PascalCase | `OrderToolHandler` |
| 方法 | camelCase | `createSalesOrder()` |
| 变量 | camelCase | `tenantConfig` |
| 常量 | UPPER_SNAKE | `MAX_ITERATIONS` |
| 接口 | I前缀 PascalCase | `IModelProvider` |
| 类型 | PascalCase | `ToolDefinition` |
| 枚举 | PascalCase | `OrderStatus` |

### 12.2 目录规范

每个模块：`xxx.module.ts` + `xxx.service.ts` + `xxx.interface.ts` + 测试

### 12.3 错误处理

```typescript
// ✅ 推荐
return { success: false, error: '库存不足：需要20件，当前5件' };

// ❌ 避免
throw new Error('something wrong');
```

### 12.4 日志规范

```typescript
// ✅ 推荐：结构化
this.logger.log({ event: 'tool_executed', tool: 'createSalesOrder', tenantId, duration });

// ❌ 避免：无结构
console.log('order created');
```

### 12.5 与项目统一标准的关系

> AI底座作为独立项目使用 NestJS 框架，但必须遵循 `docs/项目统一标准.md` 中的以下规范：
> - 数据库表名必须带 `t_` 前缀
> - tenant_id 字段统一 VARCHAR(36)
> - 主键统一 BIGINT UNSIGNED AUTO_INCREMENT
> - 字段必须有中文 COMMENT
> - API路径使用系统标准前缀（/api/admin/、/api/platform/ 等）
> - 返回体使用统一格式（code/msg/data/traceId/apiCost）
> - 迁移脚本放在 docs/migrations/ 目录，命名 NNN_描述.sql

### 12.6 统一返回体格式

所有 HTTP 接口返回体必须采用项目统一格式（与现有后端服务一致）：

```json
{
  "code": "0",
  "msg": "成功",
  "data": { },
  "traceId": "uuid-v4",
  "apiCost": 1
}
```

字段说明：

| 字段 | 类型 | 说明 |
|------|------|------|
| code | string | `"0"` 表示成功，其余为错误码（如 `"400"`、`"500"`） |
| msg | string | 提示信息，成功为「成功」 |
| data | object/null | 业务数据 |
| traceId | string | 链路追踪ID（uuid v4） |
| apiCost | number | 接口耗时（毫秒），AI接口可表示Token成本 |

> SSE 流式接口（`/api/chat`）不适用此格式，按 SSE 事件流输出。

---

## 十三、测试方案

### 13.1 测试策略

| 层级 | 方法 | 工具 |
|------|------|------|
| 单元测试 | Jest | `pnpm run test` |
| 集成测试 | Supertest | `pnpm run test:e2e` |
| 手工测试 | curl + SSE客户端 | 见调试指南 |

### 13.2 关键测试场景

| 场景 | 测试方法 | 验收 |
|------|----------|------|
| DeepSeek对话 | Mock API响应 | 返回正确ChatResponse |
| Tool注册 | 检查Registry大小 | 24个工具 |
| "创建销售单" | 端到端对话 | 单号返回 |
| 多租户隔离 | 不同tenantId调用 | 数据不交叉 |
| SSE流式 | 前端组件接收 | 逐字渲染 |

### 13.3 覆盖率目标

| 模块 | 目标 |
|------|------|
| providers/ | > 90% |
| tools/ | > 85% |
| brain/ | > 80% |
| bridge/ | > 75% |
| gateway/ | > 70% |

---

## 十四、调试指南

### 14.1 本地调试

```bash
pnpm run start:debug
# VS Code: Attach to NestJS (port 9229)
```

### 14.2 日志级别

```bash
LOG_LEVEL=debug    # 开发：显示所有Tool调用
LOG_LEVEL=info     # 生产：只显示关键事件
```

### 14.3 常用调试命令

```bash
# 测试默认 Provider（GLM）连通性
curl localhost:3016/api/admin/test-connection

# 列出已注册 Provider / 非流式对话测试
curl localhost:3016/api/admin/providers
curl -X POST localhost:3016/api/admin/chat-test -H "Content-Type: application/json" -d '{"message":"你好"}'

# 查看已注册工具
curl localhost:3016/api/admin/tools

# 健康检查（AI底座 + 后端 + 数据库 + Redis）
curl localhost:3016/api/admin/health
# 基础健康检查
curl localhost:3016/api/health

# 对话记忆：暂无独立清除接口；Redis 键 ai:memory:{tenantId}:{sessionId} 默认 TTL 1 小时自动过期，
# 新建对话通过传入新的 conversationId 自动开启新会话。
```

---

## 十五、部署指南

### 15.1 Dockerfile

已包含在项目中：多阶段构建（builder + production），暴露3016端口，内置健康检查。

### 15.2 docker-compose集成

```yaml
services:
  ai-base:
    build: ./zhixiang-ai-base
    ports: ["3016:3016"]
    environment:
      - NODE_ENV=production
      - DEEPSEEK_API_KEY=${DEEPSEEK_API_KEY}
      - ENCRYPTION_KEY=${ENCRYPTION_KEY}
      - BACKEND_API_BASE=http://backend:8080
    depends_on: [mysql, redis]
    restart: unless-stopped
```

### 15.3 Nginx配置

```nginx
# AI底座路由：/ai-api/* 转发至AI底座(3016)，保留 /api 前缀
# 实际路径示例：/ai-api/api/chat、/ai-api/api/admin/tools、/ai-api/api/rag/search
location /ai-api/ {
    proxy_pass http://127.0.0.1:3016/;
    proxy_buffering off;              # SSE必须关闭buffering
    proxy_cache off;
    proxy_read_timeout 300s;          # SSE长连接
    proxy_send_timeout 300s;
}
# 生产完整配置见 deploy/nginx-production.conf（admin.onepan.cn / m.onepan.cn / saas.onepan.cn 三个 server 块均含该 location）
```

### 15.4 数据库迁移

```bash
mysql -u root -p zhixiang < docs/migrations/121_ai_base_tables.sql
```

---

## 十六、CI/CD 配置

### 16.1 手动部署（推荐当前使用）

```bash
# 1. 拉取代码
git pull origin main

# 2. 安装依赖 + 编译
cd zhixiang-ai-base
pnpm install --frozen-lockfile
pnpm run build

# 3. 停止旧服务
pm2 stop zhixiang-ai-base || true

# 4. 启动新服务
pm2 start dist/main.js --name zhixiang-ai-base

# 5. 验证
curl localhost:3016/api/admin/health
```

### 16.2 Docker部署

```bash
# 构建
docker build -t zhixiang-ai-base:latest .

# 运行
docker run -d \
  --name zhixiang-ai-base \
  -p 3016:3016 \
  --env-file .env \
  --network zhixiang-net \
  zhixiang-ai-base:latest

# 验证
docker logs zhixiang-ai-base
curl localhost:3016/api/admin/health
```

### 16.3 GitHub Actions（可选，后期启用）

```yaml
# .github/workflows/deploy.yml
name: Deploy AI Base

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
        with: { version: 8 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: pnpm run test
      # 部署到服务器
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.SERVER_HOST }}
          username: root
          key: ${{ secrets.SERVER_SSH_KEY }}
          script: |
            cd /opt/zhixiang-ai-base
            git pull
            pnpm install --frozen-lockfile
            pnpm run build
            pm2 restart zhixiang-ai-base
```

### 16.4 环境变量管理

| 环境 | 方式 | 说明 |
|------|------|------|
| 开发 | `.env`文件 | 本地调试 |
| 测试 | `.env.test`文件 | CI环境 |
| 生产 | Docker `--env-file` 或系统环境变量 | 服务器部署 |

> **DEEPSEEK_API_KEY 和 ENCRYPTION_KEY 绝不能提交到Git。** 使用 `.env` + `.gitignore` 保护。

---

## 十七、常见问题

### Q1: Provider调用超时？

检查API Key有效性、网络可达性。ServiceClient默认10秒超时，可配置。

### Q2: Tool执行失败？

ToolExecutor统一返回 `{success: false, error: ...}`，LLM会理解并重试或建议用户。

### Q3: 如何新增AI服务商？

1. 创建 `xxx.provider.ts` 实现 IModelProvider
2. 在 ProviderModule + ProviderFactory 注册
3. t_tenant_ai_config 表的 provider 字段新增选项

### Q4: 对话记忆何时清除？

- 用户说"清除对话"或"新对话"
- 会话超过1小时（Redis TTL）
- 用户登出时

### Q5: 如何限制AI操作权限？

ToolExecutor中添加权限校验，根据 context.role 判断是否允许执行写操作。

### Q6: SSE连接断开？

Nginx需设置 `proxy_buffering off` 和 `proxy_read_timeout 300s`。检查是否被中间代理中断。

### Q7: 后端API路径与AI底座不匹配？

调整 ServiceClient 的调用路径，或修改 ToolHandler 中的 URL 映射。建议在现有后端服务中新增AI专用API端点。

---

> **文档版本**: v2.1 | **最后更新**: 2026-07-31
