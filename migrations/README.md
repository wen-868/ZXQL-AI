# AI 底座数据库迁移（migrations/）

> 依据：`docs/ai-base/智享AI底座-架构设计文档【唯一权威】.md` 第 7 章（数据库设计）、22.7（审计与撤销）、26（进化底座 ai_db）。
> 状态：独立仓库迁移目录已建立；`001_ai_tables.sql` 随 P1-1（ai_db 认知闭环）落地时补齐。

## 一、目录定位

- 所有建表/加列/索引变更统一放本目录，**不在业务仓库重复维护**（业务库表结构由管理系统侧维护，AI 底座只声明自身相关表）。
- 与业务库物理隔离：AI 底座私有库 `ai_db`（经验/纠错/样本/进化版本）走独立迁移段；业务侧 AI 表（审计/配置/用量等）走业务库迁移段。

## 二、文件规范

1. **命名**：`NNN_描述.sql`，`NNN` 为 3 位递增序号（001、002…），描述用中文短语，如 `002_ai_db_evolution_tables.sql`。
2. **文件头无注释**：自动迁移器按 `;` 分号拆分逐条执行，文件头若带说明性注释会被当作语句拆分，因此**禁止在 SQL 文件首行写注释**；说明统一写本 README 或独立 `*.md`。
3. **幂等**：每段建表前判断表是否存在（`CREATE TABLE IF NOT EXISTS`），加列用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（MySQL 8.0 支持）或先查 `information_schema`。
4. **对齐实体**：SQL 与 `src/database/entities/*.entity.ts` 保持一一对应，字段名/类型/索引一致。
5. **迁移文件不做版本回滚**：回滚走反向迁移文件（如 `002_revert`），不做 `DROP` 误删。

## 三、执行方式

- 本地开发：`mysql -u<user> -p<pass> <db> < migrations/001_ai_tables.sql`
- 服务器部署：`deploy/ai-base-deploy.sh` 启动前自动执行本目录未应用迁移（按 NNN 序号记录到 `schema_migrations` 表，P1-1 落地）。

## 四、表清单（规划）

| 迁移段 | 表 | 归属 | 状态 |
|---|---|---|---|
| 001 | t_ai_audit_log / t_ai_usage_daily / t_platform_ai_config / t_tenant_ai_config / t_tenant_ai_billing / t_ai_external_model | 业务库（现有实体已建，SQL 待归档） | 待补齐 |
| 001 | ai_experience / ai_correction / ai_sample / ai_evolution_version | ai_db（P1-1 独立库） | 待落地 |
| 002 | t_mcp_token（MCP 对接令牌，P0-3） | 业务库 | 待落地 |
