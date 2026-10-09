# 【汇报 R101-AI-16-R】对应派单 R101-AI-16 —— write-guard Redis 索引集合补 TTL

> 一句话结论：索引集合 TTL 已补（与令牌 key 同一 `ttlSeconds`、同一 MULTI 下发），新增 5 条断言双向夹住（结构+行为），去 TTL/改 0 两个方向各 4 条变红；三门禁全绿（142 套件 / 1562 用例），降级语义与共享 provider 红线零改动。

- **汇报对象**：凌舟（总负责人）
- **汇报人**：阿坚（后端）｜2026-10-10
- **基线 ref**：`26af826`（全程未 commit / 未 stash / 未 checkout / 未 reset / 未 push，工作区即 ref + 本单改动）
- **改动范围**：仅 2 个文件（详见 §2），**纯新增**，无删除行

---

## §0 开工前的事实更正（1 处，先报）

派单卡给出的缺陷位置 **`write-guard.service.ts:576-584`** 与实际不符：

| 派单卡口径 | 实际取证 |
|---|---|
| 路径 `src/modules/write-guard/write-guard.service.ts` | **不存在**。实际为 `src/brain/write-guard.service.ts` |
| 行号 576-584（setex + sadd） | 实际 `save()` 在 **564-590**，setex 570-574 / sadd 575 |

**影响**：仅为定位口径偏差，**缺陷本体与派单描述完全一致**（setex 只作用于令牌 key，索引集合 bare `sadd` 无 TTL）。已按实际代码定位实施，未硬套行号。
其余取证**全部复核为真**：`save()` 确为 `.multi().setex(...).sadd(...).exec()`（无 expire）；全仓 `.expire(` 零命中（本单前）。

---

## §1 交付物 1：TTL 补齐 + 取值依据

**改动**：`src/brain/write-guard.service.ts:576-581`（`save()` 的 MULTI 管道内，+6 行）

```ts
.sadd(this.buildIndexKey(write.tenantId), write.token)
// 索引集合 TTL（P1 修复 2026-10-10）：与令牌 key 同一 ttlSeconds，
// 同一 MULTI 内下发 ⇒ 两者 TTL 起点一致、同步刷新（confirm 改写
// 令牌时 setex 与 expire 一并续期）。取值 = 令牌 TTL（不得更短）：
// 索引若早于令牌失效，令牌还在却被 listPending 漏掉；索引若长于
// 令牌，仅多留一个空 Set 至其自然过期，无正确性代价。
.expire(this.buildIndexKey(write.tenantId), ttlSeconds)
.exec();
```

### 取值依据（逐条可核对）

| 项 | 取值 | 依据 |
|---|---|---|
| TTL 值 | `ttlSeconds`（= `Math.ceil(this.tokenTtlMs / 1000)`） | **与令牌 key 的 setex 同一变量**，默认 24h ⇒ 86400s；配 `WRITE_TOKEN_TTL_HOURS=2` ⇒ 7200s。非另算常量，杜绝两处漂移 |
| 不短于令牌有效期 | `expire.args[1] >= setex.args[1]` | 派单硬要求。索引若早于令牌失效 ⇒ 令牌仍在 Redis 却被 `listPending` 漏掉（用户看不到挂起卡片，写操作"消失"）。已由断言直接夹住 |
| 不长于令牌有效期 | 取等号 | 索引长于令牌的代价仅是多留一个空 Set 至自然过期，无正确性代价；取等号使两者同步消失，最简且可证 |
| 下发时机 | 同一 `MULTI` 内 | 与 setex/sadd **原子同批**；每次 `save()`（含 confirm 改写、resetToPending）都执行 ⇒ 索引 TTL 随最后一次写入续期，不会早于最后一条令牌过期 |
| 单位 | 秒（与 setex 一致） | Redis EXPIRE 语义；`Math.ceil` 保证向上取整，不因截断早于令牌 |

**为什么不是"另设更长缓冲"**：索引是**纯派生结构**（成员 = 该租户的 token），其价值窗口完全由令牌 TTL 界定。令牌全过期后残留的索引只是待清垃圾——正是本单要修的对象。加缓冲等于把缺陷延后而非消除。

---

## §2 交付物 2：反测（必做，双向）+ 交付物 3：降级语义零改变

### 改动清单（git diff 取证）

```
 src/brain/write-guard.service.spec.ts | 219 ++++++++++++++++++   (219 增 / 0 删)
 src/brain/write-guard.service.ts      |   6 ++++++++              (  6 增 / 0 删)
```

