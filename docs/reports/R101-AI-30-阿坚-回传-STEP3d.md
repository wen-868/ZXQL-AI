# R101-AI-30 STEP3d 回传 · ⑤ 归位核验（ToolExecutor 层已有真断言，无需新增）

> 门禁：`tsc` 0 / `eslint --max-warnings=0` 0；AI-21 真库 spec **4/4**；ToolExecutor 幂等 spec 覆盖 ⑤（**既有，未改动**）
> 结论：**⑤ 不需要新写** —— 它已在正确层（ToolExecutor）且断言是**反测敏感**的；AI-21 五条自此**全部**由真断言覆盖

## 回传（十项格式）

```
【汇报 R101-AI-30-R-STEP3d】按你指令做"⑤ 的正确落点"时先核验，发现**⑤ 已在 ToolExecutor 层且断言真实有效**
（`tool-executor.idempotency.spec.ts:124` 断言 `gate.check` 从未被调用），另有一条更强的变体 :153；
⇒ **不新增重复用例**（避免维护两份），AI-21 五条现已全部由"反测敏感"的真断言覆盖；R101-AI-32/33 未开始
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜2026-10-14
交付物：
  1. **⑤ 归位核验（本步核心结论：无需写新用例）**
     - `src/tools/tool-executor.idempotency.spec.ts:124` —— `反测 ⑤：预览路径（confirm !== true）不消耗幂等键`
       关键断言：**`expect(h.gate.check).not.toHaveBeenCalled()`**（+ `gate.complete` 以 `handle=null` 调用 + 工具照常执行 1 次）
       ⇒ **反测敏感**：若 executor 在预览路径错误调用闸门 ⇒ 该断言**必红**（这正是"脚本 ✅"缺失的性质）
     - 同类更强变体：`:153` `LLM 自带 confirm=true 无 allowConfirm ⇒ 强制降级为预览，同样不消耗幂等键`
       （断言同样 `gate.check` 未被调用 + `tool.execute` 收到 `confirm:false`）
     - ⇒ ⑤ **不是"漏了"，而是我一直只在闸门层找**；闸门层确实做不到（闸门不做 confirm 判定），**归位结论 = ToolExecutor 层已覆盖**
  2. **AI-21 五条最终覆盖矩阵**（两层次，全部真断言）
     | 条 | 层 | 位置 | 断言性质 |
     |---|---|---|---|
     | ① 同令牌回放 | 闸门 × 真 sqlite | `idempotency-gate.sqlite.spec.ts:147` | 真库 1 行 + `result` 含 `idempotent_replay` |
     | ② 清 Redis 仍 replay | 闸门 × 真 sqlite | 同上（② 例） | 真库唯一键兜底（F4 真驱动） |
     | ③ 去唯一键 ⇒ 失效 | 闸门 × 真 sqlite | 同上（③ 例） | **真 mutation**：`DROP INDEX` 后不再 replay、行数 > 1 |
     | ④ DB 不可用 fail-open | 闸门 × 真 sqlite | 同上（④ 例） | `ds.destroy()` 后 `proceed` |
     | ⑤ 预览不耗键 | **ToolExecutor** | `tool-executor.idempotency.spec.ts:124 / :153` | **`gate.check` 未被调用** |
  3. 我**没有**新增 ⑤ 的重复用例（你的指令是"落地"，核验后结论是"已落地、且更可靠"）；
     我先前在闸门层尝试的那条 ⑤ 已回退（不写假通过）
  提交哈希：**未提交**（等你收口）
证据（可复跑）：
  - ⑤（既有用例，未改一行）：
      `$ node node_modules/jest/bin/jest.js --ci src/tools/tool-executor.idempotency.spec.ts`
      → 含 `√ 反测 ⑤：预览路径（confirm !== true）不消耗幂等键` / `√ LLM 自带 confirm=true 无 allowConfirm ⇒ 强制降级为预览`
  - AI-21 真库四条：`$ node node_modules/jest/bin/jest.js --ci src/tools/idempotency-gate.sqlite.spec.ts` → **4 passed**
  - 门禁：`tsc` 0 / `eslint --max-warnings=0` 0；两个闸门 spec 合计 **43 passed**；全量最近一次实测 **158 套件 / 1729 用例**
    （其后唯一改动 = 移除我在闸门层尝试的 ⑤，该 spec 复跑 4/4 + tsc/eslint 0）
验收自评：
  1. ⑤ 归位落地 → **通过（已存在，核验确认）**：`tool-executor.idempotency.spec.ts:124`，断言 `gate.check` 未被调用（反测敏感）
  2. 既有 spec 零断言修改 → **通过**（本步**未改任何** spec；只做核验）
  3. 反测不可省 → **通过**：①②③④ 中 ③ 为真 mutation；⑤ 的断言"若坏了必红"
  4. 不 .skip / 不写假通过 → **通过**（我先前那条闸门层 ⑤ 因实测红已回退，未留假通过）
未完成与阻塞：
  1. **R101-AI-32/33（forecastSales / analyzePriceTrend）未开始** —— 契约已读，等你说"开工 32/33"（按你上一条指令，第二步就是它）
  2. 你的两个 `.cjs` 脚本标注失效（③⑤ 判定有误）由你加头部说明——我未改你的脚本
  3. 冷启动 + 完整对话仍为脚本级验证（你已亲跑 ✅），未进门禁
风险与自我报备：
  1. **本步零新增代码**：这是"核验后判定无需重复实现"的结论，不是"没做"。若你希望**统一入口**
     （例如把五条 5 条全部收在一个 spec 文件里便于对账），我可以做一份**只读汇总 spec**（不改既有断言），但会造成两处断言同一行为 ⇒ 我倾向保持现状（避免双份维护），请你裁量。
  2. 你入册的三类陷阱我完全认同；本步正是用"**这条会红吗**"这把尺子复核了 ⑤，才确认它合格（对比你的 ③⑤ 恰好都过不了这把尺子）。
回传要求：本汇报已落卡：docs/reports/R101-AI-30-阿坚-回传-STEP3d.md
关联卡：docs/tasks/cards/R101-AI-30-standalone存储改造.md
```

## 附：本步改动
**无**（纯核验）。工作区全绿、无中间态：方言层 / 双模式装配 / STEP2c / STEP3 基线 / STEP3b 真库四条 / STEP3d ⑤ 归位核验。
未改 `src/` 生产代码、未改既有 spec、未 .skip、未 commit / push / stash、未动 package.json / lockfile。
