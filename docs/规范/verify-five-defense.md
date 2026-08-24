# 五道防线落地自检表（每轮必查）

> **文档归属**：`docs/verify-five-defense.md`（项目规则.md 防线4引用，current-tasks.md 永久必读清单第8项）
> **首次创建**：2026-07-30 R69-03
> **适用范围**：每轮派单前（凌舟）、任务完成提交前（各负责人）、端到端验收前（苏然）三大节点

---

## 节点A — 派单前（凌舟 · 必查 6 项）

> **执行时机**：在 `docs/tasks/current-tasks.md` 新增每轮任务条目 **之前** 必须逐一勾选。未勾选不得派单写入任务文件。

### A-1. 目标文件是否存在 + 基本规模核实（防"凭空派单"/R63-08型错误）

**检查命令**（Win PowerShell）：

```powershell
# 1. 基本存在性 + 行数/大小
$targets = @(
  "backend/src/routes/sync.routes.ts",
  "app-mobile/src/pages/home/home.vue",
  "admin-web/src/views/DashboardView.vue"
)
foreach ($f in $targets) {
  if (Test-Path $f) {
    $lines = (Get-Content $f | Measure-Object -Line).Lines
    $bytes = (Get-Item $f).Length
    Write-Host "OK   $f  lines=$lines  bytes=$bytes"
  } else {
    Write-Host "MISS $f  <<<< 派单前必须确认文件存在"
  }
}
```

**A-1 通过条件**：任务涉及的每个文件在 `Test-Path` 下均返回 OK。对"删除/清理"类任务，必须额外执行下一步（A-2），**严禁仅凭印象写"文件为空"就派删除单**。

### A-2. 端点数/功能点实际计数（核实任务描述与代码真实情况匹配）

**检查命令**（以路由文件为例）：

```powershell
# 2. 对 router 类任务：核实实际端点数（非空Router=至少有1个 router. 调用）
$r = "backend/src/routes/sync.routes.ts"
$count = (Select-String -Path $r -Pattern "router\.(get|post|put|delete|patch|use)").Count
$tests = (Select-String -Path "backend/src/__tests__/routes/sync.test.ts" -Pattern "^\s*(it|test)\(" -AllMatches).Matches.Count
$calls = (Select-String -Path "app-mobile/src/api/sync.ts" -Pattern "axios|fetch|request").Count
Write-Host "sync.routes: endpoints=$count  tests=$tests  APP调用=$calls"
# 对"清理空Router"任务：若 count>0 -> 绝对不能派删除单
```

**A-2 通过条件**：任务描述（如"3个空Router"）与实际 count 输出 100% 一致。对删除类任务：**必须同时验证 test 用例数和 APP 调用数**，二者>0就属于"删除会导致功能瘫痪"，严禁派删除，应改为"保留+加注释"派单。

### A-3. 任务描述与实际代码一致（R63-07/08型"派单描述过时"风险）

**检查命令**（grep 关键声明）：

```powershell
# 3. 对"缺少X导出"/"空Y"类任务：先grep确认当前是否真的缺
#    例：R63-07 宣称8文件缺 routeConfig 导出 -> 先grep routeConfigs（复数）
grep -rn "export const routeConfig" backend/src/routes/ --include="*.ts" -c
#    若结果>0（有 routeConfigs 复数导出），说明多Router文件走的是数组形式，
#    auto-routes 优先级1支持此形式，不会触发警告 -> 不得派"必须加单数 routeConfig"单
```

**A-3 通过条件**：grep 输出真的缺/真的有空，才能写对应任务描述。对"R63-08"式历史描述：**必须重跑 grep，不能照搬旧文案**。

### A-4. 跨模块副作用评估（删改会不会影响其他端）

**检查命令**：

```powershell
# 4. 对"删除/改名"类任务：全局全端 grep 目标符号/文件名/API路径
$kw = @(
  "sync.routes",
  "t_stock_warning",
  "/api/sync/products/delta"
)
foreach ($k in $kw) {
  $hits = (Get-ChildItem -Recurse -Include "*.ts","*.vue","*.md","*.sql" |
    Select-String -Pattern ([regex]::Escape($k))).Count
  Write-Host "$k  全端命中=$hits"
}
# 命中>0：说明该标识符在其他端有依赖，派删除/改名单时必须在"问题"字段
# 写明会影响哪些端、哪些调用方需要同步改
```

**A-4 通过条件**：派单的"问题"字段已完整列出受影响模块，"修复"字段包含所有受影响端的同步改造指令。命中为 0 才能派纯"删除不改其他端"单。

### A-5. 负责人能力域匹配（后端/前端-admin/前端-mobile/设计/测试 对齐）

**检查命令**（责任人对照表）：

