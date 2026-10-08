【派单 R101-AI-09】阶段 3-B-0：共享 Redis provider 抽取（幂等键的前置工程）

## 1. 任务编号 / 标题

`R101-AI-09` —— 阶段 3-B-0：把 5 处各自 `new Redis()` 收敛为共享 provider，**不改任何连接行为**

## 2. 派发元信息

| 项 | 内容 |
|---|---|
| 卡片 | `docs/reports/R101-AI-09-共享RedisProvider抽取-派单卡.md` |
| 派单人 | 林夕（审查/规划，不代写业务代码） |
| 执行方 | AI 底座线 · 后端（待认领） |
| 仓库 | `D:/Users/ZXQL/ZXQL-AI`，分支 `main`，远程 `gh-ip` |
| 基线提交 | `b1bdd1c` |
| 优先级 | 🔴 高（阶段 3 幂等键的**前置**，不做则幂等键会多出第五份连接池） |
| 关联 | 阶段 3 选型报告 `docs/reports/阶段3-并发幂等-选型报告.md` |

⚠️ **派发前已确认 `git status`**：当前工作区有另一团队（阿坚）正在改 `src/providers/*`、`src/tenant/ai-config.service.ts`、`src/database/database.module.ts`、`src/common/outbound-target.guard.ts`（P1-1 出站收敛的后续）。**本单涉及的文件与他们的改动零交集**，但你仍需在开工前重新 `git status` 确认；若发现重叠，立即停下回报，不要硬改。

## 3. 背景与目标

阶段 3 要把「幂等键」落 MySQL 表 + Redis 做 `SET NX` 前置闸门。但本项目**没有共享 Redis provider**，各模块各自 `new Redis()`：每接入一个新的幂等通路就多一份连接池。

**目标**：抽出一个 Redis 连接来源，让现有 4 个长连接模块共用，**连接数 4 → 1**，且**每个模块的降级行为一字不变**。

**不做的后果**：幂等键落地后变成 5 份独立连接池（每份各自 `maxRetriesPerRequest`、各自重连风暴），Redis 连接数与 `/api/admin/ai/health` 的 Redis 健康检查会同时失真。

## 4. 现状取证（我在 `b1bdd1c` 上实跑核实，不是估算）

`grep -rn "new Redis(" src --include=*.ts | grep -v spec` ⇒ **5 处**：

| 位置 | 用途 | retryStrategy | 备注 |
|---|---|---|---|
| `src/brain/graph/checkpointer.service.ts:45` | 图状态持久化 | `times > 3 → null`（停止重连） | 降级内存：跨进程不可续跑 |
| `src/brain/write-guard.service.ts:267` | 写审核令牌互斥 | `times > 3 → null`（停止重连） | 降级内存：令牌不跨进程 |
| `src/common/rate-limiter.ts:129` | 限流令牌桶 | `times > 3 → null`（停止重连） | 降级内存令牌桶 |
| `src/brain/memory-manager.service.ts:75` | 对话记忆 | `Math.min(times*500, 5000)`（**持续重试**） | P2 修复 2026-10-04 的产物 |
| `src/gateway/admin.controller.ts:457` | 健康检查探针 | `() => null` + `connectTimeout: 3000` | **每次调用新建再销毁** |

其余全部逐字相同：`host=REDIS_HOST('127.0.0.1')`、`port=REDIS_PORT(6379)`、`password=REDIS_PASSWORD||undefined`、`db=REDIS_DB(1)`、`maxRetriesPerRequest: 1`。

## 5. 实施要求

### 5.1 🔴 最关键：两个策略族必须分开，不能一套参数走天下

前 3 处是「**有限重试后降级**」，`memory-manager` 是「**持续重试**」。这是不同业务语义（前者接受降级、后者必须恢复），**抽取时若统一成其中任何一种，都会改变至少一个模块的行为**。

