/**
 * DynamicApiTool 单元测试（P0-8 功能即技能）
 *
 * 覆盖：GET 查询参数透传、路径占位符替换、POST body、失败返回、
 * 写条目执行闸（AI-P0-3-F2-DYNAMIC-WRITE-CONFIRM-GUARD-01：直接构造也零写）、
 * def 冻结快照（注册后篡改目录对象无法解除闸）、构造期元数据拒绝
 */
/* eslint-disable @typescript-eslint/no-unsafe-member-access -- 批量断言 mock 依赖 */
import { Logger } from '@nestjs/common';
import { ServiceClient } from '../../bridge/service-client';
import { DynamicApiTool, validateDynamicToolDef } from './dynamic-api.tool';
import type { ApiRouteDef } from './api-catalog';

const ctx = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  authToken: 'jwt',
};

function makeServiceClient(mock: {
  get?: jest.Mock;
  post?: jest.Mock;
  put?: jest.Mock;
  delete?: jest.Mock;
}) {
  return {
    get: mock.get ?? jest.fn().mockResolvedValue({ list: [] }),
    post: mock.post ?? jest.fn().mockResolvedValue({ id: 1 }),
    put: mock.put ?? jest.fn(),
    delete: mock.delete ?? jest.fn(),
  } as unknown as ServiceClient;
}

/** 写条目定义（可覆盖字段） */
function writeDef(over: Partial<ApiRouteDef> = {}): ApiRouteDef {
  return {
    name: 'api_create_hold_order',
    description: '创建挂单（未获准写条目）',
    category: 'order',
    method: 'POST',
    path: '/api/store/hold-orders',
    parameters: { type: 'object', properties: {} },
    isWriteOperation: true,
    risk: 'medium',
    ...over,
  };
}

describe('DynamicApiTool', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

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

  it('纯计算 POST（isWriteOperation=false）保持兼容：参数作为 body 真实调用', async () => {
    const post = jest.fn().mockResolvedValue({ discount: 15 });
    const tool = new DynamicApiTool(makeServiceClient({ post }), {
      name: 'api_calculate_promotion',
      description: '促销计算器',
      category: 'marketing',
      method: 'POST',
      path: '/api/admin/marketing/calculate',
      parameters: { type: 'object', properties: {} },
      isWriteOperation: false,
      risk: 'low',
    });

    const result = await tool.execute({ items: [{ skuId: 1, qty: 2 }] }, ctx);
    expect(result.success).toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/api/admin/marketing/calculate',
      { items: [{ skuId: 1, qty: 2 }] },
      ctx,
    );
  });

  // ══ 写条目执行闸（fail-closed：绕过生成器直接构造也零写）══

  it.each(['POST', 'PUT', 'DELETE'] as const)(
    '写条目（%s）执行拒绝：success=false、零 HTTP 请求、结构化日志含 tenant/tool/method/path/reason',
    async (method) => {
      const http = {
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn(),
      };
      const tool = new DynamicApiTool(
        makeServiceClient(http),
        writeDef({ method }),
      );
      // 元数据忠实：拒绝执行不伴随静默降级成读工具（写标记必须原样保留）
      expect(tool.isWriteOperation).toBe(true);

      const result = await tool.execute(
        { items: [{ skuId: 1, secret: 'should-not-leak' }] },
        ctx,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('fail-closed');
      // 后端请求计数 = 0（三种写方法全部零调用）
      expect(http.post).not.toHaveBeenCalled();
      expect(http.put).not.toHaveBeenCalled();
      expect(http.delete).not.toHaveBeenCalled();
      // 结构化日志：含 tenant/tool/method/path/reason
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('动态写条目已拒绝执行'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`tool=api_create_hold_order method=${method}`),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('tenant=t1'),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('path=/api/store/hold-orders'),
      );
      // 日志不泄露凭据与 body
      const logged = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).not.toContain('secret');
      expect(logged).not.toContain('should-not-leak');
      expect(logged).not.toContain('jwt');
    },
  );

  it('def 冻结快照：注册后篡改原目录对象的写标记无法解除执行闸', async () => {
    const def = writeDef();
    const post = jest.fn();
    const tool = new DynamicApiTool(makeServiceClient({ post }), def);
    // 攻击路径：注册后把目录对象的写标记抹掉
    (def as { isWriteOperation: boolean }).isWriteOperation = false;

    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('fail-closed');
    expect(post).not.toHaveBeenCalled();
  });

  it('构造期拒绝：空名称/非法方法/GET 与写标记冲突直接抛错（坏对象无可执行实例）', () => {
    const client = makeServiceClient({});
    expect(() => new DynamicApiTool(client, writeDef({ name: '  ' }))).toThrow(
      /空名称/,
    );
    expect(
      () =>
        new DynamicApiTool(
          client,
          writeDef({ method: 'PATCH' as unknown as 'POST' }),
        ),
    ).toThrow(/非法 HTTP 方法/);
    expect(
      () => new DynamicApiTool(client, writeDef({ method: 'GET' })),
    ).toThrow(/GET 方法不得标记写操作/);
  });

  it('validateDynamicToolDef：读条目放行、写条目拒绝（与构造/生成共用同一规则）', () => {
    expect(
      validateDynamicToolDef({
        name: 'api_query_demo',
        description: 'x',
        category: 'system',
        method: 'GET',
        path: '/x',
        parameters: {},
        isWriteOperation: false,
        risk: 'low',
      }).ok,
    ).toBe(true);
    const writeVerdict = validateDynamicToolDef(writeDef());
    expect(writeVerdict.ok).toBe(false);
    expect(writeVerdict.reason).toContain('fail-closed');
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
