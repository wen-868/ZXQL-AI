# AI-P1-3 · `aiDocAsk` 对话式文档问答

> 派单人：凌舟（总负责人）｜2026-10-24
> 负责人：阿澈（AI 底座集成 owner）
> 执行通道：WorkBuddy
> 优先级：P1
> 基线：`c59a45f`（P1-2 收口后）
> 工作树：`D:\Users\ZXQL\wt-agents\AI-P1-3`
> 分支：`feat/ai-p1-3-doc-ask`

---

## 一、目标

给商户一句话问某篇文档的内容：`这份合同的关键付款条款是什么？` → AI 读该商户**有权访问**的那篇文档正文，给出**基于原文、带出处**的回答；无权限/无正文/无依据时如实说不能答，**绝不编造**。

对齐业主口径：人工能做"翻到那份合同、读、答"，AI 数字员工必须也能做，且更少步骤（不用先打开文档再自己找）、更懂上下文（限定这篇、不串文档）、更安全（权限优先、有据可查）。

---

## 二、开工前必读的两个硬约束（本仓已踩过 / 数据层真实缺失）

### 🔴 约束 1：不得为了注入 LLM 而形成 ToolsModule→BrainModule 环

`ProviderRouterService` 在 **BrainModule**；而 `BrainModule` 已 `import ToolsModule`（见 `brain.module.ts` / `tools.module.ts`）。
⇒ **`aiDocAsk.tool.ts` 里直接注入 `ProviderRouterService` 会成环**：
`ToolsModule → BrainModule → ToolsModule`。这正是 **R101-AI-47 readiness 单实测踩过的坑**（当时把依赖挂进 OpsModule 触发 circular dependency，最后靠"只依赖叶子的独立模块"解环）。

**必须选一个无环方案并用 `app.module.di.spec.ts` 实测证明**（不是"看起来没环"，是 spec 编译通过）：

- **正解 A（推荐，与 `EmployeeTaskBridge` 同构）**：ask 能力用**回调注册**。在 Brain 侧新增 `AiDocAskBridge`（`OnModuleInit` 时 `this.docAsk.setRunner(async (input)=>router.chatSyncWithFallback(...))`）；tools 侧 `aiDocAsk.tool.ts` 只依赖一个注册在 **tools 叶子内** 的轻量 `AiDocAskRunner`（构造期可为空、由 Bridge 注入），**ToolsModule 不 import BrainModule**。
- **正解 B**：独立叶子模块 `DocAskModule`（只 `imports: [ProvidersModule, TenantModule, CommonModule]`，**不含 tools/brain/proactive**）导出一个 `DocAskService`（内部用 ProviderRouter 或等价路由）；`ToolsModule import DocAskModule`。必须确认 `ProvidersModule/TenantModule/CommonModule` 都不反向依赖 ToolsModule，否则同 A 的坑。

> 选 A 还是 B 由执行者以 DI spec 实测定；**卡不为难你选哪个，但要求：环一旦存在必须当场红给你看，不许"应该没问题"**。

### 🔴 约束 2：单篇文档正文当前唯一来源 = 已入库的分块，不存 `t_ai_doc`

调研事实：`t_ai_doc`（`ai-doc-get.tool.ts`）**只返回元数据 + `storagePath`，不含正文**；正文只在 `t_ai_knowledge_chunks`（RAG 分块，`docName === t_ai_doc.id`，见 `vector-store.service.ts`）。
⇒ **aiDocAsk 的"读这篇文档正文"只能来自该 docId 在 chunks 里的分块**。

因此本单口径钉死：

1. 取正文 = 按 `docId` 拉该文档的全部/Top-N 分块文本（P1-2 已确立 `docName===id` 的回连路径，复用）。
2. 该 docId **在 chunks 里没有分块**（文档从未入库 RAG / `ragStatus!=='ready'`）⇒ **如实返回"该文档尚未建立可问答的内容索引"** + 可执行建议（先 `aiDocUpload`/等待入库完成），**不得**回退去读 `storagePath` 假装成功（那条读文件路径本单**不验、不用**，列为后续增强）。
3. **不得**为绕过第 2 点而在本单擅自加"读 storagePath 文件"——那要动 document-loader + 文件可达性验证，是另一单的事。

> 若你认为"必须能问上传即问答"，**停下来回报我**，不要自行扩范围。约束 2 是数据现状，不是设计偏好。

---

## 三、交付物

### 1. `src/tools/definitions/ai-doc-ask.tool.ts`（新）
- `name='aiDocAsk'`；`isWriteOperation=false`（读工具，走读宽桶、不占幂等键）。
- 入参：`docId`（必填）、`question`（必填）、可选 `topK`（默认 6，取值范围校验，非法回落默认）。
- **ACL 先行**（不可绕过，与 aiDocGet/aiDocSearch 同一 `OfficeAclService.getVisible`）：
  - 先 `getVisible(docId, principal)`；无权/不存在 ⇒ **同一口径**返回"文档不存在或无权访问"（防存在性泄漏，照抄 `ai-doc-get.tool.ts` 的 `!doc` 处理）。
