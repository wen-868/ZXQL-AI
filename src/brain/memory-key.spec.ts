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

  // P2 返工回归（验收意见）：编码前，staff 端传含 ':' 的 sessionId 与
  // 运营端 customerId+sessionId 可拼出完全相同的 key（跨端串记忆）
  it('碰撞封堵：staff sessionId 含 ":" 时与 customer 分区 key 不再相同（分段编码）', () => {
    const staff = buildMemoryKey('t1', 'custA:sessX');
    const customer = buildMemoryKey('t1', 'sessX', 'custA');
    expect(staff).not.toBe(customer);
    // 编码可逆性 sanity：常规 key（字母数字下划线连字符）不被改变
    expect(buildMemoryKey('t_1', 'sess_1')).toBe('ai:memory:t_1:sess_1');
    expect(buildMemoryKey('t_1', 'sess_1', 'c_1')).toBe(
      'ai:memory:t_1:c_1:sess_1',
    );
  });
});
