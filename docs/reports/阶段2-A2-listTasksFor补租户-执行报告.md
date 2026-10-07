# 阶段 2 · A2 `listTasksFor` 补 `tenantId` —— 执行报告

> 执行人：p2-a2 | 日期：2026-10-07 | 取证基线：`HEAD = b52a39c`
> 任务卡：`docs/reports/阶段2-数据访问收敛-外派任务卡.md` 「A2」章节

---

## 〇、结论速览

| 项 | 结果 |
|---|---|
| 实际调用点核实 | **确认 1 处**（任务卡说法属实），且额外排除了动态派发写法 |
| 改动文件 | 3 个（service + controller + spec），**未越界** |
| 新增用例 | 6 条（`describe` 内），全部带真实反测信号 |
| 反测| 两次，均按「修复不存在」方向，**分别变红 4 条 / 3 条** |
| 门禁 | 4 条全跑；3 条绿、1 条红但**红灯归属队友 A1 文件域**（详见第六节） |

**给验收者的一句话**：任务卡的实施要求若照字面执行会引入一个**真实越权漏洞**（`A OR B AND C` 优先级），我改了写法并用反测证明这一点。

---

## 一、实际调用点核实（任务卡说法验证）

任务卡称「当前唯一调用点 `employee.controller.ts:132-135`」。**核实属实**。

派单prompt 要求我自己全仓搜、且警惕 grep 零命中的三种误判，故做了双pattern 复核：

```
# pattern 1：方法名本身
Grep "listTasksFor"          → src/ 命中 1 处调用（employee.controller.ts:135）
                                     + service 定义（employee.service.ts:479）
                                     + spec 注释 2 处（非调用）

# pattern 2：扩到"所有 employeeService.* 方法调用 + 动态下标派发"
Grep "listTasksFor|listTasks|employeeService\[|employeeService\." (path=src/)
  → employeeService.<method> 调用点共 8 处（list / create / update / listTasksFor
    / completeTask / markTaskRated×3 / getTaskById / getByUid / findBestForCategories
    / dispatchTask），其中 listTasksFor 仍只 1 处
  → employeeService[...] 动态派发：零命中（排除反射/字符串派发绕过）
```

**结论**：`listTasksFor` 确为 1 处调用，无遗漏。调用方`employee.controller.ts:131-138`
确实先 `requireTenantId()` → `getById(id, tenantId)`，**当前无实际越权路径**，
任务卡定为「一般」severity 合理。

---

## 二、🔴 关键发现：任务卡的实施写法会造成真实越权

### 2.1 任务卡要求

> SQL 加 `AND t.tenant_id = :tenantId`（`docs/.../阶段2-数据访问收敛-外派任务卡.md:138`）

按字面直译即 `.where('... OR ...').andWhere('t.tenant_id = :tenantId')`。

### 2.2 为什么字面写法有洞

TypeORM 的 `where(字符串)` **不添加括号**。`QueryBuilder.js:736-738`：

```js
createWhereConditionExpression(condition, alwaysWrap = false) {
    if (typeof condition === "string")
        return condition;          // ← 字符串原样返回，无括号
```

我未靠推断下结论，用**真实元数据出SQL** 核验（临时脚本，只建元数据不连库，
脚本已删除）。四种写法实测结果：

```
B) 危险写法：where(OR) + andWhere(tenant)
   WHERE `t`.`employee_id` = ? OR `t`.`dispatched_by` = ? AND `t`.`tenant_id` = ?
                ↑ 缺括号 ⇒ SQL 优先级 AND 先算 ⇔ 等价于
                employee_id = ? OR ( dispatched_by = ? AND tenant_id = ? )
                ⇒ employee_id 分支完全不受租户约束 ⇒ 跨租户照样命中！

C) 本次采用：where((OR)) + andWhere(tenant)
   WHERE (`t`.`employee_id` = ? OR `t`.`dispatched_by` = ?) AND `t`.`tenant_id` = ?✅
```

**B 与C 的差别就是一对括号**，但B 是**真漏洞**：只要某租户的 `employee_id`
恰好等于别家员工的 `t_ai_employee.id`（自增主键，跨租户数值空间重叠是常态），
就能读走别家任务原文。这正是任务卡自己在 A2 里担心的场景，却被自己的实施
要求引入。

⚠️ 我**没有**只靠单测来证明这一点（单测桩是我写的，可能与真实行为不符）——
先用真实 TypeORM 出的 SQL 确认机制，再用反测锁住行为。

