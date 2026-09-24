/**
 * dev-schema-push — 本地开发一键建表（AI 底座私有库 + 业务库 AI 表）
 *
 * 背景：migrations/001_ai_tables.sql 始终"待归档"（历史遗留），本地开发/测试
 * 环境没有业务库 AI 表的 SQL 来源。本脚本以 TypeORM 实体为唯一真理源，
 * 用 synchronize 推导建表（含全部新列），等价于一次 schema push。
 *
 * ⚠️ 仅限本地开发/测试使用：生产禁跑（生产以 migrations/ 增量为准）。
 * 用法：node scripts/dev-schema-push.js
 * 读取根目录 .env 的 DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_DATABASE/DB_AI_DATABASE。
 *
 * 负责人: AI底座 | 创建日期: 2026-09-05
 */
require('reflect-metadata');
const fs = require('fs');
const path = require('path');
const { DataSource } = require('typeorm');

// 读取 .env（不依赖 @nestjs/config，避免拉起整个 Nest）
const env = {};
for (const line of fs
  .readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}

const { AI_ENTITIES } = require('../dist/database/database.module');
const { AI_DB_ENTITIES } = require('../dist/database/ai-db.module');

async function push(name, database, entities) {
  const ds = new DataSource({
    type: 'mysql',
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    username: env.DB_USERNAME || 'root',
    password: env.DB_PASSWORD || '',
    database,
    entities,
    synchronize: true, // 仅本地：由实体推导建表/补列
    logging: ['error'],
    charset: 'utf8mb4',
  });
  await ds.initialize();
  const tables = entities
    .map((e) => ds.getMetadata(e).tableName)
    .join(', ');
  console.log(`[${name}] 已同步 ${entities.length} 个实体 → ${database}: ${tables}`);
  await ds.destroy();
}

(async () => {
  await push('业务库AI表', env.DB_DATABASE || 'liquor_inventory', AI_ENTITIES);
  await push('ai_db', env.DB_AI_DATABASE || 'ai_db', AI_DB_ENTITIES);
  console.log('schema push 完成');
  process.exit(0);
})().catch((err) => {
  console.error('schema push 失败:', err.message);
  process.exit(1);
});
