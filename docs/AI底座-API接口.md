# AI 底座 API 契约文档

> **本文件范围（请先读）**：项目规则（`docs/规范/项目统一标准.md`）将本文件列为
> API 契约的「唯一真相源」，但此前一直缺失。**R101-AI-09（2026-10-09）首次建立**，
> 当前只收录 **AI 单价管理** 三个端点；其余 AI 底座端点仍以
> `docs/设计/智享AI底座-架构设计文档【唯一权威】.md` 第十一章为运行时依据，
> 后续按批次迁入本文件（迁入前请勿以本文件的"未收录"推断端点不存在）。
>
> 全局约定：前缀 `/api`；管理端鉴权 `Authorization: Bearer <JWT>`；
> DTO 校验开启 `whitelist + forbidNonWhitelisted`（未知字段直接 400）。

---

## 一、AI 单价（t_ai_model_price）

单价是平台的成本/售价口径（元/千Token），**仅供平台身份**维护；运行时由
`AiConfigService.getModelPrice(provider, model)` 读取：取 `enabled=1` 且
`effective_from <= 当前时间` 中最大者，**未配置返回 `null`（不回落成 0）**。

### 1.1 权限（红线）

三个端点全部**显式判平台身份**：`identityType !== 'platform'` ⇒ **403 + `AI_010`**。
**只挂 `AdminGuard` 不够** —— `AdminGuard` 同时放行商家 4 类管理角色
（SUPER_ADMIN / OPERATION_ADMIN / WAREHOUSE_ADMIN / FINANCE_ADMIN）。
（依据：P0-1 教训，`R101-AI-09` 卡）

| 身份 | 列表 | 新增/调价 | 启停 |
|---|---|---|---|
| 平台（zhixiang-platform 签发的平台管理员） | ✅ 200 | ✅ 201 | ✅ 200 |
| 商家管理角色（本租户） | ❌ 403 AI_010 | ❌ 403 AI_010 | ❌ 403 AI_010 |
| 匿名 / 无效 JWT | ❌ 401 AI_001 | ❌ 401 AI_001 | ❌ 401 AI_001 |

### 1.2 列表

```
GET /api/admin/ai-config/model-prices?provider=deepseek&model=deepseek-chat&includeDisabled=1
```

| 查询参数 | 必填 | 说明 |
|---|---|---|
| `provider` | 否 | 服务商（与 `t_ai_usage_daily.provider` 同口径；外部模型用其注册标识） |
| `model` | 否 | 模型名（**精确匹配**，不支持通配） |
| `includeDisabled` | 否 | `1`/`true` = 含停用行；缺省只返回启用行 |

**200 响应**（按 provider、model、effective_from 倒序）：

```json
[
  {
    "id": 12,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "promptPrice": 0.001,
    "completionPrice": 0.002,
    "currency": "CNY",
    "effectiveFrom": "2026-07-01T00:00:00.000Z",
    "enabled": 1,
    "createdAt": "2026-07-01T02:00:00.000Z",
    "updatedAt": "2026-07-01T02:00:00.000Z"
  }
]
```

### 1.3 新增 / 调价（插新行，不覆盖历史）

```
POST /api/admin/ai-config/model-prices
Content-Type: application/json

{
  "provider": "deepseek",
  "model": "deepseek-chat",
  "promptPrice": 0.003,
  "completionPrice": 0.006,
  "currency": "CNY",
  "effectiveFrom": "2026-08-01T00:00:00+08:00",
  "enabled": 1
}
```

| 字段 | 必填 | 校验 |
|---|---|---|
| `provider` | 是 | 非空，≤32 字符 |
| `model` | 是 | 非空，≤64 字符（精确匹配） |
| `promptPrice` | 是 | **显式 0（免费档）或 ≥ 0.000001**；禁止负数；小数位 ≤ 6 |
| `completionPrice` | 是 | 同上 |
| `currency` | 否 | 3 字母（ISO 4217），缺省 `CNY` |
| `effectiveFrom` | 否 | ISO 8601；缺省 = 服务端当前时间 |
| `enabled` | 否 | `0` / `1`，缺省 `1` |

**201 响应**：同 1.2 的单条对象。

**语义要点**：**调价 = 插入新 `effective_from` 行**，旧行保留（唯一键
`uk_ai_model_price_provider_model_effective (provider, model, effective_from)`）。
同 `(provider, model, effectiveFrom)` 重复提交 ⇒ **409**（错误信息会提示指定更晚的
`effectiveFrom`）。历史上任意时点的单价都可从本表复原。

**400 示例**（负数单价）：

```json
{ "statusCode": 400, "message": ["promptPrice must not be less than 0.000001"], "error": "Bad Request" }
```

### 1.4 启用 / 停用

```
PUT /api/admin/ai-config/model-prices/:id/enabled
Content-Type: application/json

{ "enabled": 0 }
```

- `id` 为 `t_ai_model_price.id`；记录不存在 ⇒ **404**
- 只改 `enabled`，**不动价格与生效时间**；`enabled=0` 的行不参与运行时单价解析
- **200 响应**：同 1.2 的单条对象

### 1.5 错误码

| 状态 | 码 | 场景 |
|---|---|---|
| 400 | — | DTO 校验失败（负数/超精度/缺字段/未知字段） |
| 401 | `AI_001` | 缺 Bearer JWT / JWT 无效 |
| 403 | `AI_010` | 非平台身份（商家角色） |
| 404 | — | `PUT .../enabled` 的 id 不存在 |
| 409 | — | 同 `(provider, model, effective_from)` 已存在 |

---

## 二、待迁入（占位）

以下端点当前仍以 `docs/设计/智享AI底座-架构设计文档【唯一权威】.md` §十一 为准，
迁入本文件后请同步更新本节：

- `/api/chat`、`/api/admin/ai-config/*`（平台/租户配置、用量、计费、外部模型）
- `/api/ai/v2/*`、`/api/ai/employees`、`/api/voice`、`/api/rag`