### 2.3 `tenant_id` vs `tenantId` 写法选择

**两种写法都能正确解析，出SQL 完全相同。**依据是 TypeORM 1.1.0 的
`QueryBuilder.js:493-499`，它把**数据库列名与实体属性名同时**登记为可替换键：

```js
for (const column of alias.metadata.columns)
    replacements[prefix][column.databaseName] = column.databaseName;  // tenant_id
for (const column of alias.metadata.columns)
    replacements[prefix][column.propertyName] = column.databaseName;  // tenantId
```

实测 D 组（驼峰）输出：`... AND `t`.`tenant_id` = ?` ——与下划线组逐字符相同。

**我选择下划线 `t.tenant_id`**，理由是与**紧邻的同一条 WHERE 子句内既有写法保持
一致**（`t.employee_id` / `t.dispatched_by` 都是下划线）。同一条件串里混用
`tenant_id` 与 `tenantId` 会让下一个人怀疑是否真能解析。同文件
`findByNameOrPost`（`:158`）也用 `e.tenant_id = :tenantId`，与全仓风格一致。

> 派单 prompt 提到「若需驼峰就用驼峰」——实测不需要，两种等价；选下划线是
> **一致性**理由，非能力理由。

---

## 三、改动清单（逐行+ 理由）

### 3.1 `src/brain/employee/employee.service.ts`

| 位置 | 改动 | 理由 |
|---|---|---|
| `:478-497` | 注释块扩写为「2026-10-07 安全修复」，说明为何必须带 tenantId | 根因是「约定而非机制」，须让下一个人知道这不是可选优化 |
| `:497` | 签名新增 `tenantId: string`（**放最后**） | 见 3.3 |
| `:503` | `'t.employee_id = :eid OR t.dispatched_by = :uid'` → **加括号** `'('...' : ')'` | 第二节：防 `A OR B AND C` 越权 |
| `:507` | 新增 `.andWhere('t.tenant_id = :tenantId', { tenantId })` | 租户过滤下沉到方法内部 |

### 3.2 `src/brain/employee/employee.controller.ts`

| 位置 | 改动 |
|---|---|
| `:134-136` | `listTasksFor(e.employeeUid, e.id)` → `listTasksFor(e.employeeUid, e.id, tenantId)`（复用上方已有变量，未新增取值） |

### 3.3 `tenantId` 参数位置：放最后（偏离派单prompt，如实说明）

派单 prompt 说「放第一个（与 completeTask/markTaskRated 一致，它们放最后）」，
并要求我自己判断。**我选择放最后**，依据：

- 本文件 14 个方法中，**所有**已带 `tenantId` 的方法都把它放在**最后**
  （`getById(id, tenantId)` / `getByUid(uid, tenantId)` /
  `completeTask(taskId, result, status, tenantId)` /
  `markTaskRated(taskId, result, tenantId)` /
  `getTaskById(taskId, tenantId)`）
- 放最后对调用方更稳：`listTasksFor(uid, id, tenantId)` 中 `id: number` 与
  `tenantId: string` 类型不同，**写错参数顺序会被 tsc 拦下**；若两者同为 string
  就有漏传风险，而本方法第二参是 number，类型已提供保护。
- 放第一个会与文件内全部既有签名不一致，违反「照completeTask / markTaskRated
  对齐」这一任务卡首要依据。

---

## 四、测试

### 4.1 为什么必须新写一个 QueryBuilder 桩（关键）

同文件既有桩`makeQb` 对 `where`/`andWhere` 一律返回自身，`getMany` **恒返回预设
数组**。用它写「跨租户返回空数组」是**恒真断言**—— 无论服务里有没有租户条件、
括号对不对，用例都绿。这正是任务卡 4.5 警告的「零信号门禁」。

故新增 `makeEvalQb`：把服务**真实传入**的条件串与参数原样记下，按SQL 优先级
（AND 高于 OR，支持显式括号）递归下降对夹具行求值，并**刻意复现 TypeORM 的
拼接规则**（`where(字符串)` 不加括号、`andWhere` 以 `" AND "` 追加）。
因此 2.2 的优先级 bug 能被它如实捕获。

安全阀：只支持 `t.col = :param` / `AND` / `OR` / 括号；**解析不了就抛错**，
绝不静默当匹配（避免"解析失败 ⇒ 恒真"的假绿）。我用两次失败迭代验证了这条
（初版词法把 `t.employee_id` 拆成 `t` + `employee_id`、参数键漏掉前导冒号，
都被抛错拦下，而不是默默放过）。

