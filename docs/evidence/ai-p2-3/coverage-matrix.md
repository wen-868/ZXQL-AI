# AI-P2-3 · 漏提醒补偿覆盖矩阵

> 负责人：阿洲（AI 底座 owner）｜2026-10-25
> 卡：`docs/reports/AI-P2-3-reminder-catchup-派单卡-2026-10-23.md`

## 一、体验目标达成表

| 卡内要求 | 实现 | 证据 |
|:--|:--|:--|
| 全部补回，不设"只补最近 N 条" | `collectAllDue()` 分批循环至扫尽（`LIMIT 100 OFFSET n`，非丢弃上限） | 用例① 100 条全补；①b 跨批 150 条全补；⑥ 7 天积压全补 |
| ≤3 条逐条推送 | `rows.length <= 3` ⇒ 逐条 `pushOne` | 用例④ 1 条/3 条各推 n 次 |
| >3 条聚合摘要 | `pushDigest`：总数 + 最紧急 3 条 + 引导通知中心 | 用例④b 4 条；① 100 条 |
| 每条仍独立进通知中心 | `recordOne` 逐条 `pushWithNotice`（dedupeKey 各自独立） | 用例② 5 条 5 个独立 dedupeKey；④b 4 条全入箱 |
| 22:00–08:00 不推即时 | `isQuietHours()`（Asia/Shanghai）⇒ 只入箱不推送 | 用例⑤ 安静时段 push 零调用；⑪ 边界判定 |
| 08:00 生成聚合摘要 | `collectQuietBacklog` + `pushQuietDigest` | 用例⑤b 积压 2 条生成摘要 |
| 幂等（重复扫描不重复成功） | dedupeKey = `catchup:{sourceId}:{occurrenceAt}`，落 NoticeService (tenant,dedupeKey,未读) 唯一 | 用例③ 键格式断言 |
| 渠道失败可重试 | 失败条不写 `reminded_at` ⇒ 下次扫描重试；成功渠道走 dedupe 不重发 | 用例⑦ failed 计数如实 |
| 人工与 AI 共用同一补偿器 | 同一 `t_ai_schedule` 表 + 同一 push/notice 通道，无旁路 | 用例⑭ 结构断言 |
| AI 可查漏提醒数 | `summarizeBacklog()` **只读**（SELECT only，无 UPDATE/DELETE） | 用例⑬ 零写操作断言 |
| 不假成功 | 失败如实计数，不写标记，不伪造成功 | 用例⑦/⑩ |
| 跨租户/跨用户隔离 | 每行按自身 `tenant_id` 落箱；`receiverOf` 按 owner+participants | 用例⑧ 两租户不串 |

## 二、测试矩阵覆盖（卡 §四 / §六.7）

| 维度 | 要求 | 用例 | 状态 |
|:--|:--|:--|:--|
| 条数 | 1 / 3 / 4 / 100 | ④×2、④b、① | ✅ |
| 停机时长 | 1 小时 / 跨天 / 7 天 | ⑥（7 天）+ ①（跨批） | ✅ |
| 安静时段 | 22:00–08:00 + 08:00 汇总 | ⑤、⑤b、⑪ | ✅ |
| 渠道失败恢复 | 连续失败后恢复 | ⑦ | ✅ |
| 重复扫描 | 100 次不重复成功 | ③（幂等键）+ ② | ✅ |
| recurrence | occurrence 与普通提醒 | ⑫ | ⚠️ **BLOCKED** |
| 跨租户/跨用户 | 隔离 | ⑧ | ✅ |
| AI 只读查询 | 不删原始提醒 | ⑬ | ✅ |
| 共用补偿器 | 无旁路 | ⑭ | ✅ |

## 三、BLOCKED 项（如实登记，不自造）

### recurrence occurrence —— BLOCKED

- **事实**：`src/database/entities/ai-schedule.entity.ts` **没有 recurrence 相关字段**；
  实体头注释明确写"边界（本批不做）：**重复日程（recurrence）**、日程共享/代管、外部日历同步"。
- **为什么不能做**：recurrence 属 **P2-2**（日程共享/代管 + recurrence）范围，该单仍在排队未落地。
  在本单自造 recurrence 字段会与 P2-2 撞车（同一张表两边各建一套模型 = 后续合并冲突）。
- **处置**：用例⑫ 以**结构断言**文档化该决定 —— 若未来实体真加 recurrence 列，
  该断言会红 ⇒ 强制补真用例，不会静默漏掉。
- **未冒充**：本单**没有**为 recurrence 写假数据或假用例。

## 四、结构性保证（防复发）

| 保证 | 机制 |
|:--|:--|
| 不会退回"只补最近 N 条" | `collectAllDue` 循环至取空；用例①/①b 断言总量（mutation 1 测试关闭补偿⇒13 红） |
| 不会用摘要替代通知中心 | `recordOne` 在推送分层**之前**无条件执行；用例②/④b（mutation 2 测试⇒7 红） |
| 不会丢幂等键 | 用例③ 断言完整键格式（mutation 3 测试⇒2 红） |
| 不会建 AI 旁路 | 用例⑭：只 `FROM t_ai_schedule` + 复用既有 push/notice，无新 WS/axios |
| 不会让 AI 删提醒 | 用例⑬：`summarizeBacklog` 零 UPDATE/DELETE/INSERT |
| 既有行为不倒 | 原提醒服务 5 例零改动全绿；proactive 17 套件 155 例全绿 |

## 五、未验项（如实标注）

- **真实运行态未验**：本单只有单元测试，未在真实 MySQL + 真实推送网关跑过停机场景；
  真实"停机 2 小时 → 恢复 → 商户看到补回"需生产/预发环境验证，本单不自称已通过。
- **push_log title 匹配的脆弱性**：08:00 积压判定用 `p.title = CONCAT('日程提醒：', s.title)` 匹配
  （`t_push_log` 无 `ref_id` 列）。若未来 push_log 加 source/refId 列，应改为精确匹配。