要求：提供两种连接配置（或让调用方显式传入 `retryStrategy` 语义），**保证每个模块抽完之后的 `retryStrategy` 返回值与原代码逐分支一致**。 `memory-manager` 那条注释（`:72-74`：「不再放弃重连——此前 3 次失败即永久停摆」）必须原样迁到新位置，不得删除。

### 5.2 🔴 `admin.controller.ts:457` 不要收进共享池

它是**健康检查专用**：`retryStrategy: () => null` 快速失败 + `connectTimeout: 3000`，且**每次调用新建连接**。若改成共享长连接：
- 健康检查就失去「真实连通性探测」的意义（共享连接已建好 ⇒ 恒健康）
- 原本的快速失败会变成走共享策略的重连

**要求：原样保留**（或被判定可以共享的话，**必须在回传里写明你的理由**，我不同意就保留）。这是本单最容易被"顺手统一"掉的地方。

### 5.3 抽取范围

- 新增一个共享的 Redis 连接来源（provider / module / factory 均可，你定，但要能在现有模块里以依赖注入方式取用）
- 迁移这 **4 个长连接模块**（checkpointer / write-guard / rate-limiter / memory-manager）
- 各模块自己维持原有的：`redisAvailable` 标志、`ping()` 时机、`error` 监听、`onModuleInit` 里的降级日志文本
- 各模块的 **spec 里若 new 了 Redis 或 mock 了连接过程，必须同步改**（本仓踩过三次"改代码同步改 spec"）

### 5.4 本次**不做**的事（留给下一张卡）

- **不引入幂等键本身**（MySQL 表、`SET NX` 闸门、新迁移都不在本单）
- 不改 `P1-1` 那批 `providers/*`、`tenant/*`、`database.module.ts`（别人在改）
- 不修已知的 P1-4（`write-guard` 索引集合无 TTL）—— 那是独立缺陷，不要在本单顺手改，会混淆归因

## 6. 验收标准（回传必须逐条自评 通过/未通过 + 依据）

1. **连接数 4 → 1**：应用启动后 Redis 连接不多于 1 条（健康检查那次临时连接除外）。取证方式自行设计但必须可复跑（`CLIENT LIST` 或单元测试计数均可，写清命令）。
2. **降级行为零改变**：逐 diff 核对这 4 处原有的 `retryStrategy` 分支、`redisAvailable` 置位条件、降级日志文案，**抽完后必须逐分支等价**。如有差异，必须逐项列出并说明理由，不得一句"等价"带过。
3. **门禁全绿且我可复跑**：
   - `pnpm exec tsc -p tsconfig.json --noEmit` exit 0（**不只是 `tsconfig.build.json`** —— 后者 exclude 含 spec，CI 绿灯 ≠ 类型干净）
   - `pnpm exec jest --silent` 全绿（当前基线 **129 suites / 1391 tests**，不得低于）
   - `pnpm exec eslint "src/**/*.ts" --max-warnings=0` exit 0 零输出
   - ⚠️ 取 exit code **不要管道接 `tail`**（`$?` 会变成 tail 的退出码）；落盘再取。eslint 很慢（约 3–8 分钟），后台跑

## 7. 证据要求

回传里必须给出：
- 上述三项门禁的**真实 exit code 与 jest 的 `Test Suites:` / `Tests:` 两行数字**
- 连接数取证的命令原文 + 原始输出
- 4 个模块各自的 before/after 代码片段与行号（重点看 `retryStrategy`）
- **反测回退点**：至少 1 条。建议方向——把某个模块的 `retryStrategy` 改回另一族的语义，验证有断言/用例能抓住（若发现现网无任何手段能发现这种回退，如实说明，这正是我要知道的盲区）

## 8. 红线与约束