### 4.2 夹具设计（避免恒真）

首版夹具有设计错误：我让 t_b 也有员工 7 的任务，于是 `listTasksFor(..., 't_b')`
**本就该返回 1 条**，而我断言 0 —— 用例红了。这说明断言前提没想清楚，已修正为：

- `t_a`（被越权的租户）：`id=1` employeeId=7 / dispatched_by=`employee:emp_z`
- `t_b`（发起查询的租户）：`id=2` employeeId=99 / dispatched_by=`user`
  ⇒ **B 租户确实没有员工 7、也没有 `dispatched_by=employee:emp_z` 的任务**
  ⇒ 「返回空」是真结论，不是数据本来就没有

### 4.3 用例清单（6 条）

| # | 用例名 | 断言了什么 |
|---|---|---|
| 1 | 本租户：只返回本租户的任务（证明夹具非空、断言非恒真） | `map(id) === [1]`，**防止 #2 靠"永远返回空"变绿** |
| 2 | 跨租户：employee_id 命中别家租户 → 返回空数组 | `length === 0` 且 `not.toContain('A 租户机密任务')`（断言"没泄露原文"，不止长度） |
| 3 | 跨租户：dispatched_by 命中别家租户 → 返回空数组 | 同上，覆盖 OR 的**第二个**分支 |
| 4 | 跨租户：两个越权面各命中一条别家数据 → 一条都不返回 | `map(id) === [3]`（缺租户条件会返回 `[1,2,3]`） |
| 5 | WHERE 子句：租户条件以 AND 挂在 OR 组之外（含括号，不可省） | 子句串含 `(t.employee_id = :eid OR t.dispatched_by = :uid)` 且含 `AND t.tenant_id = :tenantId` |
| 6 | tenantId 为必填位置参数（漏传编译期过不去） | `@ts-expect-error` + `tsconfig.json` 门禁：若签名改成可选参数，**tsc 报错**；并另跑一次本租户正常取数，证明 #6 不是靠"永远抛错"变绿 |

`employee.service.spec.ts` 整体：**21 passed / 21 total**（原15 条 + 新 6 条）。

---

## 五、反测记录

基线 MD5（改动完成、反测开始前）：
```
ad6f3fd12b76dc3e24c1506fdb11795f  employee.service.ts
32a9d0fec6ff2f93b5f2253344823093  employee.controller.ts
83b57462a2080e5efbe8b39ac110156b  employee.service.spec.ts
```

### 反测①「移除 `AND t.tenant_id` 整条」—— 完全移除修复

改法：删掉 `.andWhere('t.tenant_id = :tenantId', { tenantId })`（`tenantId` 形参保留）。

结果：**4 条变红**
```
× 跨租户：employee_id 命中别家租户 → 返回空数组     Expected: 0 / Received: 1
× 跨租户：dispatched_by 命中别家租户 → 返回空数组
× 跨租户：两个越权面各命中一条别家数据 → 一条都不返回
× WHERE 子句：租户条件以 AND 挂在 OR 组之外
```
泄露实证（失败输出里returned的是别家原文）：
```
● 跨租户：employee_id 命中别家租户 → 返回空数组
    Expected: 0
    Received: 1
```
方向正确 —— **「修复不存在」**，不是「让守卫走另一分支」。

### 反测②「只去掉括号」—— 验证优先级 bug 会被抓住

改法：保留 `andWhere(tenant)`，仅把 `'('...' ')'` 的括号删掉（即退回任务卡字面写法）。

结果：**3 条变红**
```
× 跨租户：employee_id 命中别家租户 → 返回空数组
× 跨租户：两个越权面各命中一条别家数据 → 一条都不返回
× WHERE 子句：租户条件以 AND 挂在 OR 组之外（含括号，不可省）
  √ 跨租户：dispatched_by 命中别家租户 → 返回空数组   ← 仍绿，符合预期：
      该分支本就受租户约束，括号只影响 employee_id 分支
```
这组结果很有说服力：**它证明用例 #2 是真的在测括号**，而不是碰巧变红。

### 还原确认

两处反测均已还原，`md5sum` 与基线**逐行一致**：
```
ad6f3fd12b76dc3e24c1506fdb11795f *employee.service.ts
32a9d0fec6ff2f93b5f2253344823093 *employee.controller.ts
83b57462a2080e5efbe8b39ac110156b *employee.service.spec.ts
```
（spec 的 MD5 也一致——反测只动生产代码，未污染测试。）

