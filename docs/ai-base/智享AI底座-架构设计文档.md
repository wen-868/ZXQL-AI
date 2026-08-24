# 智享全链 AI 底座 — 架构设计文档

> 版本：v3.2 | 日期：2026-07-31 | 作者：智享全链架构组

---

## 目录

1. [总体定位](#一总体定位)
2. [功能全景图](#二功能全景图)
3. [部署拓扑](#三部署拓扑)
4. [AI底座内部架构](#四ai底座内部架构)
5. [Model Provider 抽象层](#五model-provider-抽象层)
6. [AI 配置中心](#六ai-配置中心)
7. [数据库设计](#七数据库设计)
8. [与现有后端服务的关系](#八与现有后端服务的关系)
9. [核心数据流](#九核心数据流)
10. [多租户隔离方案](#十多租户隔离方案)
11. [API 接口文档](#十一api-接口文档)
12. [前后端通信协议](#十二前后端通信协议)
13. [三端对接方案](#十三三端对接方案)
14. [第三方 AI 办公软件对接](#十四第三方-ai-办公软件对接)
15. [安全设计](#十五安全设计)
16. [监控运维](#十六监控运维)
17. [降级与容灾](#十七降级与容灾)
18. [项目目录结构](#十八项目目录结构)
19. [前端改造方案](#十九前端改造方案)
20. [关键决策记录](#二十关键决策记录)
21. [实施路线图](#二十一实施路线图)

---

## 一、总体定位

### 1.1 核心理念

> **AI底座不替换现有系统，而是在现有后端服务（Express.js单体）之上加一层AI驱动层。现有后端服务一个不改，AI层通过内部HTTP API调用它们。**

### 1.2 分层架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        用户交互层                                 │
│  ┌──────────────────────┐          ┌───────────────────────────┐ │
│  │  现有 Web / 移动端    │          │  AI 对话窗口（新增）       │ │
│  │  菜单 → 表单 → 列表   │          │  自然语言 → AI → 自动执行   │ │
│  │  （小程序除外，不接AI）│          │                            │ │
│  └──────────┬───────────┘          └─────────────┬─────────────┘ │
└─────────────┼──────────────────────────────────────┼──────────────┘
              │                                      │
┌─────────────▼──────────────────────────────────────▼──────────────┐
│                      网关层 (Nginx)                                │
│   /api/admin/*   → 现有后端服务（工作台）                       │
│   /api/store/*   → 现有后端服务（门店端）                         │
│   /api/platform/* → 现有后端服务（平台总后台）                    │
│   /api/admin/ai/*  → AI底座对话接口                                │
│   /api/platform/ai/* → AI配置管理API                               │
└────────────────────────────┬──────────────────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────────────────┐
│                    AI 底座 (zhixiang-ai-base 共享实例)            │
│                                                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐    │
│  │ AI Gateway   │  │ Brain Engine │  │ Model Provider 层    │    │
│  │ SSE流式/WS   │  │ 意图→规划→执行│  │ DeepSeek/通义/Ollama │    │
│  └──────────────┘  └──────────────┘  └──────────────────────┘    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │              Tool Runtime + Service Bridge                   │ │
│  │   每个业务操作封装为Tool → 通过HTTP调用现有后端API             │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬──────────────────────────────────────┘
                             │ HTTP (localhost 内部调用)
┌────────────────────────────▼──────────────────────────────────────┐
│              现有智享后端服务层（Express.js单体，不改动）          │
│                                                                    │
│  auth → /api/admin/auth    │  user → /api/admin/users              │
│  product → /api/admin/products │  order → /api/admin/sale-bills    │
│  inventory → /api/admin/inventory │  purchase → /api/admin/purchases│
│  delivery → /api/admin/deliveries │  finance → /api/admin/finance   │
│  report → /api/admin/reports │  customer → /api/admin/customers    │
│  marketing → /api/admin/marketing │  settings → /api/admin/settings │
│  notification → /api/admin/notifications │  log → /api/admin/logs   │
└────────────────────────────┬──────────────────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────────────────┐
│            基础设施层（共享，不改动）                               │
│  MySQL (60+表)  │  Redis  │  RabbitMQ  │  ES  │  MinIO            │
└──────────────────────────────────────────────────────────────────┘
```

### 1.3 关键原则

| 原则 | 说明 |
|------|------|
| **零侵入** | 现有后端服务不改一行代码 |
| **可降级** | AI底座挂了，现有Web/移动端照常使用 |
| **渐进式** | 先云AI后本地，Provider层支持热切换 |
| **多租户** | 每个租户独立选择AI服务商和模型 |

---

## 二、功能全景图

### 2.1 销售管理（order）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 创建销售单 | "红星商行20件五粮液980" | 查客户→查商品→校验库存→确认→建单 | ✅ SO20260730001 已创建 | P0 |
| 查询销售单列表 | "查红星商行最近5笔订单" | 按客户名模糊搜索 | 表格：单号/日期/金额/状态 | P0 |
| 查询销售单详情 | "SO20260730001的详情" | 按单号查详情 | 完整单据信息+明细 | P0 |
| 取消销售单 | "取消SO20260730001，客户要求取消" | 校验状态→取消→回增库存 | ✅ 已取消 | P0 |
| 销售退货 | "退SO20260730001里3件五粮液" | 校验退货条件→退货→回增库存 | ✅ 退货单已创建 | P1 |

### 2.2 库存管理（inventory）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 查询库存 | "查五粮液的库存" | 按商品名查库存 | 商品/仓库/可用量/锁定量 | P0 |
| 多仓库存查询 | "1号仓所有库存" | 按仓库查全部库存 | 表格列表 | P1 |
| 库存调拨 | "从1号仓调50件五粮液到2号仓" | 校验→锁定→调拨→释放 | ✅ 调拨完成 | P1 |
| 库存盘点 | "1号仓盘点，五粮液实际25件" | 记录差异→生成盘盈/盘亏单 | ✅ 盘点完成，差异: +5件 | P2 |
| 低库存预警 | "哪些商品库存不足" | 查低库存商品 | 表格：商品/当前/阈值 | P1 |

### 2.3 商品管理（product）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 查询商品 | "五粮液的价格和规格" | 模糊搜索商品 | 商品详情卡片 | P0 |
| 更新价格 | "五粮液价格改为998" | 校验权限→更新 | ✅ 价格已更新 | P1 |
| 新增商品 | "新增商品：剑南春52度500ml，进价400售价598" | 创建商品记录 | ✅ 商品已创建 | P2 |

### 2.4 客户管理（customer）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 查询客户 | "查红星商行的信息" | 模糊搜索客户 | 客户详情卡片 | P0 |
| 创建客户 | "新增客户：光明超市，张经理，13800138000" | 创建客户记录 | ✅ 客户已创建 | P1 |
| 客户欠款查询 | "红星商行还欠多少钱" | 查应收账款 | 欠款明细表 | P1 |

### 2.5 采购管理（purchase）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 创建采购单 | "从XX供应商采购五粮液100件单价850" | 查供应商→创建采购单 | ✅ PO20260730001 已创建 | P1 |
| 查询采购单 | "最近的采购单" | 查采购单列表 | 表格列表 | P1 |
| 采购入库 | "PO20260730001到货了，入库" | 校验→入库→增加库存 | ✅ 入库完成 | P1 |

### 2.6 配送管理（delivery）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 查询配送状态 | "SO20260730001送到了吗" | 查配送状态 | 配送进度条 | P1 |
| 创建配送 | "给SO20260730001叫个美团配送" | 创建配送任务 | ✅ 配送单已创建 | P1 |
| 配送费用估算 | "送一单到XX路多少钱" | 调用平台估价接口 | 费用对比表 | P2 |

### 2.7 财务管理（finance）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 查应收账款 | "有哪些客户欠款" | 查应收列表 | 表格：客户/金额/逾期天数 | P1 |
| 查应付账款 | "我们欠哪些供应商钱" | 查应付列表 | 表格：供应商/金额/到期日 | P1 |
| 收款记录 | "红星商行付了10000元" | 记录收款→冲抵应收 | ✅ 收款已记录 | P2 |
| 对账 | "红星商行7月对账" | 汇总应收已收 | 对账单 | P2 |

### 2.8 报表分析（report）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 销售报表 | "本月销售汇总" | 按月汇总 | 图表+表格 | P1 |
| 库存报表 | "当前库存报表" | 全仓汇总 | 表格+预警标识 | P1 |
| 利润分析 | "7月利润分析" | 计算毛利 | 图表+明细 | P2 |
| 经营概览 | "今天经营情况怎么样" | 汇总今日关键指标 | 仪表盘卡片 | P1 |

### 2.9 系统管理（system）

| 功能 | 用户输入示例 | AI执行 | 输出示例 | 优先级 |
|------|-------------|--------|----------|--------|
| 系统状态 | "系统运行正常吗" | 健康检查 | 服务状态表 | P1 |
| 待办提醒 | "我有什么待处理" | 查待办事项 | 待办列表 | P2 |

### 2.10 功能优先级汇总

```
P0 (必须，Phase 1-2):
├── 创建销售单
├── 查询销售单（列表+详情）
├── 取消销售单
├── 查询库存
├── 查询商品
└── 查询客户

P1 (重要，Phase 3):
├── 销售退货
├── 库存调拨
├── 低库存预警
├── 更新商品价格
├── 创建客户
├── 创建/查询采购单
├── 采购入库
├── 查询/创建配送
├── 查应收应付
├── 销售报表/库存报表
├── 经营概览
└── 系统状态

P2 (增强，Phase 4):
├── 库存盘点
├── 新增商品
├── 客户欠款查询
├── 配送费用估算
├── 收款记录
├── 对账
├── 利润分析
└── 待办提醒
```

---

## 三、部署拓扑

### 3.1 阶段一：云AI模式（当前）

```
┌────────────────────────────────────────────────────────────┐
│              腾讯轻量服务器 4核8G（现有）                     │
│                                                            │
│  Docker Compose                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Nginx (:80/:443)                                    │  │
│  │  MySQL + Redis + RabbitMQ + ES + MinIO              │  │
│  │  现有后端服务（Express.js单体，共享实例）             │  │
│  │  zhixiang-ai-base (共享实例)  ← 新增                │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  内存占用: 业务~6G + AI底座~500MB = ~6.5G / 8G ✅          │
└────────────────────────────────────────────────────────────┘
         │
         │ HTTPS (AI推理请求)
         ▼
┌────────────────────────────────────────────────────────────┐
│              云 AI 服务商                                   │
│  DeepSeek API (deepseek-chat)          ~¥0.001/千token    │
│  通义千问 (qwen-plus)                  ~¥0.002/千token    │
│  智谱AI (glm-4-flash)                  有免费额度          │
└────────────────────────────────────────────────────────────┘
```

### 3.2 阶段二：混合模式（后期可选）

```
┌──────────────────────┐     ┌──────────────────────────────┐
│ 腾讯轻量 4核8G        │     │ 新增服务器（本地AI推理）       │
│                      │     │                              │
│ 所有业务服务          │     │ Ollama + qwen2.5:7b          │
│ AI底座 (共享实例)    │────▶│ GPU可选                      │
│                      │     │                              │
└──────────────────────┘     └──────────────────────────────┘
```

> 切换方式：改 `.env` 中 `MODEL_PROVIDER=ollama` 即可，无需改代码。

---

## 四、AI底座内部架构

```
┌──────────────────────────────────────────────────────────────────┐
│                    zhixiang-ai-base (共享实例)                    │
│                                                                  │
│  ════════════════════ Gateway Layer ═══════════════════════════  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ ChatController│  │ ChatGateway  │  │ AdminController     │   │
│  │ POST /chat   │  │ WebSocket    │  │ GET /platform/ai/cfg │   │
│  │ (SSE 流式)   │  │ 实时推送      │  │ PUT /platform/ai/cfg │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│  ════════════════════ Brain Engine ════════════════════════════  │
│  ┌──────▼─────────────────────────────────────────────────────┐  │
│  │                    Orchestrator (编排器)                    │  │
│  │                                                             │  │
│  │  用户消息 ──▶ ContextBuilder ──▶ LLM调用 ──▶ 结果处理       │  │
│  │                │                   │                        │  │
│  │         ┌──────┴──────┐    ┌───────┴────────┐              │  │
│  │         │ SystemPrompt│    │ IntentRouter   │              │  │
│  │         │ + 租户信息   │    │ EntityExtract  │              │  │
│  │         │ + 对话历史   │    │ TaskPlanner    │              │  │
│  │         │ + RAG知识   │    │ Tool调用决策    │              │  │
│  │         └─────────────┘    └────────────────┘              │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│  ═══════════════════ Model Provider ════════════════════════════  │
│  ┌──────────────────────────────┐                                │
│  │    IModelProvider (接口)     │  ← 一次定义，多个实现           │
│  │    chat() / chatStream()     │                                │
│  │    embed()                   │                                │
│  └──────────┬───────────────────┘                                │
│       ┌─────┼─────┬──────────────┐                               │
│       ▼     ▼     ▼              ▼                               │
│  DeepSeek  Qwen  Zhipu  Ollama(local)                            │
│                                                                  │
│  ═══════════════════ Tool Runtime ═════════════════════════════  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ToolRegistry           ToolExecutor                      │  │
│  │  注册所有业务工具        安全执行 + 结果校验                 │  │
│  │                                                             │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │
│  │  │ order    │ │inventory │ │ product  │ │customer  │     │  │
│  │  │ 销售订单  │ │ 库存管理  │ │ 商品管理  │ │ 客户管理  │     │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │
│  │  │ purchase │ │ delivery │ │ finance  │ │ report   │     │  │
│  │  │ 采购管理  │ │ 配送管理  │ │ 财务管理  │ │ 报表分析  │     │  │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│  ═══════════════════ Auto Learner ══════════════════════════════  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  自主学习引擎 — 系统新增功能，AI自动发现、学习、注册          │  │
│  │                                                             │  │
│  │  SwaggerScanner    DBSchemaWatcher    DocWatcher           │  │
│  │  扫描API文档        监听表结构变更      监听知识库文件        │  │
│  │       │                  │                  │               │  │
│  │       └──────────────────┼──────────────────┘               │  │
│  │                          ▼                                  │  │
│  │          ToolDefinitionGenerator → ToolRegistry             │  │
│  │          自动生成Tool定义         自动注册到工具中心          │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│  ═══════════════════ Service Bridge ════════════════════════════  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  ServiceClient    TenantInterceptor    AuditLogger         │  │
│  │  统一HTTP调用      自动注入tenantId      操作审计记录        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 五、Model Provider 抽象层

### 5.1 设计目标

> **一次编码，多Provider切换。** 无论用DeepSeek、通义千问还是本地Ollama，上层Brain Engine和Gateway代码完全不变。

### 5.2 接口定义

```typescript
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, any>;
      required?: string[];
    };
  };
}

interface ChatOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage?: { promptTokens: number; completionTokens: number };
}

interface IModelProvider {
  readonly name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<boolean>;
}
```

### 5.3 Provider 实现对照

| Provider | API地址 | 模型 | 价格(千token) | FunctionCalling | 备注 |
|----------|---------|------|--------------|-----------------|------|
| **DeepSeekProvider** | api.deepseek.com/v1 | deepseek-chat | ¥0.001 | ✅ 原生 | 首选 |
| **QwenProvider** | dashscope.aliyuncs.com | qwen-plus | ¥0.002 | ✅ 原生 | 阿里云 |
| **ZhipuProvider** | open.bigmodel.cn | glm-4-flash | 免费额度 | ✅ 原生 | 备用 |
| **OllamaProvider** | localhost:11434 | qwen2.5:3b | 免费 | ✅ | 本地部署 |

### 5.4 运行时切换流程

```
请求到达
  │
  ├─ 1. 从JWT提取 tenantId
  ├─ 2. 查 t_tenant_ai_config 表 → { provider: "deepseek", apiKey: "sk-xxx", model: "deepseek-chat" }
  ├─ 3. ProviderFactory.create("deepseek", config)
  ├─ 4. provider.chat(messages, { tools })
  └─ 5. 返回结果
```

---

## 六、AI 配置中心

### 6.1 配置层级

```
优先级: 租户级 > 全局级 > 系统默认

┌─────────────────────────────────────────────────────────┐
│ 系统默认 (.env)                                          │
│ MODEL_PROVIDER=deepseek                                 │
│ DEFAULT_MODEL=deepseek-chat                             │
├─────────────────────────────────────────────────────────┤
│ 全局配置 (t_platform_ai_config 表)                       │
│ 所有租户的默认AI设置                                     │
├─────────────────────────────────────────────────────────┤
│ 租户配置 (t_tenant_ai_config 表) ← 最高优先级            │
│ 每个租户独立选择服务商、模型、API Key                     │
└─────────────────────────────────────────────────────────┘
```

### 6.2 总台管理页面设计

```
┌──────────────────────────────────────────────────────────────┐
│  🤖 AI 配置中心                            [保存] [重置]     │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 📋 全局默认设置                                          │ │
│  │                                                         │ │
│  │ 默认AI服务商:  [DeepSeek ▼]                              │ │
│  │ 默认模型:      [deepseek-chat ▼]                        │ │
│  │ 默认API Key:   [sk-••••••••••••]  [显示/隐藏] [测试连接] │ │
│  │ 默认温度:      [═══●══════] 0.3                          │ │
│  │ 默认最大Token: [2048]                                    │ │
│  │ 默认系统提示词: [展开编辑...]                             │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 🏢 租户AI配置                                            │ │
│  │                                                         │ │
│  │ 搜索: [____________] 🔍    [+ 新增配置]                  │ │
│  │                                                         │ │
│  │ ┌────────┬──────────┬──────────┬────────┬────────────┐ │ │
│  │ │ 租户    │ 服务商    │ 模型      │ 状态    │ 操作       │ │ │
│  │ ├────────┼──────────┼──────────┼────────┼────────────┤ │ │
│  │ │ 红星商行 │ DeepSeek  │ deepseek  │ ✅ 启用 │ [编辑][禁用]│ │ │
│  │ │ 光明超市 │ 通义千问   │ qwen-plus │ ✅ 启用 │ [编辑][禁用]│ │ │
│  │ │ 顺达批发 │ 智谱AI    │ glm-4     │ ✅ 启用 │ [编辑][禁用]│ │ │
│  │ │ 本地测试 │ Ollama    │ qwen:3b   │ ✅ 启用 │ [编辑][禁用]│ │ │
│  │ │ 新商户   │ 未配置    │ -         │ ⬜ 未开通│ [配置]     │ │ │
│  │ └────────┴──────────┴──────────┴────────┴────────────┘ │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ 📊 用量概览（本月）                                       │ │
│  │                                                         │ │
│  │ Token消耗: 125,430  │  预估费用: ¥0.13                   │ │
│  │ API调用次数: 847    │  活跃租户: 4/5                     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### 6.3 租户配置编辑弹窗

```
┌─────────────────────────────────────────────┐
│  编辑AI配置 - 红星商行                  [×]  │
│                                             │
│  启用AI助手:        [✅] 开启               │
│                                             │
│  AI服务商:          [DeepSeek ▼]            │
│  API Key:           [sk-xxxxxxxxxxxx]       │
│  自定义Endpoint:    [_______________] (可选) │
│                                             │
│  模型:              [deepseek-chat ▼]       │
│  温度:              [═══●══════] 0.3        │
│  最大Token:         [2048]                  │
│                                             │
│  自定义系统提示词:                            │
│  ┌─────────────────────────────────────────┐│
│  │ (可选) 覆盖默认提示词                     ││
│  └─────────────────────────────────────────┘│
│                                             │
│  [测试连接]              [取消]  [保存]      │
└─────────────────────────────────────────────┘
```

---

## 七、数据库设计

### 7.1 新增表

```sql
-- 平台级AI全局配置
CREATE TABLE t_platform_ai_config (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  default_provider VARCHAR(32) NOT NULL DEFAULT 'deepseek' COMMENT '默认AI服务商',
  default_model    VARCHAR(64) NOT NULL DEFAULT 'deepseek-chat' COMMENT '默认模型',
  default_api_key  VARCHAR(512) COMMENT '默认API Key（加密存储）',
  default_endpoint VARCHAR(255) COMMENT '默认自定义Endpoint',
  default_temperature DECIMAL(2,1) DEFAULT 0.3 COMMENT '默认温度',
  default_max_tokens  INT DEFAULT 2048 COMMENT '默认最大Token',
  default_system_prompt TEXT COMMENT '默认系统提示词',
  updated_at       DATETIME DEFAULT NOW() ON UPDATE NOW() COMMENT '更新时间'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台级AI全局配置';

-- 租户级AI配置
CREATE TABLE t_tenant_ai_config (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  tenant_id       VARCHAR(36) NOT NULL UNIQUE COMMENT '租户ID',
  enabled         TINYINT(1) DEFAULT 1 COMMENT '是否启用AI功能',
  provider        VARCHAR(32) DEFAULT 'deepseek' COMMENT 'AI服务商',
  api_key         VARCHAR(512) COMMENT 'API Key（加密存储）',
  api_endpoint    VARCHAR(255) COMMENT '自定义Endpoint',
  model           VARCHAR(64) DEFAULT 'deepseek-chat' COMMENT '模型名称',
  temperature     DECIMAL(2,1) DEFAULT 0.3 COMMENT '温度参数',
  max_tokens      INT DEFAULT 2048 COMMENT '最大Token',
  system_prompt   TEXT COMMENT '自定义系统提示词',
  created_at      DATETIME DEFAULT NOW() COMMENT '创建时间',
  updated_at      DATETIME DEFAULT NOW() ON UPDATE NOW() COMMENT '更新时间',
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='租户级AI配置';

-- AI调用审计日志
CREATE TABLE t_ai_audit_log (
  id              BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  tenant_id       VARCHAR(36) NOT NULL COMMENT '租户ID',
  user_id         VARCHAR(36) COMMENT '用户ID',
  session_id      VARCHAR(64) COMMENT '会话ID',
  provider        VARCHAR(32) COMMENT 'AI服务商',
  model           VARCHAR(64) COMMENT '模型名称',
  intent          VARCHAR(64) COMMENT '意图',
  user_message    TEXT COMMENT '用户消息',
  tool_calls      JSON COMMENT '工具调用记录',
  prompt_tokens   INT DEFAULT 0 COMMENT '提示Token数',
  completion_tokens INT DEFAULT 0 COMMENT '完成Token数',
  latency_ms      INT COMMENT '延迟毫秒',
  success         TINYINT(1) DEFAULT 1 COMMENT '是否成功',
  error_message   TEXT COMMENT '错误信息',
  created_at      DATETIME DEFAULT NOW() COMMENT '创建时间',
  INDEX idx_tenant_time (tenant_id, created_at),
  INDEX idx_session (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI调用审计日志';

-- AI用量日统计表（按租户+日期+服务商汇总）
CREATE TABLE t_ai_usage_daily (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  tenant_id     VARCHAR(36) NOT NULL COMMENT '租户ID',
  stat_date     DATE NOT NULL COMMENT '统计日期',
  chat_count        INT DEFAULT 0 COMMENT '对话次数',
  tool_call_count   INT DEFAULT 0 COMMENT '工具调用次数',
  prompt_tokens     BIGINT DEFAULT 0 COMMENT '提示Token数',
  completion_tokens BIGINT DEFAULT 0 COMMENT '完成Token数',
  total_tokens      BIGINT DEFAULT 0 COMMENT '总Token数',
  prompt_cost       DECIMAL(12,4) DEFAULT 0.0000 COMMENT '提示费用',
  completion_cost   DECIMAL(12,4) DEFAULT 0.0000 COMMENT '完成费用',
  total_cost        DECIMAL(12,4) DEFAULT 0.0000 COMMENT '总费用',
  provider          VARCHAR(32) COMMENT 'AI服务商',
  model             VARCHAR(64) COMMENT '模型名称',
  created_at  DATETIME DEFAULT NOW() COMMENT '创建时间',
  UNIQUE KEY uk_tenant_date_provider (tenant_id, stat_date, provider),
  INDEX idx_tenant_date (tenant_id, stat_date),
  INDEX idx_date (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI用量日统计表';

-- 租户AI计费套餐配置
CREATE TABLE t_tenant_ai_billing (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  tenant_id     VARCHAR(36) NOT NULL UNIQUE COMMENT '租户ID',
  plan_type     VARCHAR(32) DEFAULT 'pay_as_you_go' COMMENT '套餐类型',
  free_chat_count     INT DEFAULT 100 COMMENT '免费对话次数',
  free_token_limit    BIGINT DEFAULT 100000 COMMENT '免费Token额度',
  overage_price       DECIMAL(10,6) DEFAULT 0.001000 COMMENT '超额单价',
  monthly_chat_limit  INT DEFAULT 0 COMMENT '月对话上限',
  monthly_token_limit BIGINT DEFAULT 0 COMMENT '月Token上限',
  monthly_price       DECIMAL(10,2) DEFAULT 0.00 COMMENT '月费',
  enabled       TINYINT(1) DEFAULT 1 COMMENT '是否启用',
  created_at    DATETIME DEFAULT NOW() COMMENT '创建时间',
  updated_at    DATETIME DEFAULT NOW() ON UPDATE NOW() COMMENT '更新时间',
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='租户AI计费套餐配置';
```

### 7.2 ER 关系

```
t_platform_ai_config (1条，全局兜底)
       │
       ▼
t_tenant_ai_config (N条，每租户1条) ──── t_tenant_ai_billing (N条，每租户1条)
       │                                      │
       ▼                                      │ 计费套餐
AI底座运行时读取 → 选择Provider → 调用LLM     │
       │                                      │
       ▼                                      ▼
t_ai_audit_log (每次AI调用1条，明细) ──汇总──▶ t_ai_usage_daily (按租户按日汇总)
```

### 7.3 新增表清单

| 表名 | 用途 | 记录数 |
|------|------|--------|
| `t_platform_ai_config` | 平台级AI默认配置 | 1条 |
| `t_tenant_ai_config` | 租户AI服务商/模型配置 | 每租户1条 |
| `t_ai_audit_log` | AI调用审计明细 | 每次调用1条 |
| `t_ai_usage_daily` | 按租户按日用量汇总 | 每租户每天1条 |
| `t_tenant_ai_billing` | 租户计费套餐配置 | 每租户1条 |

### 7.4 对现有数据库的影响

> **零影响。** 5张新表完全独立，不修改任何现有表结构。现有数据库已有60+张业务表，新增表与现有表通过 `tenant_id` 逻辑关联，不做物理外键约束。

---

## 八、与现有后端服务的关系

| 现有服务 | API前缀 | 职责 | AI底座对应Tool | 调用方式 |
|----------|---------|------|---------------|----------|
| auth | /api/admin/auth | 认证授权 | TenantContext（JWT校验） | HTTP |
| user | /api/admin/users | 用户管理 | 权限校验 | HTTP |
| product | /api/admin/products | 商品管理 | product.tool | HTTP |
| order | /api/admin/sale-bills | 订单管理 | order.tool | HTTP |
| inventory | /api/admin/inventory | 库存管理 | inventory.tool | HTTP |
| purchase | /api/admin/purchases | 采购管理 | purchase.tool | HTTP |
| delivery | /api/admin/deliveries | 配送管理 | delivery.tool | HTTP |
| finance | /api/admin/finance | 财务管理 | finance.tool | HTTP |
| report | /api/admin/reports | 报表分析 | report.tool | HTTP |
| customer | /api/admin/customers | 客户管理 | customer.tool | HTTP |
| marketing | /api/admin/marketing | 营销管理 | marketing.tool | HTTP |
| settings | /api/admin/settings | 系统设置 | system.tool | HTTP |
| notification | /api/admin/notifications | 消息通知 | system.tool | HTTP |
| log | /api/admin/logs | 日志服务 | 审计日志写入 | HTTP |
| ai-assistant | /api/admin/ai-assistant | 旧AI助手 | **（保留不动）** | - |

### 调用原则

1. AI底座只通过HTTP调用现有后端API，不直连数据库
2. 所有调用携带租户上下文（`x-tenant-id` header）
3. 读操作：直接调用，Redis缓存可选
4. 写操作：AI先向用户确认关键信息，再执行
5. 超时策略：默认10s，可配置
6. 失败重试：最多2次，间隔1s

---

## 九、核心数据流

### 9.1 创建销售单（完整流程）

```
用户输入: "红星商行20件五粮液价格980"
  │
  ├─ Step 1: Gateway 校验JWT → 提取 tenantId, userId
  ├─ Step 2: ContextBuilder 组装 System Prompt + 租户信息 + 对话历史 + RAG知识
  ├─ Step 3: LLM调用（DeepSeek）→ 返回 tool_calls:
  │     [{ name: "searchCustomer", args: { name: "红星商行" }},
  │      { name: "searchProduct",  args: { keyword: "五粮液" }}]
  ├─ Step 4: Tool Runtime 并行执行读操作
  │     searchCustomer → GET /api/admin/customers?keyword=红星商行 → { id:"c_001" }
  │     searchProduct   → GET /api/admin/products?keyword=五粮液 → { id:"p_052" }
  ├─ Step 5: LLM 二次调用 → 返回 tool_calls:
  │     [{ name: "checkInventory", args: { productId:"p_052", quantity:20 }}]
  ├─ Step 6: Tool Runtime 校验库存 → GET /api/admin/inventory/balance → { available:150 }
  ├─ Step 7: LLM 三次调用 → 生成确认信息
  │     SSE推送: "确认创建：红星商行 五粮液52度500ml × 20件 ¥980/件 合计¥19,600"
  ├─ Step 8: 用户确认 "确认"
  ├─ Step 9: Tool Runtime 创建销售单
  │     POST /api/admin/sale-bills → { orderNo:"SO20260730001", status:"confirmed" }
  └─ Step 10: SSE 返回最终结果 + 写入审计日志
```

### 9.2 简单查询流程

```
用户: "查一下红星商行最近的订单"
  │
  ├─ Gateway → 校验 → 提取tenantId
  ├─ ContextBuilder → 组装上下文
  ├─ LLM → 识别意图: querySalesOrders
  ├─ Tool: querySalesOrders({ customerName:"红星商行", pageSize:5 })
  │   → GET /api/admin/sale-bills?keyword=红星商行&pageSize=5
  │   → [{ orderNo, date, amount, status }, ...]
  ├─ LLM → 格式化结果
  └─ SSE → 表格展示
```

---

## 十、多租户隔离方案

### 10.1 隔离机制

```
请求 → 响应全链路:

1. JWT Token 解析 → { tenantId, userId, role }
2. TenantContext 注入 → AsyncLocalStorage 存储当前请求上下文
3. 所有 Tool 调用自动携带 → headers: { "x-tenant-id": "t_001" }
4. 对话记忆隔离 → Redis Key: ai:memory:{tenantId}:{sessionId}
5. 审计日志隔离 → t_ai_audit_log.tenant_id = "t_001"
6. AI配置隔离 → t_tenant_ai_config WHERE tenant_id = "t_001"
```

### 10.2 租户上下文实现

```typescript
import { AsyncLocalStorage } from 'async_hooks';

interface TenantContext {
  tenantId: string;
  tenantName: string;
  userId: string;
  userName: string;
  role: string;
  sessionId: string;
}

const tenantContextStore = new AsyncLocalStorage<TenantContext>();

function getTenantContext(): TenantContext {
  const ctx = tenantContextStore.getStore();
  if (!ctx) throw new Error('TenantContext not found');
  return ctx;
}
```

---

## 十一、API 接口文档

### 11.1 端点总览

| 方法 | 路径 | 说明 | 认证 | 返回类型 |
|------|------|------|------|----------|
| POST | `/api/admin/ai/chat` | AI对话（SSE流式） | JWT | `text/event-stream` |
| GET | `/api/platform/ai/tools` | 已注册工具列表 | 管理员 | JSON |
| GET | `/api/platform/ai/providers` | 可用Provider列表 | 管理员 | JSON |
| POST | `/api/platform/ai/test-connection` | 测试AI连接 | 管理员 | JSON |
| GET | `/api/platform/ai/config` | 获取全局AI配置 | 管理员 | JSON |
| PUT | `/api/platform/ai/config` | 更新全局AI配置 | 管理员 | JSON |
| GET | `/api/platform/ai/tenant-config/:tenantId` | 获取租户AI配置 | 管理员 | JSON |
| PUT | `/api/platform/ai/tenant-config/:tenantId` | 更新租户AI配置 | 管理员 | JSON |
| DELETE | `/api/platform/ai/memory/:tenantId/:sessionId` | 清除对话记忆 | 管理员 | JSON |
| GET | `/api/platform/ai/health` | 健康检查 | 无 | JSON |
| GET | `/api/platform/ai/usage` | 用量统计 | 管理员 | JSON |

### 11.2 对话接口

#### POST /api/admin/ai/chat

**请求头：**

```
Authorization: Bearer <jwt-token>
Content-Type: application/json
X-Session-Id: sess_xxx (可选)
```

**请求体：**

```json
{
  "message": "红星商行20件五粮液价格980",
  "sessionId": "sess_xxx"  // 可选，不传则自动生成
}
```

**响应（SSE 流式）：**

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

data: {"type":"text","content":"我来帮你"}

data: {"type":"text","content":"创建销售单，"}

data: {"type":"text","content":"先查一下客户和商品信息。"}

data: {"type":"tool_start","tool":"searchCustomer","args":{"name":"红星商行"}}

data: {"type":"tool_result","tool":"searchCustomer","success":true}

data: {"type":"tool_start","tool":"searchProduct","args":{"keyword":"五粮液"}}

data: {"type":"tool_result","tool":"searchProduct","success":true}

data: {"type":"text","content":"确认创建：\n客户：红星商行\n商品：五粮液52度500ml × 20件\n单价：¥980 合计：¥19,600\n确认吗？"}

data: {"type":"done","latencyMs":3520,"tokens":{"prompt":1234,"completion":156}}
```

### 11.3 管理接口

#### GET /api/platform/ai/tools

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "count": 24,
    "tools": [
      {
        "name": "createSalesOrder",
        "category": "order",
        "description": "创建销售单..."
      }
    ]
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

#### GET /api/platform/ai/providers

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "providers": ["deepseek", "qwen", "zhipu", "ollama"]
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

#### POST /api/platform/ai/test-connection

```json
// 请求
{
  "provider": "deepseek",
  "apiKey": "sk-xxx",
  "model": "deepseek-chat"
}

// 响应
{
  "code": "0",
  "msg": "成功",
  "data": {
    "provider": "deepseek"
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

#### GET /api/platform/ai/health

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "status": "ok",
    "uptime": 86400,
    "timestamp": "2026-07-31T12:00:00.000Z"
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

### 11.4 错误码规范

| 错误码 | HTTP状态 | 含义 | 处理建议 |
|--------|----------|------|----------|
| `401` | 401 | JWT Token无效或过期 | 重新登录获取Token |
| `403` | 403 | 租户未启用AI功能 | 联系总台开通 |
| `1004` | 429 | 请求频率超限（>60次/分钟） | 稍后重试 |
| `500` | 503 | AI服务商不可用 | 自动切换备用Provider |
| `500` | 500 | LLM调用失败 | 检查API Key/网络 |
| `500` | 500 | Tool执行失败 | 检查后端服务是否正常 |
| `400` | 400 | 消息内容为空 | 补充消息内容 |
| `500` | 503 | Redis不可用（降级模式） | 检查Redis连接 |
| `500` | 500 | Agent循环超限（>10轮） | 简化请求或检查Tool定义 |
| `403` | 403 | 无权限执行此操作 | 检查用户角色权限 |

**错误响应格式（统一标准）：**

```json
{
  "code": "500",
  "msg": "AI服务商暂时不可用",
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

> 说明：系统统一返回体格式为 `{ code, msg, data, traceId, apiCost }`，成功时 `code` 为 `"0"`，失败时为对应数字错误码字符串。错误时无 `data` 字段，`msg` 为错误描述，`traceId` 用于链路追踪，`apiCost` 为接口耗时。

---

## 十二、前后端通信协议

### 12.1 SSE 事件类型定义

| 事件类型 | 触发时机 | 数据字段 | 说明 |
|----------|----------|----------|------|
| `text` | LLM生成文本 | `content: string` | AI回复的文本片段，可增量拼接 |
| `tool_start` | Tool开始执行 | `tool: string, args: object` | 前端可显示"正在执行xxx" |
| `tool_result` | Tool执行完成 | `tool: string, success: boolean, error?: string` | 前端可显示执行结果 |
| `done` | 整个对话完成 | `latencyMs: number, tokens: {prompt, completion}` | 统计信息 |
| `error` | 发生错误 | `message: string, code?: string` | 错误信息 |

### 12.2 SSE 事件流格式

```
data: {"type":"text","content":"我来帮你"}\n\n
data: {"type":"tool_start","tool":"searchCustomer","args":{"name":"红星商行"}}\n\n
data: {"type":"tool_result","tool":"searchCustomer","success":true}\n\n
data: {"type":"text","content":"找到了红星商行"}\n\n
data: {"type":"done","latencyMs":3200,"tokens":{"prompt":500,"completion":80}}\n\n
```

> 每个事件以 `data: ` 前缀开头，以 `\n\n` 结尾。前端按行解析。

### 12.3 WebSocket 消息格式（可选，用于主动推送）

```json
// 客户端 → 服务端
{
  "type": "chat",
  "message": "查一下库存",
  "sessionId": "sess_xxx"
}

// 服务端 → 客户端
{
  "type": "text",
  "content": "正在查询库存..."
}

// 服务端 → 客户端（主动推送，如库存预警）
{
  "type": "notification",
  "event": "low_stock_alert",
  "data": {
    "productName": "五粮液",
    "currentStock": 5,
    "threshold": 10
  }
}
```

### 12.4 会话管理机制

| 机制 | 说明 |
|------|------|
| SessionId 生成 | 首次请求无sessionId时自动生成 `sess_{timestamp}_{random}` |
| SessionId 维持 | 前端保存sessionId，后续请求携带同一ID |
| 对话历史 | Redis存储最近10轮（20条消息），TTL 1小时 |
| 会话清除 | 用户主动"新对话" / DELETE /api/platform/ai/memory 接口 / TTL过期 |
| 跨设备 | 同一用户不同设备使用不同sessionId，互不干扰 |

### 12.5 Session 持久化策略

**存储选型**：Redis（主存储）+ MySQL（冷备归档），两级存储。

| 层级 | 存储 | 内容 | TTL/Lifecycle | 用途 |
|------|------|------|---------------|------|
| L1 热存储 | Redis Hash | 最近10轮对话消息 + 会话元数据 | 1小时自动过期 | 实时对话上下文 |
| L2 冷存储 | MySQL `t_ai_session_archive` | 超过L1窗口的完整对话历史 | 保留90天后归档 | 审计回溯、用户查看历史 |

**L1 → L2 迁移机制**：

```
触发条件：
  ① Redis TTL过期前5分钟（Eviction触发）
  ② 会话超过10轮，旧消息被挤出窗口
  ③ 用户主动结束会话

迁移流程：
  Redis Hash (sess_xxx)
       │
       ├─ 序列化为JSON
       │
       ▼
  INSERT INTO t_ai_session_archive
    (session_id, tenant_id, user_id, messages_json,
     message_count, started_at, ended_at)
       │
       ▼
  Redis中保留最近10轮，历史部分可按需回溯
```

**Session 数据结构**：

```typescript
// Redis Hash Key: session:{sessionId}
interface SessionData {
  sessionId: string;
  tenantId: string;
  userId: string;
  messages: ChatMessage[];     // 最近10轮
  createdAt: number;
  lastActiveAt: number;
  // 写操作草稿（未确认的预览数据）
  pendingWrite?: {
    toolName: string;
    previewData: object;
    createdAt: number;          // 3分钟内需确认
  };
}
```

**冷备归档表**：

```sql
CREATE TABLE t_ai_session_archive (
  id            BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  session_id    VARCHAR(64) NOT NULL COMMENT '会话ID',
  tenant_id     VARCHAR(36) NOT NULL COMMENT '租户ID',
  user_id       VARCHAR(36) NOT NULL COMMENT '用户ID',

  messages_json JSON COMMENT '完整对话消息',
  message_count INT COMMENT '消息数量',

  started_at    DATETIME NOT NULL COMMENT '会话开始时间',
  ended_at      DATETIME COMMENT '最后活跃时间',

  created_at    DATETIME DEFAULT NOW() COMMENT '创建时间',

  INDEX idx_tenant_user (tenant_id, user_id),
  INDEX idx_session (session_id),
  INDEX idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI会话归档表';
```

**会话恢复场景**：

| 场景 | 处理方式 |
|------|----------|
| 用户1小时内返回 | Redis TTL未过期，直接续接对话 |
| 用户1小时后返回 | Redis已过期，启动新会话；旧会话已归档可查看 |
| 用户查看历史 | 从 `t_ai_session_archive` 查询，按时间倒序展示 |
| Redis宕机 | L1丢失，降级为无记忆模式；恢复后从L2重建最近会话（如存在） |
| 审计需求 | 从L2按tenant_id+时间范围检索 |

---

## 十三、三端对接方案

> **对接范围**：Web端（PC）、移动端（App/H5）均接入AI。**小程序不接入AI。**

### 13.1 Web端对接

#### 13.1.1 对话窗口组件规范

```
组件名：AIChatWidget
位置：页面右下角悬浮按钮 → 点击展开
尺寸：宽度400px，高度600px（可拖拽调整）
最小尺寸：300×400
```

#### 13.1.2 SSE 接入代码（Web前端）

```typescript
class AIChatWidget {
  private sessionId: string | null = null;
  private token: string;

  async sendMessage(text: string): Promise<void> {
    const response = await fetch('/api/admin/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        message: text,
        sessionId: this.sessionId || undefined,
      }),
    });

    // 保存 sessionId
    if (!this.sessionId) {
      this.sessionId = response.headers.get('x-session-id') || null;
    }

    // SSE 流式读取
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = JSON.parse(line.slice(6));
        this.handleSSEEvent(data);
      }
    }
  }

  private handleSSEEvent(data: any): void {
    switch (data.type) {
      case 'text':
        this.appendAssistantText(data.content);
        break;
      case 'tool_start':
        this.showToolExecuting(data.tool, data.args);
        break;
      case 'tool_result':
        this.showToolResult(data.tool, data.success);
        break;
      case 'done':
        this.finishMessage(data.latencyMs);
        break;
      case 'error':
        this.showError(data.message);
        break;
    }
  }
}
```

#### 13.1.3 Nginx 配置

```nginx
location /api/admin/ai/ {
    proxy_pass http://127.0.0.1:3016/api/admin/ai/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    
    # SSE 关键配置
    proxy_buffering off;           # 关闭缓冲，实时推送
    proxy_read_timeout 300s;       # 长连接超时5分钟
    chunked_transfer_encoding on;  # 支持分块传输
}

location /api/platform/ai/ {
    proxy_pass http://127.0.0.1:3016/api/platform/ai/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_read_timeout 60s;
}
```

### 13.2 移动端对接（App/H5）

> **小程序不接入AI。** 移动端通过 App 内嵌 WebView 或 H5 页面接入，复用 Web 端的 SSE 流式对话。

#### 13.2.1 接入方式

| 终端 | 接入方式 | 说明 |
|------|----------|------|
| **移动端 App** | WebView 内嵌 H5 对话页 | 复用 Web 端对话组件，SSE 流式 |
| **移动端 H5** | 直接访问对话页面 | 同 Web 端，响应式适配 |
| **小程序** | ❌ 不接入 | - |

#### 13.2.2 移动端适配要点

```
移动端对话窗口设计：

┌──────────────────────┐
│  🤖 智享AI助手        │  ← 顶部标题栏
├──────────────────────┤
│                      │
│  对话消息区域          │  ← 全屏展示，最大化利用移动屏幕
│  （滚动）             │
│                      │
│                      │
├──────────────────────┤
│ [语音输入🎤] [_____]  │  ← 底部输入栏 + 语音按钮
│                  [发送]│
└──────────────────────┘

关键适配：
- 全屏对话模式（非悬浮窗），作为独立页面
- 底部导航新增"AI助手"Tab入口
- 支持语音输入（调用系统语音识别API）
- 输入框自动聚焦，键盘弹起时对话区域自动上移
- 网络切换时自动重连SSE
```

#### 13.2.3 移动端 SSE 接入代码

```typescript
// 移动端 H5 / App WebView
class MobileAIChat {
  private sessionId: string | null = null;
  private abortController: AbortController | null = null;

  async sendMessage(text: string) {
    this.abortController = new AbortController();

    const response = await fetch('/api/admin/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        message: text,
        sessionId: this.sessionId,
      }),
      signal: this.abortController.signal,
    });

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
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.slice(6));
          this.handleSSEEvent(data);
        }
      }
    }
  }

  // 网络恢复自动重连
  setupNetworkListener() {
    window.addEventListener('online', () => {
      this.reconnect();
    });
  }

  // 语音输入
  startVoiceInput() {
    const recognition = new (window as any).webkitSpeechRecognition();
    recognition.lang = 'zh-CN';
    recognition.onresult = (event: any) => {
      const text = event.results[0][0].transcript;
      this.sendMessage(text);
    };
    recognition.start();
  }
}
```

### 13.3 总台管理端对接

#### 13.3.1 AI配置管理API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/platform/ai/config` | GET | 获取全局AI配置 |
| `/api/platform/ai/config` | PUT | 更新全局AI配置 |
| `/api/platform/ai/tenant-config/:tenantId` | GET | 获取租户AI配置 |
| `/api/platform/ai/tenant-config/:tenantId` | PUT | 更新租户AI配置 |
| `/api/platform/ai/test-connection` | POST | 测试AI连接 |
| `/api/platform/ai/usage` | GET | 用量统计 |
| `/api/platform/ai/tools` | GET | 已注册工具列表 |

#### 13.3.2 配置更新示例

```bash
# 更新租户AI配置
curl -X PUT http://localhost:3016/api/platform/ai/tenant-config/t_001 \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "provider": "deepseek",
    "apiKey": "sk-new-key-here",
    "model": "deepseek-chat",
    "temperature": 0.3,
    "maxTokens": 2048
  }'

# 响应
{
  "code": "0",
  "msg": "成功",
  "data": {
    "tenantId": "t_001",
    "message": "租户AI配置已更新"
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

---

## 十四、第三方 AI 办公软件对接（MCP 接口）

> **定位**：智享AI底座通过标准 MCP（Model Context Protocol）接口对外暴露能力，第三方AI办公软件（如 第三方AI办公软件）直接通过 MCP 调用智享系统的业务工具，无需开发定制对接。

### 14.1 对接架构

```
┌─────────────────────────────────────────────────────┐
│              智享AI底座 (共享实例)                    │
│                                                     │
│  ┌──────────────┐         ┌──────────────────────┐  │
│  │ 自有前端      │         │ MCP Server           │  │
│  │ Web/移动端    │         │ /api/platform/ai/mcp │  │
│  │ SSE /chat     │         │                      │  │
│  └──────────────┘         │ 暴露所有Tool为        │  │
│                           │ MCP Resources/Tools   │  │
│                           └──────────┬───────────┘  │
│                                      │              │
│                           ┌──────────▼───────────┐  │
│                           │ ToolRegistry (共用)   │  │
│                           │ order/inventory/...  │  │
│                           └──────────────────────┘  │
└─────────────────────────────────────────────────────┘
                    ▲ MCP 协议
                    │
          ┌─────────┼─────────┐
          │         │         │
   ┌──────┴──┐ ┌───┴────┐ ┌──┴──────┐
   │第三方AI办公软件│ │ 其他AI │ │ 自建AI  │
   │         │ │ 客户端  │ │ 工具    │
   └─────────┘ └────────┘ └─────────┘

  任意支持MCP的AI客户端均可接入，零定制开发
```

### 14.2 MCP 接口设计

智享AI底座作为 **MCP Server**，将所有业务 Tool 暴露为标准 MCP 工具：

```
MCP Endpoint: /api/platform/ai/mcp
协议: MCP over HTTP (SSE)

暴露的 MCP Tools = ToolRegistry 中注册的所有工具

例如:
  - createSalesOrder    创建销售单
  - queryInventory      查询库存
  - searchCustomer      搜索客户
  - createPurchaseOrder 创建采购单
  - queryReceivables    查询应收
  ...（共24个工具，随系统功能扩展自动增加）
```

### 14.3 认证与租户映射

```
第三方AI客户端 → MCP请求
  │
  ├─ 1. 携带 MCP Token（在总台预先配置）
  │     → 验证Token合法性
  │
  ├─ 2. Token绑定租户
  │     → 直接注入 tenantId 到 TenantContext
  │     → 无需复杂的用户映射表
  │
  └─ 3. 调用Tool → 与自有前端完全相同的处理逻辑
```

**配置方式**：总台「AI配置中心」新增「MCP对接Token」管理，每个Token绑定一个租户，第三方客户端拿Token即可调用。

### 14.4 数据库设计

```sql
-- MCP对接Token表（简洁，一张表搞定）
CREATE TABLE t_mcp_token (
  id          BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT COMMENT '主键ID',
  tenant_id   VARCHAR(36) NOT NULL COMMENT '绑定的租户ID',
  token       VARCHAR(128) NOT NULL UNIQUE COMMENT 'MCP Token',
  name        VARCHAR(64) COMMENT '标识名称（如"第三方AI办公软件对接"）',
  enabled     TINYINT(1) DEFAULT 1 COMMENT '是否启用',
  expires_at  DATETIME COMMENT '过期时间（NULL=永不过期）',
  created_at  DATETIME DEFAULT NOW() COMMENT '创建时间',
  
  INDEX idx_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCP对接Token表';
```

### 14.5 第三方AI办公软件 对接示例

```
1. 总台配置:
   生成MCP Token → token: mcp_a1b2c3d4
   绑定租户 → tenant_id: t_001（红星商行）
   交付给第三方AI办公软件

2. 第三方AI办公软件配置MCP Server:
   URL: https://api.zhixiang.com/api/platform/ai/mcp
   Token: mcp_a1b2c3d4

3. 用户在第三方AI办公软件中说:
   "帮我查一下红星商行还欠多少钱"

4. 第三方AI办公软件通过MCP调用智享Tool:
   → MCP Tool: queryReceivables({ customerName: "红星商行" })
   → 智享底座处理（自动注入tenantId）
   → 返回: { 未收: 25400, 逾期: 0 }

5. 第三方AI办公软件展示给用户:
   💰 红星商行应收账款
   未收：¥25,400 | 逾期：¥0
```

### 14.6 安全控制

| 控制项 | 说明 |
|--------|------|
| **Token认证** | 每个MCP Token绑定一个租户，Token加密存储 |
| **Token过期** | 支持设置过期时间，可随时禁用 |
| **权限范围** | Token继承绑定租户的权限，只能操作该租户数据 |
| **操作审计** | MCP发起的调用记录到 t_ai_audit_log，标记来源为"mcp" |
| **频率限制** | MCP Token共享租户级限流（60次/分钟） |
| **写操作确认** | MCP调用写操作时返回预览信息，由第三方AI客户端负责与用户确认 |

### 14.7 MCP 优势

| 对比项 | 之前的HTTP API方案 | MCP方案 |
|--------|-------------------|---------|
| 接口数量 | 3个（chat/confirm/query） | **1个**（/api/platform/ai/mcp） |
| 数据库表 | 2张 | **1张** |
| 认证复杂度 | 平台Token+用户映射表 | **Token绑定租户** |
| 新工具上线 | 需手动告知第三方 | **自动暴露**（ToolRegistry注册即可见） |
| 第三方适配 | 每个平台定制对接 | **标准协议，零定制** |
| 自主学习联动 | 新Tool需手动同步 | **MCP自动发现新Tool** |

---

## 十五、安全设计

### 14.1 安全层级

| 层级 | 措施 | 说明 |
|------|------|------|
| **传输** | HTTPS | 所有API调用强制HTTPS，Nginx 终止 TLS |
| **认证** | JWT Token | 每次请求校验，过期自动刷新 |
| **授权** | 角色权限 | 检查用户是否有权限执行对应Tool操作 |
| **数据隔离** | tenantId注入 | 所有Tool调用自动携带，后端服务端校验 |
| **API Key** | AES-256-GCM加密 | 数据库中API Key密文存储 |
| **审计** | 全量日志 | 每次AI调用写入 t_ai_audit_log |
| **限流** | Redis滑动窗口 | 每租户每分钟最多60次AI调用 |
| **输入校验** | Zod Schema | 所有用户输入和Tool参数校验 |
| **敏感信息** | 脱敏处理 | 日志中不记录完整API Key和敏感数据 |

### 14.2 JWT Token 流转

```
用户登录
  │
  ├─ 现有后端认证服务 校验账号密码
  ├─ 生成 JWT Token:
  │    {
  │      sub: "u_123",          // userId
  │      tenantId: "t_001",     // 租户ID
  │      role: "store_manager", // 角色
  │      userName: "张三",
  │      tenantName: "红星商行",
  │      exp: 1234567890        // 过期时间
  │    }
  ├─ 返回给前端
  │
  │  后续每次请求
  ├─ 前端 Header: Authorization: Bearer <token>
  ├─ Nginx → AI底座
  ├─ TenantGuard 解析JWT → 提取 tenantId, userId
  ├─ 注入 AsyncLocalStorage
  └─ 所有后续Tool调用自动携带 x-tenant-id header
```

### 14.3 敏感数据脱敏规则

| 数据类型 | 脱敏规则 | 示例 |
|----------|----------|------|
| API Key | 只显示前4后4，中间*** | `sk-x***xxxx` |
| 手机号 | 前3后4，中间**** | `138****8000` |
| 身份证号 | 前3后4，中间**** | `310********1234` |
| 银行卡号 | 前4后4，中间**** | `6222****5678` |
| 金额 | 不脱敏（业务数据需精确） | `¥19,600` |

**日志脱敏实现：**

```typescript
function maskApiKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}***${key.slice(-4)}`;
}

function maskPhone(phone: string): string {
  return phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2');
}
```

### 14.4 SQL注入/XSS防护

| 防护点 | 措施 | 实现 |
|--------|------|------|
| **SQL注入** | TypeORM 参数化查询 | 所有数据库操作使用参数绑定，不拼接SQL |
| **XSS** | 输入输出双向过滤 | 输入：Zod校验+HTML转义；输出：前端`textContent`而非`innerHTML` |
| **Prompt注入** | System Prompt隔离 | 用户输入仅作为`user`角色消息，不混入`system` |
| **Tool参数** | Zod Schema校验 | 所有Tool参数必须通过Schema校验后才执行 |

### 14.5 API Key 加密存储

```typescript
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // 32字节

function encryptApiKey(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptApiKey(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}
```

### 14.6 限流策略

```typescript
// Redis 滑动窗口限流
// 每租户每分钟最多60次AI调用

async function checkRateLimit(tenantId: string): Promise<boolean> {
  const key = `ai:ratelimit:${tenantId}`;
  const now = Date.now();
  const window = 60_000;
  const maxRequests = 60;

  await redis.zremrangebyscore(key, 0, now - window);
  const count = await redis.zcard(key);

  if (count >= maxRequests) return false;

  await redis.zadd(key, now, `${now}-${Math.random()}`);
  await redis.expire(key, 60);
  return true;
}
```

---

## 十六、监控运维

### 15.1 健康检查端点

```
GET /api/platform/ai/health
```

```json
{
  "code": "0",
  "msg": "成功",
  "data": {
    "status": "ok",
    "uptime": 86400,
    "timestamp": "2026-07-31T12:00:00.000Z",
    "checks": {
      "redis": "ok",
      "defaultProvider": "ok"
    }
  },
  "traceId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "apiCost": 1
}
```

### 15.2 关键监控指标

| 指标 | 采集方式 | 告警阈值 | 说明 |
|------|----------|----------|------|
| **AI响应延迟** | Orchestrator记录latencyMs | P95 > 10s | AI响应变慢 |
| **Tool执行失败率** | ToolRegistry统计 | > 10% | 后端服务异常 |
| **Token消耗** | t_ai_audit_log汇总 | 日消耗 > 100万 | 费用异常 |
| **Provider健康** | 定时healthCheck | 失败 | API不可用 |
| **Redis连接** | 连接状态 | 断开 | 对话记忆不可用 |
| **Agent循环次数** | Orchestrator统计 | 平均 > 5轮 | 工具定义需优化 |
| **请求QPS** | Nginx日志 | > 100/s | 流量异常 |

### 15.4 Prometheus + Grafana 监控指标

**暴露端点**：`GET /api/platform/ai/metrics`（Prometheus text format）

| 指标名 | 类型 | 标签 | 说明 |
|--------|------|------|------|
| `ai_request_total` | Counter | `tenant_id`, `provider`, `status` | AI请求总数 |
| `ai_request_duration_seconds` | Histogram | `tenant_id`, `provider` | AI请求耗时分布 |
| `ai_token_consumed_total` | Counter | `tenant_id`, `provider`, `type`(prompt/completion) | Token消耗总量 |
| `ai_tool_call_total` | Counter | `tool_name`, `status`(success/fail) | 工具调用次数 |
| `ai_tool_duration_seconds` | Histogram | `tool_name` | 工具执行耗时 |
| `ai_tool_circuit_open` | Gauge | `tool_name` | 熔断器状态（1=开启） |
| `ai_agent_iterations` | Histogram | `tenant_id` | Agent循环轮次分布 |
| `ai_provider_health` | Gauge | `provider` | 服务商健康（1=ok, 0=down） |
| `ai_rag_query_total` | Counter | `tenant_id`, `hit`(true/false) | RAG检索次数 |
| `ai_active_sessions` | Gauge | `tenant_id` | 活跃会话数 |
| `ai_balance_remaining` | Gauge | `tenant_id` | 租户预付费余额 |

**Grafana Dashboard 面板规划**：

| 面板 | 核心图表 | 数据源 |
|------|----------|--------|
| **AI总览** | QPS趋势、错误率、P95延迟 | `ai_request_total`, `ai_request_duration_seconds` |
| **Token用量** | 各租户Token消耗堆叠图、日环比 | `ai_token_consumed_total` |
| **工具健康** | 各工具成功率、耗时热力图、熔断状态 | `ai_tool_call_total`, `ai_tool_duration_seconds` |
| **Provider状态** | 各服务商健康状态、故障切换次数 | `ai_provider_health` |
| **Agent行为** | 循环轮次分布、RAG命中率 | `ai_agent_iterations`, `ai_rag_query_total` |
| **租户计费** | 余额预警租户列表、日消费趋势 | `ai_balance_remaining` |

**告警规则（Alertmanager）**：

```yaml
# 30秒内AI请求错误率 > 20%
- alert: HighErrorRate
  expr: rate(ai_request_total{status!="success"}[30s]) / rate(ai_request_total[30s]) > 0.2
  for: 1m
  labels: { severity: critical }

# Tool熔断器开启
- alert: ToolCircuitOpen
  expr: ai_tool_circuit_open == 1
  for: 30s
  labels: { severity: warning }

# Provider全部不可用
- alert: AllProvidersDown
  expr: sum(ai_provider_health) == 0
  for: 30s
  labels: { severity: critical }

# 租户余额低于预警线
- alert: LowBalance
  expr: ai_balance_remaining < 10
  for: 5m
  labels: { severity: warning }
```

### 15.5 日志规范

**日志级别：**

| 级别 | 环境 | 用途 |
|------|------|------|
| `debug` | 开发 | Tool调用详情、LLM请求/响应 |
| `info` | 开发+生产 | 关键事件（请求到达、工具注册、对话完成） |
| `warn` | 生产 | 降级触发、重试、限流 |
| `error` | 生产 | 调用失败、异常 |

**结构化日志格式：**

```json
{
  "timestamp": "2026-07-31T12:00:00.000Z",
  "level": "info",
  "event": "tool_executed",
  "tool": "createSalesOrder",
  "tenantId": "t_001",
  "userId": "u_123",
  "sessionId": "sess_xxx",
  "duration": 1520,
  "success": true
}
```

### 15.6 告警规则

| 规则 | 条件 | 通知方式 | 级别 |
|------|------|----------|------|
| AI服务不可用 | healthCheck连续3次失败 | 企微/邮件 | 🔴 紧急 |
| 响应延迟过高 | P95 > 10s 持续5分钟 | 企微 | 🟡 警告 |
| Token消耗异常 | 日消耗 > 100万 | 企微 | 🟡 警告 |
| Tool失败率 | > 10% 持续10分钟 | 企微 | 🟡 警告 |
| Redis断开 | 连接状态=断开 | 企微/邮件 | 🔴 紧急 |

---

## 十七、降级与容灾

### 16.1 降级策略

```
正常流程:
  用户 → AI底座 → DeepSeek → Tool执行 → 返回结果
                                    │
                          如果Tool执行失败 ↓

降级链路:
  ┌─────────────────────────────────────────────────────────┐
  │  Level 1: Provider 故障切换                              │
  │  DeepSeek不可用 → 自动切换到 通义千问/智谱                │
  │  对用户无感                                               │
  ├─────────────────────────────────────────────────────────┤
  │  Level 2: 对话记忆降级                                   │
  │  Redis不可用 → 降级为内存存储（当前请求有效，不跨进程）    │
  │  对话历史不保留，但当前对话可正常进行                      │
  ├─────────────────────────────────────────────────────────┤
  │  Level 3: 后端服务降级                                  │
  │  某后端API不可用 → Tool返回错误信息 → AI告知用户        │
  │  "库存服务暂时不可用，请稍后重试"                          │
  ├─────────────────────────────────────────────────────────┤
  │  Level 4: AI底座完全不可用                                │
  │  Nginx检测到AI底座不可用 → 返回503 → 前端隐藏AI入口    │
  │  现有Web/移动端功能不受影响（小程序除外）                │
  └─────────────────────────────────────────────────────────┘
```

### 16.2 Provider 故障切换

```typescript
// 优先级队列：按租户配置的主Provider → 备用Provider → 系统默认

const providerFallbackChain = {
  deepseek: ['qwen', 'zhipu'],     // DeepSeek挂了 → 通义 → 智谱
  qwen: ['deepseek', 'zhipu'],
  zhipu: ['deepseek', 'qwen'],
  ollama: ['deepseek'],             // 本地挂了 → 云端兜底
};

async function callWithFallback(
  messages: ChatMessage[],
  primaryProvider: string,
  config: ProviderConfig,
): Promise<ChatResponse> {
  const chain = [primaryProvider, ...providerFallbackChain[primaryProvider] || []];
  
  for (const providerType of chain) {
    try {
      const provider = providerFactory.create(providerType, config);
      return await provider.chat(messages, { tools });
    } catch (err) {
      logger.warn(`Provider ${providerType} failed: ${err.message}, trying next...`);
      continue;
    }
  }
  
  throw new Error('所有AI服务商均不可用');
}
```

### 16.3 Tool 超时与熔断机制

**设计原则**：Tool调用后端API时，必须有超时控制和熔断保护，避免后端服务故障拖垮AI底座。

```
Tool执行保护链路:

  AI调用Tool
       │
       ├─ 超时控制：每个Tool默认15s超时（可按Tool配置）
       │     │
       │     ├─ 超时 → 返回 "服务响应超时，请稍后重试"
       │     │
       │     └─ 正常 → 返回结果
       │
       ├─ 熔断器（Circuit Breaker，基于 opossum 库）
       │     │
       │     ├─ Closed（正常）：请求通过，统计失败率
       │     │
       │     ├─ Open（熔断）：失败率 > 50%（30秒窗口内）→ 直接拒绝，不调用后端API
       │     │           持续 30 秒 → Half-Open
       │     │
       │     └─ Half-Open（半开）：放行1个探测请求
       │               ├─ 成功 → Closed（恢复）
       │               └─ 失败 → Open（继续熔断）
       │
       └─ 降级响应：熔断/超时 → AI获得错误信息 → 告知用户
                   "库存服务暂时不可用，请稍后重试"
```

**熔断器配置（按Tool粒度）**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `timeout` | 15000ms | 单次调用超时（可按Tool覆盖，如报表查询30s） |
| `errorThresholdPercentage` | 50% | 触发熔断的失败率阈值 |
| `resetTimeout` | 30000ms | 熔断后多久尝试半开 |
| `rollingCountTimeout` | 30000ms | 统计窗口时长 |
| `volumeThreshold` | 5 | 最少调用次数（不足时不触发熔断） |

**各Tool超时配置示例**：

| Tool名称 | 超时 | 理由 |
|----------|------|------|
| `queryInventory` | 10s | 查询类，需快速响应 |
| `createSalesOrder` | 15s | 写入类，含校验+库存扣减 |
| `generateReport` | 30s | 报表生成耗时较长 |
| `callDelivery` | 20s | 对接第三方配送API |
| `queryProductList` | 8s | 查询类，数据量小 |

```typescript
// 熔断器使用示例
import { CircuitBreaker } from 'opossum';

const breaker = new CircuitBreaker(
  (toolName, params, tenantId) => toolExecutor.execute(toolName, params, tenantId),
  {
    timeout: toolConfig.timeout || 15000,
    errorThresholdPercentage: 50,
    resetTimeout: 30000,
    rollingCountTimeout: 30000,
    volumeThreshold: 5,
  },
);

breaker.on('open', () => metrics.toolCircuitOpen(toolName, 1));
breaker.on('close', () => metrics.toolCircuitOpen(toolName, 0));

// 熔断时fallback
breaker.fallback(() => ({
  success: false,
  error: `工具 ${toolName} 暂时不可用（熔断中），请稍后重试`,
}));
```

### 16.4 数据一致性保障

| 场景 | 风险 | 保障措施 |
|------|------|----------|
| **创建销售单+扣减库存** | AI调用order成功但inventory超时 | 后端服务内部通过RabbitMQ保证最终一致性（现有机制） |
| **Agent多步骤执行中途失败** | Step3成功但Step4失败 | 每个Tool调用独立，AI在下一轮可感知失败并告知用户 |
| **对话记忆丢失** | Redis宕机 | 降级为无记忆模式，不影响业务操作正确性 |
| **审计日志丢失** | 后端日志服务不可用 | AuditLogger降级为本地日志，不阻塞主流程 |
| **API Key泄露** | 数据库被入侵 | AES-256-GCM加密存储，即使脱库也无法解密 |

### 16.5 容灾恢复

```
故障恢复流程:

1. 监控检测到异常 → 触发告警
2. 自动降级（Provider切换/内存模式）
3. 运维介入排查
4. 修复故障组件
5. 验证服务恢复正常
6. 告警解除

数据恢复:
- 对话记忆：Redis RDB自动恢复，丢失的为TTL过期数据（不影响业务）
- 审计日志：本地降级日志可手动补录
- AI配置：MySQL主从同步，数据不丢
```

---

## 十八、项目目录结构

```
zhixiang-ai-base/
├── src/
│   ├── main.ts                         # 应用入口，共享实例
│   ├── app.module.ts                   # 根模块
│   │
│   ├── gateway/                        # 对外网关层
│   │   ├── chat.controller.ts          # POST /api/admin/ai/chat (SSE流式)
│   │   ├── chat.gateway.ts             # WebSocket 实时推送
│   │   ├── admin.controller.ts         # AI配置管理API（/api/platform/ai/*）
│   │   └── dto/
│   │
│   ├── brain/                          # 大脑引擎
│   │   ├── orchestrator.service.ts     # 核心编排器
│   │   ├── context-builder.service.ts  # 上下文组装
│   │   ├── memory-manager.service.ts   # 对话记忆（Redis）
│   │   └── prompts/
│   │       └── system.prompt.ts        # 系统提示词模板
│   │
│   ├── providers/                      # Model Provider 层
│   │   ├── provider.interface.ts       # IModelProvider 接口
│   │   ├── provider-factory.ts         # Provider 工厂
│   │   ├── deepseek.provider.ts        # DeepSeek 实现
│   │   ├── qwen.provider.ts            # 通义千问 实现
│   │   ├── zhipu.provider.ts           # 智谱AI 实现
│   │   └── ollama.provider.ts          # 本地Ollama 实现
│   │
│   ├── rag/                            # RAG 引擎
│   │   ├── rag.service.ts
│   │   ├── vector-store.ts
│   │   └── embedder.service.ts
│   │
│   ├── learner/                         # 自主学习引擎
│   │   ├── auto-learner.service.ts      # 主服务：定时扫描+变更监听
│   │   ├── adapters/
│   │   │   ├── swagger.adapter.ts       # Swagger/OpenAPI 适配器
│   │   │   ├── database.adapter.ts      # 数据库 Schema 适配器
│   │   │   └── document.adapter.ts      # 知识库文档适配器
│   │   └── tool-generator.ts            # API定义 → Tool定义 自动生成
│   │
│   ├── tools/                          # 业务工具
│   │   ├── tool.interface.ts
│   │   ├── tool-registry.ts
│   │   ├── definitions/                # 工具定义（给LLM的schema）
│   │   └── handlers/                   # 工具执行逻辑
│   │
│   ├── bridge/                         # 服务桥接层
│   │   ├── service-client.ts
│   │   ├── tenant.interceptor.ts
│   │   └── audit-logger.ts
│   │
│   ├── tenant/                         # 多租户
│   │   ├── tenant-context.ts
│   │   ├── tenant-guard.ts
│   │   └── ai-config.service.ts
│   │
│   ├── database/                       # 数据库
│   │   ├── entities/
│   │   └── database.module.ts
│   │
│   └── common/                         # 公共模块
│       ├── config.ts
│       ├── crypto.ts
│       ├── rate-limiter.ts
│       ├── filters/
│       └── interceptors/
│
├── knowledge/                          # 知识库文件
│   ├── business-rules.md
│   ├── product-catalog.md
│   └── faq.md
│
├── migrations/                         # 数据库迁移（实际路径：项目根目录 docs/migrations/121_ai_base_tables.sql）
│   └── 121_ai_base_tables.sql
│
├── package.json
├── tsconfig.json
├── .env.example
└── Dockerfile
```

---

## 十九、前端改造方案

### 18.1 渐进式改造

```
阶段一（不改现有页面）:
┌─────────────────────────────────────────────────────────┐
│  现有前端不变                                              │
│  + 右下角悬浮 AI 对话按钮                                  │
│  + 点击弹出对话窗口                                        │
└─────────────────────────────────────────────────────────┘

阶段二（AI嵌入业务页面）:
┌─────────────────────────────────────────────────────────┐
│  销售单列表页                         [🤖 AI助手]         │
│  ┌─────────────────────────────────────────────────┐    │
│  │  AI 建议: "今天有3笔订单待确认，点击查看"          │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### 18.2 对话窗口组件

```
┌──────────────────────────────────┐
│  🤖 智享AI助手              [_][×]│
├──────────────────────────────────┤
│  👤 你好，我是智享AI助手          │
│                                  │
│  ──────────────────────────────  │
│                        👤 10:30  │
│  查一下红星商行最近订单           │
│                                  │
│  ┌──────────────────────────┐    │
│  │ 🤖 红星商行最近5笔订单:    │    │
│  │ 单号        日期    金额   │    │
│  │ SO0730001  07-30  ¥19,600│    │
│  │ SO0729003  07-29  ¥8,500 │    │
│  └──────────────────────────┘    │
├──────────────────────────────────┤
│ [________________________] [发送] │
│ 💡 试试: 创建销售单 / 查库存     │
└──────────────────────────────────┘
```

---

## 二十、关键决策记录

| # | 决策 | 选项 | 选择 | 理由 |
|---|------|------|------|------|
| 1 | 部署方式 | 独立服务器 / 同机部署 | **同机部署** | 4核8G够用，简化运维 |
| 2 | AI模型 | 本地 / 云端 / 混合 | **先云端后本地** | 降低服务器压力，架构支持切换 |
| 3 | 默认服务商 | DeepSeek / 通义 / 智谱 | **DeepSeek** | 最便宜、FunctionCalling好、中文强 |
| 4 | 模型切换 | 硬编码 / 配置驱动 | **配置驱动** | ProviderFactory + DB配置 |
| 5 | 工具定义 | 自动生成 / 手工编写 | **手工编写** | 精确控制、业务语义明确 |
| 6 | 服务调用 | 直连DB / HTTP调后端API | **HTTP调后端API** | 复用现有业务逻辑 |
| 7 | RAG存储 | 内存 / FAISS / ES | **内存向量** | 知识库不大，内存足够 |
| 8 | 对话记忆 | 内存 / Redis | **Redis** | 跨进程共享，支持重启恢复 |
| 9 | 多租户 | 独立DB / tenantId隔离 | **tenantId隔离** | 与现有系统一致 |
| 10 | API Key存储 | 明文 / 加密 | **AES-256-GCM** | 安全合规 |
| 11 | 前端改造 | 激进 / 渐进 | **渐进式** | 先加悬浮窗，不破坏现有体验 |
| 12 | 降级策略 | 快速失败 / 多级降级 | **多级降级** | Provider切换+记忆降级+后端服务降级 |
| 13 | 通信协议 | HTTP / SSE / WebSocket | **SSE为主，WS备用** | SSE适合单向流式，WS适合双向 |
| 14 | 能力扩展 | 人工配置 / 自主学习 | **自主学习** | 系统新增功能自动发现→学习→注册，零人工 |
| 15 | 第三方对接 | 封闭 / HTTP API / MCP | **MCP接口** | 标准协议，一个接口暴露所有Tool，零定制对接 |
| 16 | 价格校验 | 禁止亏损 / 提示警告 | **提示不拦截** | 实际业务存在亏钱出货场景，AI只提醒不阻止 |
| 17 | Tool调用保护 | 无保护 / 超时+熔断 | **超时+熔断** | 每个Tool独立熔断器，防止后端服务故障拖垮AI底座 |
| 18 | Session持久化 | 纯Redis / Redis+MySQL冷备 | **Redis+MySQL冷备** | 热数据Redis(1h TTL)，冷数据归档MySQL(90天) |
| 19 | 监控体系 | 日志 / 日志+Prometheus | **日志+Prometheus+Grafana** | 指标可视化+Alertmanager自动告警 |
| 20 | 计费模式 | 按量后付 / 预付费 / 混合 | **预付费为主+混合** | 预付费实时扣减防坏账，免费额度OR逻辑判定 |

---

## 二十一、实施路线图

### Phase 1: 骨架搭建（第1-2周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 初始化 Express.js 项目 | 可编译的空项目 | P0 |
| 实现 Provider 接口 + DeepSeekProvider | 可调用DeepSeek对话 | P0 |
| 实现 ChatController (SSE流式) | 前端可对话 | P0 |
| 实现 Tool Registry + Tool Executor | 工具注册/执行框架 | P0 |
| 实现 Service Bridge（HTTP客户端） | 可调用现有后端API | P0 |
| 数据库表创建 | 5张新表 | P0 |

### Phase 2: 核心功能（第3-4周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 实现 ContextBuilder + MemoryManager | 上下文组装 + 对话记忆 | P1 |
| 实现 order.tool（含 handler） | 销售单CRUD | P0 |
| 实现 inventory.tool | 库存查询/调拨 | P0 |
| 实现 product.tool | 商品查询 | P0 |
| 实现 customer.tool | 客户查询 | P0 |
| 实现多租户上下文注入 | tenantId自动传递 | P1 |

### Phase 3: 完善与对接（第5-6周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 实现剩余业务Tool（采购/配送/财务/报表） | 全部Tool就绪 | P1 |
| 实现 AI 配置中心 API | 总台可管理AI配置 | P1 |
| 实现降级与容灾 | Provider故障切换 | P1 |
| 实现审计日志 | t_ai_audit_log 写入 | P1 |
| 实现限流 | 租户级限流 | P1 |
| 前端对话窗口组件 | 右下角悬浮窗 | P1 |
| 端到端集成测试 | 所有场景通过 | P1 |

### Phase 4: 优化与上线（第7-8周）

| 任务 | 产出 | 优先级 |
|------|------|--------|
| 性能优化（缓存/连接池） | 响应 < 2s | P2 |
| RAG 引擎实现 | 知识检索增强 | P2 |
| 监控告警接入 | 告警规则生效 | P2 |
| 总台AI配置页面（前端） | 可视化管理 | P2 |
| 生产上线 | 稳定运行 | P2 |

---

> **文档版本**: v3.2 | **最后更新**: 2026-07-31

---

> **v3.2 更新（2026-07-31）**：按项目统一标准对齐——数据库表名加 t_ 前缀、API路径改为 /api/ 标准前缀、微服务描述改为单体后端(Express.js)、返回体格式统一为 ok()/fail()、错误码改为数字体系、tenant_id 统一 VARCHAR(36)、主键统一 BIGINT UNSIGNED、字段补中文COMMENT、迁移脚本路径规范对齐