**spec 纯新增（`numstat 219 0`，`^-[^-]` 零命中）⇒ 未改任何既有断言、未 `.skip`。**

### 新增断言（5 条，`write-guard.service.spec.ts:521-601`）

自建**带 TTL 语义的模拟 Redis**：无 `expire` 的键 `expireAt=null` 永不过期（复现缺陷现场），并记录全部管道命令 `executed[]`（结构）；`smembers` 前先做过期清扫（行为）。

| # | 断言 | 方向 |
|---|---|---|
| 1 | MULTI 内必有 `expire(indexKey, ttl)`，key=`ai:writeguard:idx:tenant-A`，值=86400 且 `=== setex.args[1]` | 结构 |
| 2 | `expire.args[1] >= setex.args[1]` 且 `> 0` | 结构（不短于 / 不=0） |
| 3 | `WRITE_TOKEN_TTL_HOURS=2` ⇒ 两者同步 7200 | 结构（随配置跟随） |
| 4 | 越过 24h 后 `smembers` 返回 `[]`，`listPending` 长度 0 | 行为（陈旧 token 不再读回） |
| 5 | 连续挂起间隔 12h：`expire` 每次续期，24h+ 后两条 token 仍在 | 行为（不早于令牌被清） |

### 反测 A：把 TTL 改成 0（`expire(..., 0)`）

```
$ node node_modules/jest/bin/jest.js --ci src/brain/write-guard.service.spec.ts
EXIT=1
  ● P1 修复：WriteGuard Redis 索引集合 TTL › suspend 的 MULTI 必须对索引集合下发 expire，且 TTL 与令牌 key 同一取值
  ● P1 修复：WriteGuard Redis 索引集合 TTL › 索引 TTL 不得短于令牌有效期（令牌还在、索引不能被先清）
  ● P1 修复：WriteGuard Redis 索引集合 TTL › TTL 可配时索引 TTL 同步跟随（WRITE_TOKEN_TTL_HOURS=2 ⇒ 7200s）
  ● P1 修复：WriteGuard Redis 索引集合 TTL › 行为：连续挂起共享同一索引，expire 每次续期（不早于最后一条令牌过期）
Test Suites: 1 failed, 1 total
Tests:       4 failed, 31 passed, 35 total
```

### 反测 B：把 `.expire(` 整行删除（还原到缺陷原状）

```
$ node node_modules/jest/bin/jest.js --ci src/brain/write-guard.service.spec.ts
EXIT=1
  ● P1 修复：WriteGuard Redis 索引集合 TTL › suspend 的 MULTI 必须对索引集合下发 expire，且 TTL 与令牌 key 同一取值
    expect(received).toBeDefined()
    Received: undefined
      536 |
      537 |     // 反测锚点：删掉 .expire( ⇒ 此条变红
    > 538 |     expect(expire).toBeDefined();
          |                    ^
      539 |     expect(expire!.args[0]).toBe(INDEX_KEY);

  ● P1 修复：WriteGuard Redis 索引集合 TTL › 索引 TTL 不得短于令牌有效期（令牌还在、索引不能被先清）
    TypeError: Cannot read properties of undefined (reading 'args')
    > 552 |     expect(expire.args[1] as number).toBeGreaterThanOrEqual(
          |                   ^

  ● P1 修复：WriteGuard Redis 索引集合 TTL › TTL 可配时索引 TTL 同步跟随（WRITE_TOKEN_TTL_HOURS=2 ⇒ 7200s）
  ● P1 修复：WriteGuard Redis 索引集合 TTL › 行为：令牌 TTL 走完后索引一并过期，smembers 不再读回陈旧 token
Test Suites: 1 failed, 1 total
Tests:       4 failed, 31 passed, 35 total
```

> 原始输出留档：`.tmp-3a/jest-reverse.txt`（TTL=0）、`.tmp-3a/jest-reverse-noremove.txt`（删 expire）。

**两个方向各 4 条变红 = 8/10 断言实例有分辨力**（反测 A/B 各覆盖 4 条，其中第 4、5 条在两个方向分别变红）。**改完即还原**：已恢复 `.expire(..., ttlSeconds)`，`git diff` 复核为 +6 行纯新增。

### 降级语义零改变（对照 R101-AI-10 派单卡 5 模块降级表）