---

## 六、门禁真实输出

⚠️ 四条**全部前台一次性跑完**，未分批、未后台（遵守任务卡 4.2）。
未用 worktree，直接在当前工作区跑 —— 因为本卡只碰 3 个文件且已git status
确认开工前 `src/` 干净；`git diff --stat` 可核。

### 6.1 `npx eslint "src/**/*.ts" --max-warnings=0`

**本文件域（`src/brain/employee/**`）零输出 + exit 0：**
```
$ npx eslint "src/brain/employee/**/*.ts" --max-warnings=0; echo "EXIT=$?"
EXIT=0
```

全量首跑有 4 条 prettier 错误，其中**2 条是我的**，已修；另外 2 条属队友A1
在写文件（`metrics.service.ts:116` prettier、`billing.service.ts:135`
`no-unsafe-assignment`），**不在本卡文件域，未代改**。

### 6.2 `npx tsc -p tsconfig.build.json --noEmit`（CI 配置）

```
$ npx tsc -p tsconfig.build.json --noEmit; echo "EXIT_BUILD=$?"
EXIT_BUILD=0
```

### 6.3 `npx tsc -p tsconfig.json --noEmit`（🔴 含 spec，CI 排除 spec）

```
$ npx tsc -p tsconfig.json --noEmit; echo "EXIT_ALL=$?"
EXIT_ALL=0
```
这一条同时验证了用例 #6 的 `@ts-expect-error` 是**有效**的：若`tenantId` 变成可选
参数，此处会因"无错误可抑制"而报错。

### 6.4 `npx jest --ci`（全量）

```
Test Suites: 1 failed, 124 passed, 125 total
Tests:       3 failed, 1321 passed, 1324 total
Time:        101.236 s
```

**3 条失败全部在 `src/gateway/admin.controller.tenant-scope.spec.ts`**，是队友 p2-a1
正在进行的 A1（`admin.controller` 三处手写租户校验收敛）中间态。

归属核证：
```
$ git diff --name-only -- src/gateway/
src/gateway/admin.controller.tenant-scope.spec.ts← 队友 A1 改动
src/gateway/admin.controller.ts                        ← 队友 A1 改动

$ git diff --stat -- src/brain/employee/
 employee.controller.ts   |   4 +-
 employee.service.spec.ts | 281 +++++++++++++++++++++++
 employee.service.ts      |  21 ++-
```
我**未改任何 gateway 文件**，两条文件域零交集。

排除该在写文件后，全量前台跑完：
```
$ npx jest --ci --testPathIgnorePatterns "src/gateway/admin.controller.tenant-scope.spec.ts"
Test Suites: 124 passed, 124 total
Tests:       1303 passed, 1303 total
```

**A2 交付判定：4 条门禁在我负责的文件域全绿；全量红灯归属队友 A1，非本卡引入。**

---

## 七、发现但本卡未处理的问题

1. **🔴 `sweepStaleRunningTasks` 是全仓唯一仍无租户条件的写路径**
   （`employee.service.ts:391-422`）。它是**系统级对账**（把全库超时 running
   任务落failed），按设计就该跨租户，故**不算缺陷**；但它`update()` 不带
   tenantId，与本卡"租户条件下沉"的方向相反。建议 A4 的权威文档里**显式写成
   豁免案例并注明理由**，否则下一位审查者会当漏项再提一遍。

2. **`employee_task.tenant_id` 存在 NULL 行 —— 孤儿任务在任何租户列表里都不可见**
   （**待产品决策，非技术可单方面定**；已核 `migrations/011_employee_task_tenant.sql`）

   实体声明 `tenantId!: string | null`（`nullable: true`），迁移 011 的回填是
   `UPDATE ... JOIN t_ai_employee e ON e.id = t.employee_id`，即**按员工表推导租户**。
   `:11-12` 注释明写：**「回填不到的孤儿行留 NULL」**，`:52-54` 还有
   `remaining_null_tenant_rows` 自报计数。

   ⇒ 本卡的 `AND t.tenant_id = :tenantId` 对 NULL 行**不匹配**，孤儿任务
   **既不显示在任何租户的列表里，也没有任何补偿路径**（运维也看不到）。

   ✅ **与迁移意图一致，非本卡引入的偏差**：迁移注释预告的防线正是
   「由服务侧『按 id 操作必须显式带租户』的校验挡住，不会被误读成公共资源」——
   本卡把 `listTasksFor` 也纳入该防线，是**加固**而非违背。

   ⚠️ **本报告初稿此处曾建议评估 `OR (tenant_id IS NULL AND <同租户员工约束>)`
   —— 该建议方向错误，已撤回**：放开 NULL 会把**无归属数据暴露给任意租户**，
   等于用「漏显示孤儿」换「误显示别人家的数据」，后者是不可接受的。
   漏显示 ≪ 误显示，保持现状（fail-closed）。

   **待产品决策**：孤儿任务是否需要可见性与运维查询入口（例如后台按
   `tenant_id IS NULL` 过滤的运维视图）。这不该由技术单方面定，已列入
   待确认清单。