- 取该 docId 的分块正文（约束 2）；无分块 ⇒ 返回"未建立索引"分支（不算 success:false 的错，而是 success:true + 明确 status/data 说明，供上层提示）。
- 组 `ChatMessage`：system 限定"只依据下面提供的原文片段回答；原文没有就答『文档中未提及』，不得脑补"；user = question + 编号的片段（带出处标记）。
- 调 LLM：经约束 1 选定的无环 runner 调 `chatSyncWithFallback`（带租户 `getResolvedConfig()` + `systemScope`，照抄 `planner.service.ts:113` 的 `RouteInput` 装配范式）。
- 返回：`{ docId, title, answer, citations:[{index, chunkIndex, snippet}], model, fallback }`；
  `answer` 必须可追溯到 `citations`；无命中依据 ⇒ answer 走"文档中未提及该问题"固定话术。
- **失败降级**：LLM 全链失败（chatSyncWithFallback 抛"所有 AI 服务商均不可用"）⇒ `success:false` + `error` + `suggestion`（稍后重试/联系管理员配模型），**不得**返回任何编造答案。

### 2. `src/tools/definitions/ai-doc-ask.tool.spec.ts`（新，反测齐全）
必须覆盖（每条都要"改坏会红"）：
- ① ACL 先行：无权 docId ⇒ 不调 LLM、不返回正文片段（断言 runner **零调用**）。
- ② 无分块 ⇒ "未建立索引"分支，不编造。
- ③ 正常问答：桩 chunks + 桩 LLM ⇒ answer 取自桩、citations 指向 chunkIndex；断言 system 提示含"只依据原文/不得脑补"关键内容（断到关键内容，不是断调用次数）。
- ④ 越权片段隔离：只喂**该 docId** 的 chunks，别的 docName 的 chunks 不得进 prompt（防串文档）。
- ⑤ LLM 失败 ⇒ success:false，无 answer。
- ⑥ 读工具契约：`isWriteOperation===false`、`name==='aiDocAsk'`。
- ⑦ `RouteInput` 装配含 `resolved` + `systemScope`（照抄 planner 范式，断到真取到租户配置）。

### 3. 无环证明
- `src/app.module.di.spec.ts` 必须绿（这是全仓唯一能证明 DI 无环的闸）；
- 若选正解 A，`AiDocAskBridge` 加自己的 spec 断言注册前后 runner 行为。

### 4. 证据 `docs/reports/AI-P1-3-证据-2026-10-24/**` + 回传卡 `docs/reports/AI-P1-3-阿澈-回传-2026-10-24.md`

---

## 四、硬验收（逐条可复跑）

1. `tsc -p tsconfig.json --noEmit`、`tsc -p tsconfig.build.json --noEmit`、`eslint "src/**/*.ts" --max-warnings=0`、`tsc -p tsconfig.build.json`（build）全 EXIT=0。
2. 全量 `jest --ci`：**186 套件 / 1966 用例基线不得减少**，本单新增用例数如实上报（预期 ≥7）；**`app.module.di.spec.ts` 必须绿**（无环铁证）。
   - 若共享主树仍含他线未提交红点（如 R101-AI-48），按 P1-2 口径用 `--testPathIgnorePatterns` 排除他线未跟踪文件后跑，并**两份输出都留**、如实标注哪些红点不是本单。
3. **≥2 条 mutation**：
   - 摘掉 ACL 先行（改直查 chunks 不校验可见性）⇒ ① 红且点名；
   - 摘掉"只喂本 docId chunks"或改回退读 storagePath ⇒ ④ 或 ② 红。
4. 提交范围**仅本单文件**，逐文件 `git add`，**不 push、不开 PR、不 `git add -A`**，不碰他线（R101-AI-48）文件。

---

## 五、商户体验硬判据（沿用业主 2026-10-23 口径）

1. 一句话直达，不用先打开文档再自查；答案直接可读。
2. **有据可查**：每条答案能定位到原文片段（citations），商户可核对；无依据就明说"文档未提及"。
3. **权限永远优先**：无权文档不暴露标题、片段、docId 或"它存在"这一事实。
4. 故障（模型不可用）如实告知可稍后重试，**绝不**用编造内容冒充成功。
5. 不暴露 provider/embedding/chunks 等内部术语给商户文案。

---

## 六、红线

- **不改 `src/rag/**` 公共接口**；不改 `aiDocSearch`（P1-2 已验收）；不碰 `ToolCategory`/office 迁移/aiDocUpload。
- **不制造 ToolsModule→BrainModule 环**（约束 1）；不为此把 RouterService 塞进会成环的模块。
- **不擅自加"读 storagePath 文件"扩范围**（约束 2）——需扩请先回报。
- 不用 mock 冒充生产：单测可 mock chunks 与 LLM，但**真实 embedding 分块 + 真实 LLM 命中在生产未验**，回传须标"未验"，不得声称生产问答已通过。
- 不把 LLM 失败/无索引包装成假成功。

---

## 七、生产状态

- embedding 生产已配智谱 `embedding-3`；P1-2 已让 `aiDocSearch` 具备向量旁路。
- 但 **aiDocAsk 依赖的"文档已入库分块"在生产是否已有数据未验**（需测试租户先上传并等 RAG 入库到 `ragStatus=ready`）。
- 本单验收以**可复跑单测 + DI 无环 + mutation + build**为主；真实"上传→问答"生产链路另列未验。
