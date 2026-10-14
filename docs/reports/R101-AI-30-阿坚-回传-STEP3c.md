# R101-AI-30 STEP3c 回传 · 脚本固化尝试（⑤ 发现"空转通过"，已回退该用例）

> 门禁：`tsc` 0 / `eslint --max-warnings=0` 0 / 两个闸门 spec **43 例全绿**（`idempotency-gate.sqlite.spec.ts` 4 例 + 服务 spec 39 例）
> 状态：**任务 1 尝试后按半成品铁律回退**（发现真实问题）；**任务 2（12 条固化）未开始**；任务 3（冷启动脚本保留）已确认

## 回传（十项格式）

```
【汇报 R101-AI-30-R-STEP3c】固化你两个 .cjs 脚本的任务：**任务 1 尝试后按半成品铁律回退**——我把 ⑤ 原样搬进 jest 后**红了**（预览调用后库中仍有 1 行），据此发现**「预览不耗键」不在闸门层**（闸门不做 confirm 判定，该条件属 ToolExecutor），且你脚本 ⑤ 的判定**是空转通过**（用明文键查 count，而库里存的是含盐哈希 ⇒ 恒为 0）；任务 2（STEP2c 12 条固化）未开始；任务 3（冷启动 .cjs 保留）确认
汇报对象：凌舟（总负责人）
汇报人：阿坚（后端架构）｜2026-10-14
交付物：
  1. **任务 1 结论：⑤ 不应固化在闸门层（已回退，树保持全绿）**
     - 我按你脚本 ⑤ 的形态在 `idempotency-gate.sqlite.spec.ts` 加了第 5 例：
       `explicitKey:'preview-sqlite-005'` + `args` **不含 confirm** ⇒ 断言 `decision==='proceed'` 且 `COUNT(*)===0`
     - **实测红**：`Expected: 0  Received: 1`（决策确实是 proceed，但**落行了**）
     - 结论：**闸门不做 confirm 判定**（`idempotency-gate.service.ts` 头注释即写明该条件由 ToolExecutor 把关
       `isWriteOperation === true && args.confirm === true`）⇒ "预览不耗键"**无法在闸门层验证**，必须落 ToolExecutor 集成用例
     - 已把该例**回退**为注释说明（不做假通过断言），闸门 spec 仍 4 例全绿
  2. **你脚本 ⑤ 判定空转（vacuous）的证据链**（这正是你提醒我"必须用 handle.idemKey"的那条坑，反噬在脚本自身）：
     - 脚本 ⑤ 用 `repo.count({ where: { idemKey: k } })`，其中 `k = 'verify-key-005'` 是**明文**
     - 但脚本 ② 自己写明并验证了：**库里存的是键哈希**（`handle.idemKey = sha256(明文)`，脚本 L120-124）
     - ⇒ 用明文查 count **恒为 0** ⇒ `before===after===0` 永远成立 ⇒ ⑤ 的"✅"**不构成对"预览不耗键"的证明**
     - 复现建议（2 行）：把 ⑤ 改成
       `const p = await runTool(k,false); const h = p.handle;`（预览若真认领会有 handle）
       + 用 `repo.count({ where: { idemKey: /* 认领后的哈希 */ } })`；或直接在 **ToolExecutor 层**断言"预览不调闸门"
  3. **任务 2 未开始**：`verify-step2c-integrated.cjs` 的 12 条固化（`redis-memory.integration.spec.ts`）—— 预算耗尽，未动
  4. **任务 3 确认**：冷启动验证保留 `.cjs`（起服务型验证不适合 jest）；脚本头已有复跑说明（`node scripts/sqlite-baseline/verify-*.cjs`）
  提交哈希：**未提交**（等你收口）
证据（可复跑）：
  - `$ node node_modules/jest/bin/jest.js --ci src/tools/idempotency-gate.sqlite.spec.ts`
      √ ① 同令牌回放 √ ② 清 Redis 后仍 replay（真库唯一键兜底） √ ③ DROP INDEX 后不再 replay（mutation） √ ④ DB 不可用 fail-open
      → **Tests: 4 passed**（⑤ 已按上文回退为注释，不出现假通过）
  - ⑤ 红时的原始输出：`expect(received).toBe(expected) … Expected: 0  Received: 1`
  - `tsc` 0 / `eslint --max-warnings=0` 0 / 两个闸门 spec `Tests: 43 passed`
验收自评：
  1. 固化任务 1（AI-21 五条凑齐 5/5）→ **未通过（发现层级错误）**：⑤ 属 ToolExecutor 层，闸门层做不到，
     强行放在闸门层只能写成假通过；我选择**不写假通过**并按半成品铁律回退
  2. 固化任务 2（12 条）→ **未完成**（预算耗尽）
  3. 任务 3（冷启动保留 .cjs + 复跑说明）→ **通过**
  4. 既有 spec 零断言修改 → **通过**（本步只动新增 spec 的第 5 例，未触碰既有断言）
未完成与阻塞：
  1. **⑤「预览不耗键」的正确固化**：需 ToolExecutor 集成用例（构造 executor + 假工具，断言"预览路径不调闸门/不落键"）。
     我未做（预算耗尽），且这需要一个 executor 侧的测试支架（现有 spec 里有 ToolExecutor 的用例可复用）
  2. **任务 2（STEP2c 12 条固化）**：未开始
  3. 冷启动 + 完整对话仍为脚本级验证（你已亲跑 ✅），未进门禁
风险与自我报备：
  1. **"脚本 ✅"不等于"门禁守得住"**：你担心的正是这个，本步又验证了一次——而且比预期更严重：
     **不仅不进 jest，其判定本身还可能空转**（明文键 vs 哈希键）。建议把两个 `.cjs` 的**全部**断言都按
     `handle.idemKey` 口径复核一遍（我这次只复核了 ⑤ 这一条）。
  2. 我**没有**擅自改你的 `.cjs` 脚本（不在我写权限内、且你已用于取证）；若你要，我下一步可把它们改写为
     "真断言版 + 固化版 spec" 两件套。
回传要求：本汇报已落卡：docs/reports/R101-AI-30-阿坚-回传-STEP3c.md
关联卡：docs/tasks/cards/R101-AI-30-standalone存储改造.md
```

## 附：本步改动（未提交）
| 文件 | 说明 |
|---|---|
| `src/tools/idempotency-gate.sqlite.spec.ts` | 尝试加 ⑤ → 实测红 → 回退为注释说明（保留 ①②③④ 全绿） |

未改既有断言、未 .skip、未 commit / push / stash、未动 package.json / lockfile、未改 `src/` 生产代码。
