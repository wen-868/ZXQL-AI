/**
 * 日程参与者（participants）存储与匹配工具 —— R101-AI-39
 *
 * ⚠️ **双形态（MySQL / sqlite）语义必须一致**，这是凌舟点名的坑：
 * - `LIKE` 在两方言下**大小写敏感性不同**（MySQL 默认 ci / sqlite 默认 cs）
 * - `LIKE '%u1%'` 会**子串误命中** `u12`
 *
 * ⇒ 本模块统一口径：
 * 1. **存储归一化**为"**首尾都带逗号**"的形式：`,user:u1,role:fin,`（去空、去重、trim）
 *    ⇒ 匹配用 `,{principal},`（两侧都有边界），**杜绝子串误配**
 * 2. principal 一律由 `principalOf()` 生成（**全小写 id**）⇒ 大小写差异在实际取值域内不产生歧义；
 *    仍在此注明：若将来允许大写 id，需显式统一大小写（`LOWER()`/`toLowerCase`）
 * 3. 库层匹配统一用 `Like('%,{principal},%')`（TypeORM `Like` 双方言可用）
 *
 * 负责人: 阿坚 | 创建日期: 2026-10-16
 */
import { Like } from 'typeorm';

/** 归一化参与者列表：去空、去重、trim，并**首尾补逗号**；空 ⇒ null */
export function normalizeParticipants(raw?: string | null): string | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const piece of raw.split(',')) {
    const p = piece.trim();
    if (p.length === 0 || seen.has(p)) continue;
    seen.add(p);
    parts.push(p);
  }
  if (parts.length === 0) return null;
  return `,${parts.join(',')},`;
}

/** 解析归一化存储 ⇒ 参与者数组（便于展示与逐行确认） */
export function parseParticipants(stored?: string | null): string[] {
  if (typeof stored !== 'string' || stored.trim().length === 0) return [];
  return stored
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 某 principal 是否在参与者串中命中（**边界匹配**）
 *
 * 例：`matchesParticipant(',user:u1,user:u12,', 'user:u1') === true`，
 *     而子串式匹配会把 `user:u12` 误判 —— 本函数用逗号边界**杜绝**该误配。
 */
export function matchesParticipant(
  stored: string | null | undefined,
  principal: string,
): boolean {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  return stored.includes(`,${principal},`);
}

/** 库层 LIKE 模式（双方言一致；配合归一化存储 ⇒ 无子串误配） */
export function participantsLike(principal: string) {
  return Like(`%,${principal},%`);
}