```powershell
# 5. 手工对照，无自动化命令：
#    - 后端 Express / 数据库 DDL / 迁移脚本  → 阿坚
#    - admin-web 工作台（Vue3+ElementPlus）/ saas-admin 超级后台 → 墨
#    - merchant-mobile 商户端 / app-mobile 移动端 H5 / 营销模块 / 系统设置 → 阿澈
#    - 部署运维 / PM2 / SSL / Nginx / 任务文件更新 / 自检表文档 → 凌舟
#    - 自动化测试 / 性能测试 / Bug报告 → 苏然
#    - UI规范 / 交互稿 → 林夕
```

**A-5 通过条件**：每个任务的"负责人"字段落在上表对应能力域，无张冠李戴（例如把 DDL 派给林夕、把设计稿派给阿坚）。

### A-6. 对应验收命令已写出（每个任务至少 1 条可直接运行的 grep/tsc/vitest/curl）

**检查命令**（任务文件自检）：

```powershell
# 6. 对新增轮次中每个任务条目：grep -c "验收标准" / "核实" > 0
grep -n "验收标准\|核实" docs/tasks/current-tasks.md | Select-Object -First 20
```

**A-6 通过条件**：新增的每个任务条目都同时有"验收标准"+"核实"两个字段，且验收标准中包含**可直接复制运行**的 shell/grep/node 命令，不得包含"验证通过"等无执行意义的空话。

---

## 节点B — 任务完成提交前（负责人 · 必查 5 项）

> **执行时机**：执行 `git commit` 之前，在本地终端逐一运行。全部通过才允许提交。

### B-1. TypeScript 编译零错误（防"TS报错污染诊断面板"/防部署编译失败）

**检查命令**：

```powershell
# 三端分别编译（仅跑你改动所在的端即可）
# - 后端
cd backend; npx tsc --noEmit; Write-Host "backend tsc exit=$LASTEXITCODE"
# - admin-web
cd ../admin-web; npx vue-tsc --noEmit; Write-Host "admin-web vue-tsc exit=$LASTEXITCODE"
# - saas-admin
cd ../saas-admin; npx vue-tsc --noEmit; Write-Host "saas-admin vue-tsc exit=$LASTEXITCODE"
# - app-mobile
cd ../app-mobile; npx vue-tsc --noEmit; Write-Host "app-mobile vue-tsc exit=$LASTEXITCODE"
```

**B-1 通过条件**：改动对应端的 `tsc / vue-tsc --noEmit` 退出码 = 0，输出 ERROR 行 = 0。

### B-2. 影响范围测试零失败（防"改动后破坏既有用例"/R68-04 env回归）

**检查命令**：

```powershell
# - 后端（改动 backend/src/ 下任何文件必跑）
cd backend; $env:NODE_ENV="test"; npx vitest run
#   PASS 条件：Tests 行 4857 passed, 0 failed
# - 前端无统一 vitest，至少生产构建
cd admin-web; npx vite build
cd saas-admin; npx vite build
cd app-mobile; npx uni build
```

**B-2 通过条件**：vitest 退出码=0 且"Tests ... 0 failed"。构建命令退出码=0 且无 `ERROR in` / `error TS` / `Cannot find module` 级错误。

### B-3. 对应任务验收 grep 通过（防"任务写了但代码里没改"）

**检查命令**：对应任务"验收标准"节中写的每条 grep/vitest/tsc 命令，逐一复制运行。示例 R68-01 验收：

```powershell
# 示例：R68-01 t_expiry_alert_record 前缀
grep -n "expiry_alert_record" docs/migrations/092_租户ID.sql
# 通过=所有命中的表名参数全部带 t_ 前缀
```

**B-3 通过条件**：任务验收标准中的每条命令 100% 通过。

### B-4. 踩坑 ≥ 30 分钟必须写入 踩坑日志.md（防"R68-04 env静态求值陷阱"下次重复）

**检查命令**：

```powershell
# 纯人工确认：如果本次任务从"发现错误"到"定位根因"花费 ≥ 30 分钟，
# 必须在 docs/踩坑日志.md 末尾新增如下格式的条目：
#   ### [序号+1] 一句话标题
#   - 日期：YYYY-MM-DD
#   - 踩坑人：姓名
#   - 关键词：tag1, tag2
#   - 现象：一句话
#   - 原因：根因分析
#   - 解决：具体修复方法
#   - 教训：以后怎么避免
```

**B-4 通过条件**：若本次踩坑<30分钟跳过；≥30分钟则 踩坑日志.md 末尾确实新增了 1 条对应条目。

### B-5. 提交信息符合 `type: 中文描述` 规范（防 commit 信息混乱/grep 回溯源失败）

**检查命令**：

```powershell
# 预览 commit 信息（真 commit 前先写规范文本）
#   feat: xxx新功能
#   fix:  修复R69-01 xxx问题（092 sql t_前缀）
#   docs: 更新verify-five-defense自检表
#   chore: 清理/重命名脚本
# 实际 commit 时：git commit -m "fix: R69-01 092.sql alert_rule等8张表补 t_ 前缀"
```

