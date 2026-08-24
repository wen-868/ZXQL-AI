/**
 * DynamicApiTool 单元测试（P0-8 功能即技能）
 *
 * 覆盖：GET 查询参数透传、路径占位符替换、POST body、失败返回
 */
import { ServiceClient } from '../../bridge/service-client';
import { DynamicApiTool } from './dynamic-api.tool';

const ctx = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  authToken: 'jwt',
};

function makeServiceClient(mock: { get?: jest.Mock; post?: jest.Mock }) {
  return {
    get: mock.get ?? jest.fn().mockResolvedValue({ list: [] }),
    post: mock.post ?? jest.fn().mockResolvedValue({ id: 1 }),
    put: jest.fn(),
    delete: jest.fn(),
  } as unknown as ServiceClient;
}

describe('DynamicApiTool', () => {
  it('GET 工具把非占位参数作为 query 透传', async () => {
    const get = jest.fn().mockResolvedValue({ list: [{ id: 1 }] });
    const tool = new DynamicApiTool(makeServiceClient({ get }), {
      name: 'api_query_products',
      description: '查询商品',
      category: 'product',
      method: 'GET',
      path: '/api/admin/products',
      parameters: { type: 'object', properties: {} },
      isWriteOperation: false,
      risk: 'low',
    });

    const result = await tool.execute({ keyword: '五粮液', page: 2 }, ctx);

    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledWith('/api/admin/products', ctx, {
      params: { keyword: '五粮液', page: 2 },
    });
  });

  it('路径占位符从入参替换', async () => {
    const get = jest.fn().mockResolvedValue({ id: 7 });
    const tool = new DynamicApiTool(makeServiceClient({ get }), {
      name: 'api_get_member',
      description: '客户详情',
      category: 'customer',
      method: 'GET',
      path: '/api/admin/members/{id}',
      parameters: { type: 'object', properties: {} },
      isWriteOperation: false,
      risk: 'low',
    });

    const result = await tool.execute({ id: 7 }, ctx);
    expect(result.success).toBe(true);
    expect(get).toHaveBeenCalledWith('/api/admin/members/7', ctx, {
      params: {},
    });
  });

  it('POST 写操作把参数作为 body', async () => {
    const post = jest.fn().mockResolvedValue({ orderNo: 'XS001' });
    const tool = new DynamicApiTool(makeServiceClient({ post }), {
      name: 'api_create_hold_order',
      description: '创建挂单',
      category: 'order',
      method: 'POST',
      path: '/api/store/hold-orders',
      parameters: { type: 'object', properties: {} },
      isWriteOperation: true,
      risk: 'medium',
    });

    const result = await tool.execute({ items: [{ skuId: 1, qty: 2 }] }, ctx);
    expect(result.success).toBe(true);
    expect(post).toHaveBeenCalledWith(
      '/api/store/hold-orders',
      { items: [{ skuId: 1, qty: 2 }] },
      ctx,
    );
  });

  it('后端调用失败时返回 success=false', async () => {
    const get = jest.fn().mockRejectedValue(new Error('网络错误'));
    const tool = new DynamicApiTool(makeServiceClient({ get }), {
      name: 'api_query_products',
      description: '查询商品',
      category: 'product',
      method: 'GET',
      path: '/api/admin/products',
      parameters: { type: 'object', properties: {} },
      isWriteOperation: false,
      risk: 'low',
    });

    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('api_query_products');
  });
});
