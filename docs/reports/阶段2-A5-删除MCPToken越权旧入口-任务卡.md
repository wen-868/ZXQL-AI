# 阶段 2 任务卡 A5 · 删除 MCP Token 的越权旧入口

> **派发人**：林夕 ｜ **日期**：2026-10-07 ｜ **基线**：`HEAD = 1238c87`
> **来源**：阶段 2 任务卡 A1 执行过程中发现，A1 已按纪律停下并上报
> **严重度**：🔴 严重（当前无实际越权路径，但属于**已埋好的雷**）

---

## 〇、为什么单独立卡

第九轮审查确立了一个本仓反复翻车的模式：**新老 API 并存**。

`mcp-token.service.ts` 是这个模式的**教科书样本** —— 2026-10-04 的 P1 修复新增了
带租户条件的 `setEnabledFor`，**但旧版 `setEnabled` 没删**。
控制器用了新版，**旧版还在** ⇒ 未来任何新调用方直接调旧版就天然越权。

**教训：修bug 时必须删除旧入口，不能只留个新版本。**
本卡就是这个模式的收口。

---

## 一、取证（我已实测，基线 `1238c87`）

### 1.1 旧版仍在service 里，无租户条件

```typescript
// src/brain/mcp/mcp-token.service.ts:123
async setEnabled(id: number, enabled: boolean): Promise<boolean> {
  const result = await this.repo.update(id, { enabled: enabled ? 1 : 0 });
  //↑ 裸 id，无 tenant_id 条件
}

// src/brain/mcp/mcp-token.service.ts:162
async remove(id: number): Promise<boolean> {
  const result = await this.repo.delete(id);
  //                    ↑ 裸 id，无 tenant_id 条件 —— 删除任意租户的 Token
}
```

⚠️ **`remove` 比`setEnabled` 更危险** —— 停用尚可恢复，删除不可逆。

### 1.2 新版已存在且正确

```typescript
// :138
async setEnabledFor(id: number, enabled: boolean, tenantId?: string): Promise<boolean> {
  const result = await this.repo.update(
    { id, ...(tenantId ? { tenantId } : {}) },   // ← 有 tenant_id 条件
    { enabled: enabled ? 1 : 0 });
```

### 1.3 控制器调的是新版✓

```
src/gateway/mcp-admin.controller.ts:122:const ok = await this.tokenService.setEnabledFor(id, dto.enabled, tenantId);
```

### 1.4 🔴 生产代码对旧版零引用，只有 spec 在用

```bash
grep -rn "\.setEnabled(\|\.remove(" src/ --include=*.ts | grep -v setEnabledFor
```

结果（生产代码部分）：

| 命中 | 是否相关 |
|---|---|
| `long-term-memory.service.ts:141 episodicRepo.remove(oldest)` | ❌ 另一个类的 remove |
| `write-guard.service.ts:355 / :525 this.remove(write)` | ❌ 本类的另一个 remove |
| `external-model.controller.ts:73 this.service.remove(id)` | ❌ 另一个 service |
| **`mcp-token.service.spec.ts:93 service.setEnabled(1, false)`** | ⚠️ **本卡的唯一引用** |
| **`mcp-token.service.spec.ts:101 service.remove(999)`** | ⚠️ **同上** |

⇒ **旧版 `setEnabled` 与 `remove` 在生产代码里零调用方**，删除是安全的。
唯一要处理的是 spec。

---

## 二、实施要求

### 2.1 删旧入口（这是本卡的核心）

- 删除 `setEnabled(id: number, enabled: boolean)`（`:123`）
- **删除 `remove(id: number)`（`:162`）** —— 除非它有真实调用方

⚠️ **删前必须自己再grep 一次确认零调用方**（我给的是 `1238c87` 的快照，
你开工时可能已有改动 —— 若发现新调用方，**停下报告**，不要强删）。

### 2.2 补齐For 版能力

`remove` 删掉前，先确认它有没有租户版。`setEnabledFor` 有，**`remove` 没有** ⇒
若控制器有删除 Token 的端点，需要新增 `removeFor(id, tenantId?)`。