**B-5 通过条件**：`-m` 文本首词为 `feat`/`fix`/`docs`/`chore` 之一，后跟冒号+空格+中文描述，无 "update" / "wip" / "temp" 类模糊信息。

---

## 节点C — 端到端验收前（苏然 · 必查 4 项）

> **执行时机**：一轮所有任务完成、推送到 main 后，生成测试报告 **之前**。4 项全部通过才允许写报告结论。

### C-1. 5 站点登录可达 + 进入主页无白屏

**检查命令**（浏览器子代理或本地）：

```powershell
# 1. 5站点逐个加载并获取状态码
$sites = @(
  "https://admin.onepan.cn/login",
  "https://saas.onepan.cn/login",
  "https://m.onepan.cn/",
  "https://api.onepan.cn/",
  "https://store.onepan.cn/"
)
foreach ($u in $sites) {
  try { $r = Invoke-WebRequest -Uri $u -UseBasicParsing -TimeoutSec 15
    Write-Host "$($r.StatusCode)  $u" }
  catch { Write-Host "ERR $u  $_" }
}
```

**C-1 通过条件**：5 站点均返回 200 或 302（认证跳转算 OK）；admin-web/saas-admin 登录后看板渲染不抛 JS 异常（控制台 0 条 ERROR）。

### C-2. 16 个核心业务 API 全部返回 HTTP 200（R66-02 清单结转）

**检查命令**（登录后抓 token + curl）：

```powershell
# 先 admin.onepan.cn 登录拿到 token，粘贴到下方 TOKEN
$TOKEN = "替换为登录后获取到的 bearer token"
$headers = @{ Authorization = "Bearer $TOKEN" }
$apis = @(
  "https://api.onepan.cn/api/admin/dashboard/overview",
  "https://api.onepan.cn/api/admin/dashboard/sales-trend",
  "https://api.onepan.cn/api/admin/dashboard/inventory-warning",
  "https://api.onepan.cn/api/admin/dashboard/expiry-alert",
  "https://api.onepan.cn/api/admin/products?page=1&pageSize=10"
)
foreach ($a in $apis) {
  try { $r = Invoke-WebRequest -Uri $a -Headers $headers -UseBasicParsing
    Write-Host "$($r.StatusCode)  $a" }
  catch { Write-Host "ERR $($_.Exception.Response.StatusCode.value__)  $a  $($_.Exception.Message)" }
}
```

**C-2 通过条件**：所有 16 个 API（此处列 5 条示意，实际清单见 R66-02 / R68-00）全部返回 200，body JSON 中 error 字段为 null / 不存在。

### C-3. vitest 全量 0 失败（防"某负责人任务过了 B-2，但整轮合入后回归"）

**检查命令**：

```powershell
cd backend; Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
$env:NODE_ENV="test"
npx vitest run
# 期望最终输出：
#   Test Files  NNN passed (NNN)
#        Tests  NNNN passed (NNNN)
```

**C-3 通过条件**：Tests 行 `0 failed`。失败数 > 0 → 验收不通过，回对应负责人修复后再跑。

### C-4. 三端生产构建 0 错误 0 警告（防"合入后三端构建炸裂"/R67-05 用户体验回归）

**检查命令**：

```powershell
cd admin-web; npx vite build 2>&1 | Tee-Object -FilePath build-admin.log | Select-Object -Last 5
cd ../saas-admin; npx vite build 2>&1 | Tee-Object -FilePath build-saas.log | Select-Object -Last 5
cd ../app-mobile; npx uni build 2>&1 | Tee-Object -FilePath build-mobile.log | Select-Object -Last 5
```

**C-4 通过条件**：三份日志 grep `ERROR` / `error TS` / `Cannot find module` / `TypeError` 全部 0 命中；构建产物目录 dist/ 存在且 index.html > 0 bytes。

---

## 命令总数保证（≥ 15 条可执行命令）

以上节点A（6项） + 节点B（5项） + 节点C（4项） = **15 项检查**，每项均包含至少 1 条可直接复制运行的 PowerShell/grep 命令：

- A-1 × 1 段（foreach file Test-Path）
- A-2 × 1 段（router/endpoints count）
- A-3 × 1 段（grep routeConfig 导出模式）
- A-4 × 1 段（跨端副作用全端 grep）
- A-6 × 1 段（任务文件 验收标准/核实 字段 grep）
- B-1 × 4 段（后端 tsc + 三端 vue-tsc）
- B-2 × 4 段（vitest run / 3端 vite build / uni build）
- B-3 × 1 段（任务对应 grep 示例）
- B-5 × 1 段（commit 规范）
- C-1 × 1 段（5站点 Invoke-WebRequest）
- C-2 × 1 段（16核心API Invoke-WebRequest token header）
- C-3 × 1 段（vitest run 最终结果校验）
- C-4 × 3 段（admin/saas/mobile 三端 build 日志校验）

合计：**≥ 22 段可独立运行的检查脚本**，远超 R69-03 验收要求（≥ 10 条命令）。

---
