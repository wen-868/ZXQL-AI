/**
 * 对话记忆 Key 隔离测试（批次4，文档 10.1 第 4 条）
 *
 * 运营客户端（customer）在 Redis Key 中追加 customerId，
 * 保证跨客户会话记忆不可见。
 *
 * 负责人: AI底座 | 创建日期: 2026-08-26
 */
import { buildMemoryKey } from './memory-manager.service';

describe('buildMemoryKey', () => {
  it('管理端（staff）：ai:memory:{tenantId}:{sessionId}', () => {
    expect(buildMemoryKey('t1', 'sess_1')).toBe('ai:memory:t1:sess_1');
  });

  it('运营客户端：追加 customerId 隔离', () => {
    expect(buildMemoryKey('t1', 'sess_1', 'c1')).toBe('ai:memory:t1:c1:sess_1');
  });

  it('同一会话不同客户互不可见（Key 不同）', () => {
    const k1 = buildMemoryKey('t1', 'sess_1', 'c1');
    const k2 = buildMemoryKey('t1', 'sess_1', 'c2');
    expect(k1).not.toBe(k2);
  });

  it('客户与内部员工同一会话 Key 不同', () => {
    const staff = buildMemoryKey('t1', 'sess_1');
    const customer = buildMemoryKey('t1', 'sess_1', 'c1');
    expect(staff).not.toBe(customer);
  });
});
