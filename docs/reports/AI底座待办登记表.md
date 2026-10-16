# AI 底座待办登记表

> 维护：凌舟｜更新：2026-10-16
> 用途：一张表掌握全部未完成项（已完成的各单均有收官报告，不在此重复）

---

## 一、在办（已派单，执行中）

| # | 待办 | 单号 | 执行 | 状态 |
|---|---|---|---|---|
| 1 | **办公批次 3：审批流**（单级；资源 `approval`；原子状态迁移） | R101-AI-38 | 阿坚 | ✅ **已收口**（6 工具+回传+收官报告；177/1864）|
| 1b | **办公批次 4：日程/提醒**（复用 proactive-push；resourceType=schedule） | R101-AI-39 | 阿坚 | ✅ **已收口**（5 工具+提醒服务；13 例/10 mutation；回传+收官报告；179/1877）|
| 1c | **办公批次 5：通知中心**（补"错过推送即丢"；不侵入 ProactivePushService） | R101-AI-40 | 阿坚 | 🔄 **S1/S2/S3 已收口**（`2f250b7`，181/1888）；待补 8 mutation + 回传/收官 = 办公五批终 |

## 二、待派（已登记，未开工）

| # | 待办 | 说明 | 优先级 | 依赖 |
|---|---|---|---|---|
| 2 | **`aiTodoCancel`** | 待办取消工具（批次 2 缺口：Update 拒 status 后无取消工具） | 高 | 无（可并入批次 3 或独立） |
| 2b | **草稿删除**（审批/待办同类） | AI-38 自查发现：Update 仅 draft 可改，但**无删除草稿工具** ⇒ 与 `aiTodoCancel` 同族，一并做 | 高 | 无 |
| 3 | **数字员工回写**（员工完成任务 ⇒ 待办自动 done） | 需 `t_ai_employee_task` 加 `todo_id` 或 `run()` 返回 `linkedTodoId`；**属跨域联动**，改 `src/brain/employee/*` | 中 | 需独立设计（裁定③：不在批次 2 做） |
| 4 | **向量检索分支**（`aiDocSearch` 加向量检索） | 需 **embedding 服务就绪**，否则"假绿" | 中 | embedding 配置 |
| 5 | **`aiDocAsk` 对话式问答**（"这份文档的关键条款是什么"） | 需 LLM 路径 | 中 | 与 4 同批更好 |
| 6 | **多轮/多级审批、会签** | 属产品复杂度 | 低 | 需业主确认产品形态 |
| 7 | **`ToolCategory` 加 `office`** | 现有 6 办公工具归在 `report` 桶（注释已留"一行切换"） | 低 | 无 |
| 8b | **定向提醒**（现租户级广播） | `t_push_log.user_id` 硬编码 0 + gateway 只按租户 broadcast ⇒ 需改 push 写真实 user_id + gateway 支持按用户定向 | 中 | 通知中心（AI-40）打通后一并做 |
| 8c | **日程共享/代管、重复日程（recurrence）** | 批次 4 明确不做（复杂度高） | 低 | 需产品确认 |
| 8d | **超时未提醒补偿窗口** | @Cron 停机期间的到期提醒如何补发（reminded_at 未写会重试，但停机跨天场景需确认） | 低 | 无 |
| 8 | **readiness 导出化** | `ReadinessService` 仅在 app.module 提供未导出；P1-4 时裁定"记入待办，不另开单" | 低 | 无 |

## 三、环境/运营类（非代码）

| # | 待办 | 说明 | 阻塞什么 |
|---|---|---|---|
| 9 | **触发一次生产部署（须 MS 线跑 deploy.yml）** | ✅ 机制已查实（三轮误判全部订正）：① `ai-base-deploy.sh` 默认 `AI_REPO_URL=git@github.com:wen-868/ZXQL-AI.git`、`AI_TARGET_DIR=/opt/zhixiang/ai-base`，`git fetch origin main + reset --hard FETCH_HEAD`；② **gh-ip 与 github 是同一仓库**（`ls-remote` 实测两者 `main` 同一 SHA `3b5e2ee` ⇒ 推 gh-ip 即推 github，**无需双推**；此前"origin 只有 25 工具"是本地 ref 陈旧的假象）；③ **AI 仓 push 不触发部署**——触发器是 **MS 仓** `deploy.yml`（`push: branches:[main]` + `workflow_dispatch`），经 `auto-deploy.sh → ai-base-deploy.sh`。**部署源已含全部 27 办公工具 + AI-41**（`ls-tree gh-ip/main` 实测），生产仍 96 ⇒ **只差"MS 线跑一次 deploy.yml"**。⇒ **经业主/MS 线触发**（AI 线无该 MS 仓 workflow 权限，不越权代跑）；部署后我方立即真数据实测闭环 | 全部新工具上线；真数据实测闭环 |
| 10 | **demo/测试租户基础数据** | 已由 MS 交付（12 商品）；若需更多场景数据可再提 | 真数据实测闭环 |
| 11 | **embedding 服务配置** | 生产未配置 ⇒ 向量检索无法真实验证 | 待办 4、5 |

## 四、跨线（MS / OPS）

| # | 待办 | 状态 |
|---|---|---|
| 12 | demo 租户基础数据种子 | ✅ MS 已交付 |
| 13 | 销售单取消端点 `POST /api/admin/sale-bills/:billNo/cancel` | ✅ MS 已交付（我方已集成，R101-AI-36 收官） |
| 14 | 双系统对接（OPS）· E1 身份映射 | ⏸ 未启动（数据链路 P3/P4 依赖它） |
| 15 | AI 办公审批与 MS 审批打通 | ⏸ 未启动（本批明确不做，独立议题） |

## 五、已完成（有收官报告，供索引）

| 单号 | 内容 | 门禁贡献 |
|---|---|---|
| R101-AI-30 | standalone 存储形态（方言层/双模式/内存 Redis/sqlite 基线） | 至 161/1752 |
| R101-AI-31 | 限流读写分桶（读 600 / 写 60） | |
| R101-AI-32/33 | 销售预测 + 价格走势（切 MS 真源） | |
| R101-AI-34 | 完善批次（切真源×2 + source:'ai' + getSystemStatus + 矩阵同步） | 至 171/1820 |
| R101-AI-35 | 办公批次 1：文档中心（6 工具 + ACL + RAG 贯通） | |
| R101-AI-36 | P1-3 兑现：取消销售单 | |
| R101-AI-37 | 办公批次 2：待办与任务（4 工具 + ACL 泛化） | 至 175/1844 |

## 六、门禁总览

135/1471 → **181 套件 / 1888 用例**（0 断言修改、0 `.skip`）
