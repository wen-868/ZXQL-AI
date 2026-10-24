# AI-P2-3F1 · 落库与推送分离 覆盖矩阵

> 负责人：阿洲（AI 底座 owner）｜2026-10-25
> 卡：`docs/reports/AI-P2-3F1-notice-push-separation-派单卡-20261025.md`

## 一、B1~B5 驳回项的修复对照

| 驳回 | 旧实现缺陷 | F1 修复 | 用例 |
|:--|:--|:--|:--|
| **B1** quiet 仍逐条推 | `recordOne` 走 `pushWithNotice`（内部无条件 push） | 落库改走 **`recordNoticeOnly`**（不触发 push）；推送由分层逻辑单独执行 | ① quiet 5 条 ⇒ notice 5 / **push 0**；⑬ quiet 下 8 条(>3) 仍 push 0 |
| **B2** >3 实际 N+1 | 同上，每条先推一次，再补摘要 | >3 时**只调一次** `pushDigest`，不逐条推 | ② 5 条 ⇒ notice 5 / **push 1** |
| **B3** 通知失败被掩盖 | `pushWithNotice` 只返回 push 结果，忽略 record 的 error | `recordNotice` 检查 `inserted/deduped`；未成功 ⇒ **记 failed、不写 reminded_at**、不参与推送分层 | ③ 通知失败 ⇒ 0 次 reminded_at UPDATE、push 0 |
| **B4** title 匹配不可靠 | `push_log.title` 匹配 + 摘要无幂等 | 身份改 `(tenant, scheduleId, occurrenceAt)`；摘要用 `batch_key` 稳定指纹 + `t_ai_reminder_digest_sent` 幂等表 | ⑤ 同名不同 id 4 条各自独立；⑥ 100 次只推 1 次 |
| **B5** 测试保真不足 | 拆分 mock，bridge 与 push 互不相干 | **真实 `NoticeBridgeService` 实例** + mock notice.record + mock push ⇒ 真实调用链 | 全部用例（harness 即为真实 bridge） |

## 二、硬验收对照（卡 §三）

| # | 判据 | 结果 | 依据 |
|:--|:--|:--|:--|
| 1 | 安静时段 push 严格 0 | ✅ | ①（5 条 ⇒ push 0）、⑬（8 条 >3 仍 push 0） |
| 2 | >3 时 push 严格 1，N 条通知独立落库 | ✅ | ②（notice 5 / push 1）、⑦（100 条 notice 100 / push 1） |
| 3 | 通知失败不写完成标记、下轮重试、push 不能掩盖 | ✅ | ③（reminded_at UPDATE 0 次；push 0 次） |
| 4 | 通知成功 push 失败 ⇒ 通知保留、push 可重试、通知不重复 | ✅ | ④（notice 只 1 次；push 两轮各 1 次） |
| 5 | 08:00 摘要按 tenant+scheduleId+occurrenceAt 精确；同名不同 id 不误判；连续 cron 只发一次 | ✅ | ⑤（4 同名不同 id 各自独立）、⑥（100 次只 1 次） |
| 6 | 真实 bridge 组合测试；原用例失真 mock 已修 | ✅ | harness 用真实 NoticeBridgeService；⑱ 结构断言禁止代码出现 pushWithNotice |
| 7 | 基线 1999 不减；tsc×2、build、ESLint 全绿 | ✅ | **189 套件 / 2001 用例**（+2）；四项门禁 EXIT=0 |
| 8 | 工作树 clean、未 push、未开 PR、逐文件 add | ✅ | 见回传卡 |

## 三、投递状态模型（B3 的正面解法）

新增 AI 域两表（**未改 MS 的 `t_push_log`**，遵守红线）：

### `t_ai_reminder_delivery`（单条维度）

| 列 | 说明 |
|:--|:--|
| tenant_id / schedule_id / occurrence_at / kind | **身份 = 四元组**（kind ∈ notice/push） |
| status | success / failed |
| dedupe_key | `tenant:scheduleId:occurrenceAt:kind` |
| attempts | 重试次数 |

唯一键 `(tenant_id, schedule_id, occurrence_at, kind)` ⇒ 同条同维度只成功一次。

### `t_ai_reminder_digest_sent`（批次维度）

| 列 | 说明 |
|:--|:--|
| tenant_id / batch_key | batch_key = 排序后 `scheduleId@occurrenceAt` 的稳定哈希 |
| sent_at | 成功发送时间 |

唯一键 `(tenant_id, batch_key)` ⇒ 同一批摘要只发一次（⑥ 的承重）。

## 四、结构性保证（防复发）

| 保证 | 机制 | 用例 |
|:--|:--|:--|
| 补偿器不得再用"落库+推送"组合器 | 代码里**禁止**出现 `pushWithNotice`（注释除外） | ⑱ |
| 分页不会无限重复 | 游标分页（remind_at + id 严格递增），替代 OFFSET | ⑦（100 条一次扫尽） |
| push 失败可重试 | 入选条件含"push 未 success" | ④、⑭ |
| 通知与推送互不掩盖 | 分两阶段执行，notice 结果先定 | ③、④ |
| 无自建通道 | 只依赖 ProactivePushService / NoticeBridgeService | ⑰ |

## 五、M1 专项说明（最重要的证据）

把实现改回旧语义（`recordNoticeOnly` → `pushWithNotice`）后：

```text
Tests: 14 failed, 6 passed, 20 total
点名: ① quiet 5 条 notice 5 / push 0 ｜ ② >3 条 notice 5 / push 1 ｜
      ②b ≤3 逐条 ｜ ②c 1 条 ｜ ④ 通知成功 push 失败
```

⇒ **旧缺陷现在能被测试抓住**（P2-3 当时是 13/13 全绿的假绿）。

## 六、未验项（如实标注）

- **真实运行态未验**：仍只有单元测试，未在真实 MySQL + 真实推送网关跑停机场景。
  "停机 2 小时 → 恢复 → 商户看到补回且不轰炸"需生产/预发验证，本单不自称已通过。
- **迁移未在真实库执行**：`migrations/024` 只写入文件并做语法自检，未在业务库/生产库执行
  （按仓规范须由部署链路跑，且本单红线不触碰生产）。
- **recurrence 继续 BLOCKED**：`ai-schedule.entity.ts` 无该字段，属 P2-2 范围。