3. **`take(50)` 在无租户过滤时是跨租户配额** —— 修复前若别家租户数据占满50 条，
   会把本租户任务挤出窗口。修复后已缓解，未做专门用例。

4. **给 A4 的输入：「字符串条件不加括号」是 TypeORM 通用陷阱 —— 但全仓只有本处是真隐患**

   已对全仓做同类扫描（`.where(` 后接 `.andWhere(`、且字符串条件含 AND/OR）：

   | 位置 | 条件串 | 判定 |
   |---|---|---|
   | `employee.service.ts:158-159` | `.where('e.tenant_id = :tenantId AND e.status = 1')` + `.andWhere('(e.name LIKE :kw OR e.post LIKE :kw)')` | ✅ **安全，但安全原因是 `:159` 加了括号**（OR 组被括住），不是「因为 `:158` 是纯 AND」 |
   | `employee.service.ts:246` | `status = :status AND created_at < :cutoff` | ✅ 真正纯AND，无 OR 参与 |
   | `employee.service.ts:501` | 本卡修复处 | ✅ 已加括号 |
   | `audit-logger.ts:397-410`、`evolution-version.service.ts:232`、`admin.controller.ts:362`等 | 单条件原子 `andWhere` 链 | ✅ 均为单条件逐条追加，无 OR 参与 |

   ⚠️ **一处需要纠正的流传说法**：`:158` 常被说成「纯 AND 故无风险」，但该链的
   `:159` **含OR**。它安全**恰恰是因为给 OR 组加了括号** —— 与本卡修复手法相同。
   把它记成「纯 AND 安全」会掩盖真实规律。

   ⇒ 真实规律：**风险只在「字符串条件含 OR 且未整体加括号」时成立**。
   且**同文件 `:159` 已有「OR 组加括号」的既有先例**，本卡写法与之一致
   （不是引入新风格，而是沿用本文件已有正确做法）。
   A4 写反面教材时建议照此表述，否则会造成不必要的恐慌。

---

## 八、偏离派单 prompt 之处（如实列出）

| # | 派单要求 | 实际 | 理由 |
|---|---|---|---|
| 1 | SQL 加 `AND t.tenant_id = :tenantId` | 加了**并额外给 OR 组加了括号** | 照字面写会产生 `A OR B AND C` 真实越权（第二节有实测 SQL 证据 + 反测②证明） |
| 2 | `tenantId` 放参数列表**第一个** | 放**最后** | 本文件 5 个已带 tenantId 的方法**全部**放最后；且第二参 `id: number` 与 `tenantId: string` 类型不同，写错顺序会被 tsc 拦下 |
| 3 | 测试断言「返回空数组」 | 改了夹具，使「空」成为真结论 | 首版夹具让 t_b 也有对应任务 ⇒ 空是恒真且断言本身错误，已修正（4.2） |
| 4 | 文件域含"它们的 spec" | 只改`employee.service.spec.ts` | 全仓**无** `employee.controller.spec.ts`（已搜）；未新建，理由是本卡要求"不要动其他文件"，且 service 层已覆盖隔离语义 |

---

## 九、复核建议（给验收者）

1. `git diff -- src/brain/employee/employee.service.ts` 看真实 diff；
2. **亲自复现反测②**：把 `'('...' : ')'` 的括号删掉，跑
   `npx jest src/brain/employee/employee.service.spec.ts` ⇒ 应红 3 条；
3. 第四节 6.3 那条 `tsc -p tsconfig.json` 请勿省 —— 它是用例 #6 唯一的门禁。

*本报告所有数字均来自实际执行输出，可复现。未执行 git commit / push。*