**请自己核实**：`mcp-admin.controller.ts` 里有没有删除 Token 的端点？
- 有 ⇒ 必须先补 `removeFor` 并让控制器改用它，**再删旧版**
- 没有 ⇒ 直接删，并在报告里说明「删除能力本就未对外暴露，删旧版无影响」

### 2.3 spec 必须同步改

`mcp-token.service.spec.ts:93` 和 `:101` 直接调旧版，删方法后会编译失败。

⚠️ **改 spec 不是把方法名换掉就完事**：
- `:93` 的 `setEnabled(1, false)` → 应改为 `setEnabledFor(1, false, 'tenant-x')`，
  并断言 update 带了 `tenant_id` 条件
- `:101` 的 `remove(999)` → 若删了 `remove`，按 2.2 的结论处理

**禁止**用 `as any` 或注释掉用例来绕过编译错误。

---

## 三、测试要求

核心用例：**跨租户操作必须无效**

- `setEnabledFor(其他租户的 id, false, 本租户)` → `affected = 0` → 返回 `false`
- 若补了 `removeFor`：同样断言跨租户删除 `affected = 0` → 返回 `false`

**必须反测**：把 `tenantId` 条件移除 ⇒ 用例立即变红。
反测方向必须是「修复不存在」，不是「让守卫走另一分支」。

---

## 四、通用纪律（与 A1/A2/A3 相同）

1. **开工前跑 `git status`** —— 目标文件若已被他人改动，先回报
2. **门禁在纯净 HEAD 的独立 worktree 跑全量**：
   ```bash
   git worktree add --detach "C:/Users/XIONG/AppData/Local/Temp/<目录>" HEAD
   # node_modules 联接用 PowerShell New-Item -ItemType Junction（Git Bash 的 ln -s 对 TS 无效，报 TS2307）
   ```
   ⚠️ **不要分批后台跑**（会被 SIGTERM 中断漏文件，造成假绿）
3. 四条门禁：
   ```bash
   npx eslint "src/**/*.ts" --max-warnings=0      # 通过时零输出 + exit 0
   npx tsc -p tsconfig.build.json --noEmit        # CI 配置
   npx tsc -p tsconfig.json --noEmit              # 🔴 含 spec，CI 排除 spec
   npx jest --ci# 全量，前台完整跑完
   ```
4. 🔴 **CI 绿灯 ≠ 类型干净**（`tsconfig.build.json` 的 `exclude` 含 `**/*spec.ts`）
5. ⚠️ **grep 零命中有三种可能**：真没有 / SIGTERM 打断 / **pattern 没覆盖写法变体**
   （`grep 'remove('` 可能漏掉 `await this.remove(x)` 之外的形态 —— 请用能覆盖的 pattern）
6. 禁止 `it.skip`、禁止为转绿放宽断言、禁止 `as SomeType[]` 断言
7. **不要 git commit / push**

---

## 五、交付

1. 代码改动（限 `src/brain/mcp/mcp-token.service.ts` + `mcp-admin.controller.ts`（若需）+ spec）
2. 报告 `docs/reports/阶段2-A5-删除MCPToken越权旧入口-执行报告.md`，含：
   - 旧版是否真的零调用方（**贴你的 grep 命令与输出**）
   - `remove` 的处置结论（删 / 补 For 版后再删）
   - spec 的改法与理由
   - 用例清单 + **反测记录**（改了哪 → 变红几条 → 还原确认 MD5/git diff 空）
   - 四条门禁真实输出
3. **不要 commit / push**

---

## 六、附：给未来的一份提醒

删旧入口这件事**必须做**，否则本卡的收益是零 ——
留着 `setEnabled(id)` 就等于留了一个"谁都能调、谁调都越权"的方法。
第九轮报告原话：**「修 bug 时必须删除旧入口，不能只留个新版本」**。

本卡完成后，同类样本还剩哪些，请顺手核实并在报告里列出（**只列出，不要动手**）：

```bash
grep -rn "async \w*(\(id\|code\|uuid\)\s*:" src/ --include=*.service.ts | head -20
```
凡是「只有 id、没有 tenantId 参数」的方法都值得复查。

---

*本卡所有行号与 grep 结果基于 `HEAD = 1238c87` 实测。执行方请自行重跑核实；不符以代码为准并回报。*