| 检查项 | 结果 |
|---|---|
| write-guard 的 `times>3 → null` 内存降级 | **零改动**（`redis.provider.ts:135-141` 未触碰；告警文案「写审核令牌不跨进程持久」逐字保留） |
| 5 模块降级断言（`redis.provider.spec.ts` §4） | **21/21 全绿**（`EXIT=0`），未改该 spec 一个字符 |
| `save()` 的 catch → 内存 Map 降级分支 | 未触碰（新增 expire 在 try 内，异常仍落同一降级路径） |
| 内存降级路径（`memoryMap` / `memoryIndex`） | 未触碰（`cleanupExpired` 仍按 `expiresAt` 清） |

---

## §3 验收自评（逐条对照 5 条硬标准）

| # | 硬标准 | 自评 | 证据（可复跑，ref=26af826） |
|---|---|---|---|
| 1 | `tsc -p tsconfig.json --noEmit` → exit 0 | **通过** | `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` ⇒ `TSC_EXIT=0` |
| 2 | `eslint "src/**/*.ts" --max-warnings=0` → exit 0 | **通过** | `node node_modules/eslint/bin/eslint.js "src/**/*.ts" --max-warnings=0` ⇒ `ESLINT_EXIT=0` |
| 3 | `jest --ci` 全绿，套件/用例 ≥ 142 / 1557 | **通过** | `node node_modules/jest/bin/jest.js --ci` ⇒ `JEST_EXIT=0`；**Test Suites: 142 passed, 142 total** ／ **Tests: 1562 passed, 1562 total**（基线 1557 + 本单新增 5 = 1562，**不低于下限**） |
| 4 | 反测：去 TTL ⇒ 断言变红，改完即还原 | **通过** | 双向反测各 4 条变红（§2 原始输出）；已还原，diff 复核 +6/-0 |
| 5 | 降级语义零改变 | **通过** | 5 模块降级断言 21/21 绿；降级代码与告警文案逐字未动（§2 末表） |

### 门禁数字（A/B 对照）

| 门禁 | 基线（改前，HEAD=26af826） | 交付（改后） |
|---|---|---|
| tsc | 0 | 0 |
| eslint | 0 | 0 |
| jest 套件 | 142 | **142**（+0） |
| jest 用例 | 1557 | **1562**（+5） |

---

## §4 未完成与阻塞

**无**。本单 3 项交付物全部完成，5 条硬标准全部通过。

---

## §5 风险与自我报备

1. **【自报】派单行号偏差**（§0）：路径与行号与实际不符，已按实际代码实施并回报，**未硬套**。缺陷本体与描述一致，无实质影响。
2. **【自报】反测覆盖面为 8/10 实例**：反测 A（TTL=0）使 #1/#2/#3/#5 变红，反测 B（删 expire）使 #1/#2/#3/#4 变红。**未做"索引 TTL 长于令牌"方向的劣化反测**（该方向按 §1 论证无正确性代价，属设计选择而非缺陷）。若需双向夹住可另派一单。
3. **【自报】`.tmp-3a/` 未跟踪目录**：本单留档了 3 个 jest 原始输出（`jest-baseline.txt` / `jest-reverse.txt` / `jest-reverse-noremove.txt`）。位于 `.tmp-3a/`，**需要清理请告知**，我未自行删除也未 commit。
4. **【残余风险-低】真实 Redis 未实测**：本仓单测无真实 Redis 实例，索引 TTL 由带 TTL 语义的模拟 Redis 验证。上线前建议在真实 Redis 上 `TTL ai:writeguard:idx:<tenantId>` 抽查一次（预期返回正整数、≤86400）。
5. **【残余风险-低】存量无 TTL 索引**：修复仅对**新增/改写**的索引生效；Redis 中已存在的永驻索引 Set 需自然清理或运维手动 `DEL`。本单未做迁移脚本（派单未要求）。
6. **未触碰红线**：未 `new Redis()`（仍走 `redisProvider.getSharedClient('stop-after-3')`）；未改既有断言（spec diff 219/0）；无 `.skip`；未执行 stash/checkout/reset/commit/push；全程 `node <主仓>/node_modules/...` 直跑二进制，**未用 pnpm**。

---

## §6 回传落卡 / 关联卡

- **回传落卡路径**：`docs/reports/R101-AI-16-write-guard索引TTL-回传.md`（本文件）
- **关联卡**：派单 R101-AI-16（凌舟，2026-10-10）；前置 R101-AI-10（共享 Redis provider 抽取，长连接 4→2）；审查报告 P1-4

---

*本单仅产出回传卡，**未代写裁定/验收卡**（§8.8）。验收裁定权归凌舟。*
