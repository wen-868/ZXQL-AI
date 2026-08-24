/**
 * CheckpointerService 单元测试
 *
 * 覆盖：保存/加载（内存降级路径）、JSON 序列化、清除、TTL 字段维护
 *
 * 负责人: 凌舟(AI协助) | 创建日期: 2026-08-15
 */
import { ConfigService } from '@nestjs/config';
import { CheckpointerService } from './checkpointer.service';
import { GraphState } from './graph.types';

function makeService(): CheckpointerService {
  const config = {
    get: jest.fn((key: string) => {
      const map: Record<string, string> = {
        REDIS_HOST: '127.0.0.1',
        REDIS_PORT: '1', // 无效端口，触发连接失败降级
        REDIS_DB: '1',
      };
      return map[key];
    }),
  } as unknown as ConfigService;
  // 不调用 onModuleInit：redisAvailable=false 直接走内存降级路径
  return new CheckpointerService(config);
}

function makeState(overrides: Partial<GraphState> = {}): GraphState {
  return {
    graphId: 'sale_create_graph',
    tenantId: 't1',
    sessionId: 's1',
    currentNodeId: 'search_customer',
    status: 'running',
    results: {},
    nodeOrder: [],
    history: [],
    updatedAt: 0,
    ...overrides,
  };
}

describe('CheckpointerService', () => {
  it('save 后 load 返回相同状态（JSON 序列化往返）', async () => {
    const svc = makeService();
    const state = makeState({
      results: { search_customer: { id: 1, name: '红星商行' } },
      nodeOrder: ['search_customer'],
      history: [
        { nodeId: 'search_customer', label: '搜索客户', success: true },
      ],
    });

    await svc.save(state);
    const loaded = await svc.load('t1', 's1');

    expect(loaded).toEqual(state);
    expect(loaded?.updatedAt).toBeGreaterThan(0);
  });

  it('save 更新 updatedAt 时间戳', async () => {
    const svc = makeService();
    const state = makeState({ updatedAt: 100 });
    await svc.save(state);
    expect(state.updatedAt).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('不存在的会话 load 返回 null', async () => {
    const svc = makeService();
    expect(await svc.load('t1', 'no-session')).toBeNull();
  });

  it('clear 后 load 返回 null', async () => {
    const svc = makeService();
    await svc.save(makeState());
    await svc.clear('t1', 's1');
    expect(await svc.load('t1', 's1')).toBeNull();
  });

  it('租户隔离：不同 tenantId 互不可见', async () => {
    const svc = makeService();
    await svc.save(makeState({ tenantId: 't1', sessionId: 's1' }));
    expect(await svc.load('t2', 's1')).toBeNull();
    expect(await svc.load('t1', 's1')).not.toBeNull();
  });
});