1. **禁止触碰这 9 个文件**（另一团队 P0 三卡成果，已提交）：`src/gateway/external-model.controller.ts`、`src/tenant/ai-config.service.ts`、`src/providers/provider-factory.ts`、`src/providers/provider-factory.spec.ts`、`src/providers/openai-compat.provider.ts`、`src/brain/router/provider-router.service.ts`、`src/gateway/external-model.scope.spec.ts`、`src/tenant/ai-config.key-endpoint.spec.ts`、`src/providers/provider-isolation.spec.ts`
2. **禁止触碰正在被改的这批**：`src/common/outbound-target.guard.ts`、`src/database/database.module.ts`、`src/providers/deepseek.provider.ts`、`src/providers/glm.provider.ts`、`src/providers/ollama.provider.ts`、`src/providers/provider.interface.ts`、`src/tenant/ai-config.service.ts`、`src/tenant/external-model.outbound.spec.ts`、`src/tenant/tenant.module.ts`
3. 🔴 **禁止在共享工作区执行 `git stash` / `git checkout -- .` / `git reset --hard`** —— 2026-10-09 00:57 已发生过一次 `git stash push` 把另一团队 9 个文件一并卷走，靠 `stash@{0}` 才救回。要临时劣化代码做反测，**用 Edit 做对称文案互换还原，不要用 git 命令**
4. **禁止 `git add` 他人产物**：`.tmp-3a/`、`migrations/015_ai_model_price.sql`、`src/database/entities/ai-model-price.entity.ts`、`src/tenant/ai-config.egress.spec.ts`、`src/tenant/ai-model-price.spec.ts`、几份 untracked 报告与那个 HTML 设计稿改动
5. **不许** `it.skip` / `describe.skip` / `|| true` / `2>/dev/null` 掩盖失败
6. **提交信息里不许写任何你没实际验证过的断言**（本仓已因此返工两次）
7. ⚠️ 迁移编号 **`015` 已被占用**（`migrations/015_ai_model_price.sql`，untracked）。本单不建迁移；如你觉得必须建，**只能用 016 及以后**，且要先回报给我确认

## 9. 交付与提交要求

- 提交到 `main`，推送：`env -u http_proxy -u https_proxy git push gh-ip main`
  - ⚠️ `origin` 是镜像，**查同步必须用 `git rev-list --left-right --count gh-ip/main...HEAD`**（用 `git status -sb` 的 ahead 数会得出错误结论）
  - 推送失败：`git push --dry-run` 打印 `a..b` 但 exit≠0 ⇒ 服务端故障，退避重试即可（实测第 8 次成功）；不打印 ⇒ 认证/权限/内容问题。**不要** force-push、不要建临时分支绕过
- 回报：commit sha、`git rev-list` 真实输出、改动文件清单

## 10. 回传方式 + 免责句

按下面的块填好回传给我（**附在最终消息里，不要只落文件**）：

```
【汇报 R101-AI-09-R】对应派单 R101-AI-09
<一句话结论>
汇报对象：凌舟（总负责人）
汇报人：<你的署名>（<岗位>）｜2026-10-09
交付物：<改动文件:行号 + 提交哈希 + 连接数取证结论>
证据（可复跑）：<命令 + 原始输出摘要 + 逐条反测回退点>
验收自评：<逐条对照第 6 节的 3 条，写 通过/未通过 + 依据>
未完成与阻塞：<逐条；没有也要写"无">
风险与自我报备：<残余风险；没有也要写"无">
回传要求：
本汇报已落卡：docs/reports/R101-AI-09-共享RedisProvider抽取-回传.md
关联卡：docs/reports/R101-AI-09-共享RedisProvider抽取-派单卡.md
```

**⚠️ 免责句（重要）**：本卡的行号与策略描述是我在 `b1bdd1c` 上核实的，但**实施前请先 Read 确认真实代码**，不要凭本卡臆测。若发现与描述不符 —— 特别是 `retryStrategy` 的分支、`admin.controller.ts:457` 的语义、或有人在你开工前改了这几个文件 —— **以代码为准并立即回报**，不要硬套。

---

*本单由林夕（只读审查/规划）派发，不含任何业务代码改动。*
